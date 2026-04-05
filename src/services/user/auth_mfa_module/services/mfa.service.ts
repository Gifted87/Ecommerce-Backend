import { authenticator } from 'otplib';
import { toDataURL } from 'qrcode';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Logger } from 'pino';
import * as crypto from 'crypto';
import { SecurityService, EncryptedData } from '../utils/security.service';
import { MfaSecret, MfaStatus } from '../types';

/**
 * MfaService handles the lifecycle of TOTP-based Multi-Factor Authentication.
 * Integrates with SecurityService for encryption, Redis for atomic state management,
 * and PostgreSQL for persistent storage.
 */
export class MfaService {
  constructor(
    private readonly redis: Redis,
    private readonly db: Pool,
    private readonly securityService: SecurityService,
    private readonly logger: Logger
  ) {
    // Configure otplib with standard RFC 6238 settings
    authenticator.options = {
      window: 1, // Allow 30s clock skew
      step: 30,
    };
  }

  /**
   * Generates a new TOTP secret for a user and encrypts it.
   * 
   * @param userId - Unique identifier of the user.
   * @returns Promise<MfaSecret> - Encrypted MFA secret record.
   */
  async generateSecret(userId: string): Promise<MfaSecret> {
    const rawSecret = authenticator.generateSecret();
    const encrypted = this.securityService.encryptData(rawSecret);

    const mfaSecret: MfaSecret = {
      mfa_id: crypto.randomUUID(),
      user_id: userId,
      mfa_secret: JSON.stringify(encrypted),
      mfa_method: 'TOTP',
      recovery_codes: [],
      is_enabled: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return mfaSecret;
  }

  /**
   * Generates a data URI for a QR code compliant with authenticator apps.
   * 
   * @param secret - The raw TOTP secret.
   * @param email - The user's email for label identification.
   * @returns Promise<string> - The QR code data URI.
   */
  async createQrCode(secret: string, email: string): Promise<string> {
    const otpAuthUrl = authenticator.keyuri(email, 'EcommerceApp', secret);
    try {
      return await toDataURL(otpAuthUrl);
    } catch (error) {
      this.logger.error({ error }, 'Failed to generate QR code');
      throw new Error('MFA_QR_GEN_FAILED');
    }
  }

  /**
   * Validates a provided TOTP token against the stored secret.
   * Uses Redis for atomic state transitions (PENDING -> VERIFIED).
   * 
   * @param userId - The user attempting verification.
   * @param token - The 6-digit TOTP token.
   * @returns Promise<boolean> - True if valid, false otherwise.
   */
  async verifyToken(userId: string, token: string): Promise<boolean> {
    const correlationId = crypto.randomUUID();
    const stateKey = `mfa:pending:${userId}`;

    try {
      // 1. Atomic Check and Lock
      const lockAcquired = await this.redis.set(stateKey, MfaStatus.PENDING, 'NX', 'EX', 300);
      if (!lockAcquired) {
        this.logger.warn({ userId, correlationId }, 'MFA verification attempt while locked or already in progress.');
        return false;
      }

      // 2. Retrieve and Decrypt Secret from PostgreSQL
      const encryptedDataRaw = await this.fetchEncryptedSecretFromDb(userId);
      const encryptedData: EncryptedData = JSON.parse(encryptedDataRaw);
      const secret = this.securityService.decryptData(encryptedData);

      // 3. Validate Token
      const isValid = authenticator.check(token, secret);

      if (isValid) {
        await this.redis.set(stateKey, MfaStatus.VERIFIED, 'EX', 300);
        return true;
      } else {
        await this.redis.del(stateKey);
        this.logger.info({ userId, correlationId }, 'MFA validation failed.');
        return false;
      }
    } catch (error) {
      await this.redis.del(stateKey);
      this.logger.error({ userId, correlationId, error }, 'MFA verification process encountered a critical error.');
      throw new Error('INTERNAL_SERVER_ERROR');
    }
  }

  /**
   * Database retrieval logic for the encrypted secret.
   * 
   * @param userId - The user ID to fetch the secret for.
   * @returns Promise<string> - The encrypted secret string stored in JSON format.
   * @throws Error if secret not found or DB query fails.
   */
  private async fetchEncryptedSecretFromDb(userId: string): Promise<string> {
    const query = 'SELECT mfa_secret FROM users WHERE user_id = $1 AND mfa_secret IS NOT NULL';
    try {
      const result = await this.db.query(query, [userId]);
      if (result.rows.length === 0) {
        throw new Error('MFA_SECRET_NOT_FOUND');
      }
      return result.rows[0].mfa_secret;
    } catch (error) {
      this.logger.error({ userId, error }, 'Database error during MFA secret retrieval');
      throw new Error('DB_QUERY_FAILED');
    }
  }
}
