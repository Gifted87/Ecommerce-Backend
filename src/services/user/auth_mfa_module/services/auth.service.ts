import { Pool } from 'pg';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { SecurityService } from '../security/security.service';
import { AuthSession, MfaStatus, TokenPayload } from '../types';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Custom exceptions for authentication workflow.
 */
export class AuthError extends Error {
  constructor(public message: string, public statusCode: number = 401) {
    super(message);
  }
}

/**
 * @class AuthService
 * @description Orchestrates identity verification, MFA transitions, and session management.
 */
export class AuthService {
  private readonly jwtSecret: string;
  private readonly jwtExpiration = '15m';

  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly securityService: SecurityService
  ) {
    this.jwtSecret = process.env.JWT_SECRET || 'fallback_secret_must_be_configured_in_production';
  }

  /**
   * Verifies user credentials using Argon2id.
   * Implements rate limiting protection.
   */
  async verifyCredentials(email: string, password: string, ipAddress: string): Promise<string> {
    const correlationId = uuidv4();
    logger.info({ correlationId, event: 'CREDENTIAL_VERIFICATION_START' });

    // Rate limiting check
    await this.checkRateLimit(email, ipAddress);

    const client = await this.db.connect();
    try {
      const { rows } = await client.query(
        'SELECT user_id, password_hash FROM users WHERE email = $1 LIMIT 1',
        [email.toLowerCase()]
      );

      if (rows.length === 0) {
        throw new AuthError('Invalid credentials', 401);
      }

      const user = rows[0];
      const isMatch = await this.securityService.verifyPassword(password, user.password_hash);

      if (!isMatch) {
        throw new AuthError('Invalid credentials', 401);
      }

      logger.info({ correlationId, event: 'CREDENTIAL_VERIFICATION_SUCCESS', userId: user.user_id });
      return user.user_id;
    } finally {
      client.release();
    }
  }

  /**
   * Orchestrates the login process.
   */
  async login(userId: string, ipAddress: string, userAgent: string) {
    const correlationId = uuidv4();
    logger.info({ correlationId, event: 'LOGIN_ORCHESTRATION_START', userId });

    const client = await this.db.connect();
    try {
      const { rows } = await client.query(
        'SELECT mfa_secret, is_verified FROM users WHERE user_id = $1',
        [userId]
      );
      const user = rows[0];

      // Logic: If mfa_secret exists and user is enabled, MFA is required
      const mfaEnabled = user.mfa_secret !== null;
      
      if (mfaEnabled) {
        const sessionId = await this.createSession(userId, MfaStatus.PENDING, ipAddress, userAgent);
        logger.info({ correlationId, event: 'MFA_REQUIRED', userId });
        return { mfaRequired: true, sessionId };
      }

      const token = await this.generateToken(userId, false);
      logger.info({ correlationId, event: 'LOGIN_SUCCESS', userId });
      return { mfaRequired: false, token };
    } finally {
      client.release();
    }
  }

  private async createSession(userId: string, mfaStatus: MfaStatus, ip: string, ua: string): Promise<string> {
    const sessionId = uuidv4();
    const session: AuthSession = {
      session_id: sessionId,
      user_id: userId,
      mfa_status: mfaStatus,
      created_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      ip_address: ip,
      user_agent: ua
    };

    await this.redis.set(`session:${sessionId}`, JSON.stringify(session), 'EX', 900); // 15 mins
    return sessionId;
  }

  private async generateToken(userId: string, mfaVerified: boolean): Promise<string> {
    const payload: TokenPayload = {
      sub: userId,
      email: '', // Fetched from DB if needed for token
      roles: ['user'],
      mfa_verified: mfaVerified,
      exp: Math.floor(Date.now() / 1000) + 900,
      jti: uuidv4(),
      sid: uuidv4()
    };
    return jwt.sign(payload, this.jwtSecret);
  }

  private async checkRateLimit(email: string, ip: string): Promise<void> {
    const now = Date.now();
    const userKey = `rate_limit:user:${email}`;
    const ipKey = `rate_limit:ip:${ip}`;

    const multi = this.redis.multi();
    multi.incr(userKey);
    multi.pexpire(userKey, 60000);
    multi.incr(ipKey);
    multi.pexpire(ipKey, 60000);

    const results = await multi.exec();
    if (!results) throw new AuthError('Rate limit processing error', 500);

    const [uCount, , iCount] = results.map(r => r[1] as number);

    if (uCount > 5 || iCount > 20) {
      throw new AuthError('Too many attempts. Please try again later.', 429);
    }
  }
}
