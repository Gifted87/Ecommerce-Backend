const crypto = require('crypto');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');

class SecurityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

class EncryptionError extends SecurityError {
  constructor(message) {
    super(message, 'ERR_ENCRYPTION');
  }
}

class DecryptionError extends SecurityError {
  constructor(message) {
    super(message, 'ERR_DECRYPTION');
  }
}

class ValidationError extends SecurityError {
  constructor(message) {
    super(message, 'ERR_VALIDATION');
  }
}

class AuthenticationError extends SecurityError {
  constructor(message) {
    super(message, 'ERR_AUTHENTICATION');
  }
}

class SecurityEngine {
  constructor(encryptionKey, privateKey, publicKey) {
    if (!encryptionKey || encryptionKey.length !== 32) {
      throw new ValidationError('Encryption key must be a 32-byte buffer or 32-character string');
    }
    this.encryptionKey = Buffer.from(encryptionKey);
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.algorithm = 'aes-256-gcm';
  }

  /**
   * Password Hashing (Argon2id)
   */
  async hashPassword(password) {
    try {
      return await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 64 * 1024,
        parallelism: 4,
        timeCost: 3,
      });
    } catch (err) {
      throw new ValidationError('Failed to hash password');
    }
  }

  async verifyPassword(hash, password) {
    try {
      return await argon2.verify(hash, password, {
        type: argon2.argon2id,
      });
    } catch (err) {
      throw new AuthenticationError('Password verification failed');
    }
  }

  /**
   * Data Encryption (AES-256-GCM)
   */
  encrypt(text) {
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      
      return Buffer.concat([iv, tag, encrypted]).toString('base64');
    } catch (err) {
      throw new EncryptionError('Encryption failed');
    }
  }

  decrypt(encryptedData) {
    try {
      const buffer = Buffer.from(encryptedData, 'base64');
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const ciphertext = buffer.subarray(28);

      const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (err) {
      throw new DecryptionError('Decryption failed: Invalid tag or data corruption');
    }
  }

  /**
   * Identity Management (JWT / RS256)
   */
  generateToken(payload, expiresIn = '15m') {
    try {
      return jwt.sign(payload, this.privateKey, {
        algorithm: 'RS256',
        expiresIn: expiresIn,
      });
    } catch (err) {
      throw new AuthenticationError('Failed to sign token');
    }
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
      });
    } catch (err) {
      throw new AuthenticationError('Invalid or expired token');
    }
  }
}

module.exports = {
  SecurityEngine,
  SecurityError,
  EncryptionError,
  DecryptionError,
  ValidationError,
  AuthenticationError
};
