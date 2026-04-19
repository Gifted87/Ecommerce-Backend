"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityService = void 0;
const argon2 = __importStar(require("argon2"));
const crypto = __importStar(require("crypto"));
/**
 * SecurityService provides cryptographic primitives for the application.
 *
 * It handles high-security password hashing using Argon2id (resistant to GPU/ASIC
 * cracking) and data-at-rest encryption using AES-256-GCM (providing both
 * confidentiality and integrity).
 *
 * Security Features:
 * - Argon2id for password hashing with configurable memory and time costs.
 * - AES-256-GCM for authenticated encryption of sensitive user data.
 * - Application-level 'pepper' for an additional layer of password security.
 * - Strict master key requirements (minimum 32-byte length).
 */
class SecurityService {
    /**
     * Initializes the security service with a master key and a password pepper.
     *
     * @param masterKey - A 32-byte (256-bit) master encryption key.
     * @param pepper - An application-wide secret string appended to passwords before hashing.
     * @throws Error if the masterKey or pepper do not meet security requirements.
     */
    constructor(masterKey, pepper) {
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
     * Hashes a password string using the Argon2id algorithm.
     *
     * The hashing process includes the application-level pepper and uses
     * parameters optimized for modern production hardware to balance
     * security and performance (approx 500ms per hash).
     *
     * @param password - The raw, plain-text password to hash.
     * @returns A promise that resolves to the Argon2id hash string.
     * @throws Error if the provided password is empty.
     */
    async hashPassword(password) {
        if (!password) {
            throw new Error('SecurityService: Password cannot be empty.');
        }
        // Argon2id parameters: memoryCost: 64MB, timeCost: 3, parallelism: 1
        return await argon2.hash(password + this.pepper, {
            type: argon2.argon2id,
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 1,
        });
    }
    /**
     * Verifies a raw password against an existing Argon2id hash.
     *
     * This method is resistant to timing attacks and properly handles the
     * application-level pepper.
     *
     * @param password - The raw password string to verify.
     * @param hash - The stored Argon2id hash to verify against.
     * @returns A promise resolving to true if the password is valid, false otherwise.
     */
    async verifyPassword(password, hash) {
        if (!password || !hash) {
            return false;
        }
        try {
            return await argon2.verify(hash, password + this.pepper);
        }
        catch (error) {
            // Failed verification attempts are logged generically to prevent info leaks.
            return false;
        }
    }
    /**
     * Encrypts a plaintext string using AES-256-GCM.
     *
     * Generates a unique 12-byte IV for every encryption operation and
     * produces an authentication tag to ensure the data cannot be tampered with.
     *
     * @param data - The sensitive plaintext string to encrypt.
     * @returns An EncryptedData object containing the ciphertext, IV, and auth tag.
     * @throws Error if the input data is empty.
     */
    encryptData(data) {
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
     * Decrypts an EncryptedData object back into its original plaintext string.
     *
     * This method strictly enforces integrity checks using the provided
     * authentication tag. If the data has been tampered with or the wrong
     * key/IV is used, decryption will fail.
     *
     * @param encrypted - The EncryptedData object (ciphertext, IV, authTag).
     * @returns The original plaintext string.
     * @throws Error if integrity verification fails or the data is malformed.
     */
    decryptData(encrypted) {
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
        }
        catch (error) {
            // Decryption failure usually indicates tampering or an incorrect key.
            throw new Error('SecurityService: Decryption error: integrity verification failed.');
        }
    }
}
exports.SecurityService = SecurityService;
