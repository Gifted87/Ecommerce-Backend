import { Pool } from 'pg';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { SecurityService } from '../../../../shared/security/security.service';
import { AuthSession, MfaStatus, TokenPayload } from '../types';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Custom exceptions for authentication workflow.
 * 
 * Includes a status code for direct mapping to HTTP responses in controllers.
 */
export class AuthError extends Error {
  /**
   * @param message - The human-readable error message.
   * @param statusCode - The HTTP status code appropriate for this error (e.g., 401, 429).
   */
  constructor(public message: string, public statusCode: number = 401) {
    super(message);
  }
}

/**
 * AuthService orchestrates identity verification, MFA transitions, and session management.
 * 
 * It manages the entire authentication lifecycle, from initial credential
 * verification against Argon2id hashes, through MFA challenge orchestration,
 * to JWT issuance and token rotation. It also implements crucial security
 * protections like rate limiting and session tracking in Redis.
 */
export class AuthService {
  private readonly jwtSecret: string;
  private readonly jwtExpiration = '15m';

  /**
   * @param db - PostgreSQL connection pool for user data persistence.
   * @param redis - ioredis client for session storage and rate limiting.
   * @param securityService - Service for hashing and verifying credentials.
   */
  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly securityService: SecurityService
  ) {
    this.jwtSecret = process.env.JWT_SECRET || 'fallback_secret_must_be_configured_in_production';
  }

  /**
   * Verifies user credentials against the password hash in the database.
   * 
   * Protects against brute-force and credential-stuffing attacks by 
   * enforcing rate limits per email and IP address.
   * 
   * @param email - The user's registered email address.
   * @param password - The raw password provided for verification.
   * @param ipAddress - The client's IP address (used for rate limiting).
   * @returns A promise resolving to the unique user_id if credentials are valid.
   * @throws AuthError (401) if credentials fail or (429) if rate limits are exceeded.
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
   * Orchestrates the primary login process after credentials have been verified.
   * 
   * Checks for MFA requirements and either issues a full JWT token or creates
   * a temporary session requiring an MFA challenge completion.
   * 
   * @param userId - The ID of the authenticated user.
   * @param ipAddress - The client's current IP address.
   * @param userAgent - The client's browser/system identifier.
   * @returns An object indicating if MFA is required and providing either a token or sessionId.
   */
  async login(userId: string, ipAddress: string, userAgent: string) {
    const correlationId = uuidv4();
    logger.info({ correlationId, event: 'LOGIN_ORCHESTRATION_START', userId });

    const client = await this.db.connect();
    try {
      const { rows } = await client.query(
        'SELECT email, mfa_secret, is_verified FROM users WHERE user_id = $1',
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

      const token = await this.generateToken(userId, user.email, false);
      logger.info({ correlationId, event: 'LOGIN_SUCCESS', userId });
      return { mfaRequired: false, token };
    } finally {
      client.release();
    }
  }

  /**
   * Rotates an active session token to extend its lifespan.
   * 
   * Verifies the signature and expiration of the provided token before 
   * issuing a fresh JWT.
   * 
   * @param refreshToken - The currently valid JWT to be rotated.
   * @returns A promise resolving to an object containing the new token.
   * @throws AuthError if the token is invalid or the user no longer exists.
   */
  async refreshSession(refreshToken: string) {
    const correlationId = uuidv4();
    logger.info({ correlationId, event: 'REFRESH_SESSION_START' });

    try {
      const decoded = jwt.verify(refreshToken, this.jwtSecret) as TokenPayload;
      const userId = decoded.sub;

      const { rows } = await this.db.query(
        'SELECT email FROM users WHERE user_id = $1',
        [userId]
      );

      if (rows.length === 0) throw new AuthError('User not found', 404);

      const newToken = await this.generateToken(userId, rows[0].email, decoded.mfa_verified);
      return { token: newToken };
    } catch (error) {
      logger.error({ correlationId, error, event: 'REFRESH_SESSION_FAILED' });
      throw new AuthError('Invalid refresh token');
    }
  }

  /**
   * Creates a temporary session record in Redis to track MFA state.
   * 
   * @param userId - The ID of the user undergoing MFA.
   * @param mfaStatus - The current status of the MFA challenge (e.g., PENDING).
   * @param ip - Client IP.
   * @param ua - Client User Agent.
   * @returns The generated sessionId.
   * @private
   */
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

  /**
   * Generates a signed JWT for the authenticated user.
   * 
   * @param userId - User's unique identifier.
   * @param email - User's email (for payload).
   * @param mfaVerified - Whether the user has completed MFA for this session.
   * @returns A signed JWT string.
   * @private
   */
  private async generateToken(userId: string, email: string, mfaVerified: boolean): Promise<string> {
    const payload: TokenPayload = {
      sub: userId,
      email: email,
      roles: ['user'],
      mfa_verified: mfaVerified,
      exp: Math.floor(Date.now() / 1000) + 900,
      jti: uuidv4(),
      sid: uuidv4()
    };
    return jwt.sign(payload, this.jwtSecret);
  }

  /**
   * Checks and increments rate limit counters in Redis.
   * 
   * Limits attempts by both email (account-based) and IP (source-based).
   * 
   * @param email - Account identifier to rate limit.
   * @param ip - Client source identifier to rate limit.
   * @throws AuthError (429) if limits are exceeded.
   * @private
   */
  private async checkRateLimit(email: string, ip: string): Promise<void> {
    const userKey = `rate_limit:user:${email}`;
    const ipKey = `rate_limit:ip:${ip}`;

    const multi = this.redis.multi();
    multi.incr(userKey);
    multi.pexpire(userKey, 60000);
    multi.incr(ipKey);
    multi.pexpire(ipKey, 60000);

    const results = await multi.exec();
    if (!results) throw new AuthError('Rate limit processing error', 500);

    const uCount = results[0][1] as number;
    const iCount = results[2][1] as number;

    if (uCount > 5 || iCount > 20) {
      throw new AuthError('Too many attempts. Please try again later.', 429);
    }
  }
}
