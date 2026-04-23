import { generateSecret, verify, generateURI } from 'otplib';
import { toDataURL } from 'qrcode';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Logger } from 'pino';
import * as crypto from 'crypto';
import { SecurityService, EncryptedData } from '../../../../shared/security/security.service';
import { MfaSecret, MfaStatus } from '../types';

/**
 * MfaService handles the lifecycle of TOTP-based Multi-Factor Authentication.
 * 
 * It manages the generation of TOTP secrets, creation of QR codes for user enrollment,
 * and the secure verification of TOTP tokens using a combination of Redis for
 * session state and PostgreSQL for persistent encrypted secret storage.
 * 
 * Integrates with SecurityService for data encryption and decryption to ensure
 * secrets are never stored in plain text.
 */
export class MfaService {
  /**
   * @param redis - The ioredis client for managing transient MFA states.
   * @param db - The PostgreSQL connection pool for persisting MFA secrets.
   * @param securityService - Service providing encryption/decryption utilities.
   * @param logger - The application's pino logger instance.
   */
  constructor(
    private readonly redis: Redis,
    private readonly db: Pool,
    private readonly securityService: SecurityService,
    private readonly logger: Logger
  ) {
  }

  /**
   * Generates a new TOTP secret for a user and encrypts it before return.
   * 
   * This is the first step in the MFA enrollment process. The returned secret
   * is wrapped in a MfaSecret object, ready for further processing or storage.
   * 
   * @param userId - Unique identifier of the user enrolling in MFA.
   * @returns A promise that resolves to an encrypted MfaSecret record.
   */
  async generateSecret(userId: string): Promise<MfaSecret> {
    const rawSecret = generateSecret();
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
   * Generates a data URI for a QR code compliant with standard authenticator apps.
   * 
   * The QR code encodes an 'otpauth://' URL containing the service name,
   * the user's identifier, and the raw (decrypted) secret.
   * 
   * @param secret - The raw TOTP secret (plain text).
   * @param email - The user's email address, used as a label in the authenticator app.
   * @returns A promise that resolves to the base64-encoded QR code data URI.
   * @throws Error if QR code generation fails.
   */
  async createQrCode(secret: string, email: string): Promise<string> {
    const otpAuthUrl = generateURI({ label: email, issuer: 'EcommerceApp', secret });
    try {
      return await toDataURL(otpAuthUrl);
    } catch (error) {
      this.logger.error({ error }, 'Failed to generate QR code');
      throw new Error('MFA_QR_GEN_FAILED');
    }
  }

  /**
   * Validates a provided TOTP token against the stored secret for a given user.
   * 
   * This method performs several critical steps:
   * 1. Uses Redis to implement an atomic lock/check to prevent race conditions or replay attacks.
   * 2. Retrieves the encrypted secret from PostgreSQL.
   * 3. Decrypts the secret using SecurityService.
   * 4. Uses `otplib` to verify the 6-digit token against the secret.
   * 
   * @param userId - The user ID attempting token verification.
   * @param token - The 6-digit TOTP token provided by the user.
   * @returns A promise that resolves to true if the token is valid, false otherwise.
   * @throws Error if an internal error occurs during the verification process.
   */
  async verifyToken(userId: string, token: string): Promise<boolean> {
    const correlationId = crypto.randomUUID();
    const stateKey = `mfa:pending:${userId}`;

    try {
      // 1. Atomic Check and Lock
      const lockAcquired = await this.redis.set(stateKey, MfaStatus.PENDING, 'EX', 300, 'NX');
      if (!lockAcquired) {
        this.logger.warn({ userId, correlationId }, 'MFA verification attempt while locked or already in progress.');
        return false;
      }

      // 2. Retrieve and Decrypt Secret from PostgreSQL
      const encryptedDataRaw = await this.fetchEncryptedSecretFromDb(userId);
      const encryptedData: EncryptedData = JSON.parse(encryptedDataRaw);
      const secret = this.securityService.decryptData(encryptedData);

      // 3. Validate Token
      const isValid = await verify({ token, secret });

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
   * Disables MFA for a user.
   * @param userId - Unique identifier of the user.
   * @throws Error if the update fails.
   */
  async disableMfa(userId: string): Promise<void> {
    const query = 'UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE user_id = $1';
    try {
      const result = await this.db.query(query, [userId]);
      if (result.rowCount === 0) {
        throw new Error('USER_NOT_FOUND');
      }
      this.logger.info({ userId }, 'MFA disabled successfully');
    } catch (error) {
      this.logger.error({ userId, error }, 'Database error during MFA deactivation');
      throw new Error('DB_QUERY_FAILED');
    }
  }

  /**
   * Internal helper to retrieve the encrypted MFA secret from the database.
   * 
   * @param userId - The user ID to fetch the secret for.
   * @returns A promise that resolves to the encrypted secret JSON string.
   * @throws Error if the secret is not found or a database error occurs.
   * @private
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

  /**
   * Health check utility connecting to DB and Redis
   */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.redis.ping();
      await this.db.query('SELECT 1');
      return true;
    } catch (e) {
      this.logger.error({ error: e }, 'MFA Service Infrastructure health check failed');
      return false;
    }
  }
}
