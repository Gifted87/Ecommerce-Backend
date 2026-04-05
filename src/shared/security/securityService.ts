import * as argon2 from 'argon2';
import * as crypto from 'crypto';

/**
 * @interface EncryptedData
 * @description Structure representing the output of AES-256-GCM encryption.
 */
export interface EncryptedData {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * @class SecurityService
 * @description Provides high-security password hashing using Argon2id and
 *              data-at-rest encryption using AES-256-GCM.
 */
export class SecurityService {
  private readonly masterKey: Buffer;
  private readonly pepper: string;

  /**
   * @constructor
   * @param masterKey - 32-byte master encryption key.
   * @param pepper - Application-level pepper string for password hashing.
   */
  constructor(masterKey: string, pepper: string) {
    if (!masterKey || masterKey.length < 32) {
      throw new Error('SecurityService: A valid 32-byte master key is required.');
    }
    if (!pepper || pepper.length < 16) {
      throw new Error('SecurityService: A valid pepper string is required.');
    }

    this.masterKey = Buffer.from(masterKey, 'utf8').subarray(0, 32);
    this.pepper = pepper;
  }

  /**
   * Hashes a password using Argon2id.
   * @param password - The raw password string.
   * @returns A promise resolving to the hashed password string.
   */
  async hashPassword(password: string): Promise<string> {
    if (!password) {
      throw new Error('SecurityService: Password cannot be empty.');
    }

    // Argon2id parameters tuned for approx 500ms on production-grade hardware.
    // memoryCost: 64MB, timeCost: 3, parallelism: 1
    return await argon2.hash(password + this.pepper, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
  }

  /**
   * Verifies a password against an Argon2id hash.
   * @param password - The raw password string.
   * @param hash - The previously hashed password string.
   * @returns A promise resolving to true if valid, false otherwise.
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (!password || !hash) {
      return false;
    }

    try {
      return await argon2.verify(hash, password + this.pepper);
    } catch (error) {
      // Log failed verification attempt without revealing sensitive details.
      console.error('SecurityService: Password verification error.');
      return false;
    }
  }

  /**
   * Encrypts sensitive data using AES-256-GCM.
   * @param data - The plaintext string to encrypt.
   * @returns The ciphertext, IV, and auth tag.
   */
  encryptData(data: string): EncryptedData {
    if (!data) {
      throw new Error('SecurityService: Cannot encrypt empty data.');
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);

    let ciphertext = cipher.update(data, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return {
      ciphertext,
      iv: iv.toString('hex'),
      authTag,
    };
  }

  /**
   * Decrypts sensitive data using AES-256-GCM.
   * @param encrypted - The encrypted data object.
   * @returns The original plaintext string.
   * @throws Error if authentication fails (tampering detected).
   */
  decryptData(encrypted: EncryptedData): string {
    if (!encrypted.ciphertext || !encrypted.iv || !encrypted.authTag) {
      throw new Error('SecurityService: Invalid encrypted data structure.');
    }

    try {
      const iv = Buffer.from(encrypted.iv, 'hex');
      const authTag = Buffer.from(encrypted.authTag, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
      decipher.setAuthTag(authTag);

      let plaintext = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
      plaintext += decipher.final('utf8');

      return plaintext;
    } catch (error) {
      // Tampering detection or invalid key results in decryption failure.
      console.error('SecurityService: Decryption failed (potential tampering).');
      throw new Error('SecurityService: Decryption error: integrity verification failed.');
    }
  }
}
