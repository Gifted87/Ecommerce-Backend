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
exports.MfaService = void 0;
const otplib_1 = require("otplib");
const qrcode_1 = require("qrcode");
const crypto = __importStar(require("crypto"));
const types_1 = require("../types");
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
class MfaService {
    /**
     * @param redis - The ioredis client for managing transient MFA states.
     * @param db - The PostgreSQL connection pool for persisting MFA secrets.
     * @param securityService - Service providing encryption/decryption utilities.
     * @param logger - The application's pino logger instance.
     */
    constructor(redis, db, securityService, logger) {
        this.redis = redis;
        this.db = db;
        this.securityService = securityService;
        this.logger = logger;
        // Configure otplib with standard RFC 6238 settings
        otplib_1.authenticator.options = {
            window: 1, // Allow 30s clock skew
            step: 30,
        };
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
    async generateSecret(userId) {
        const rawSecret = otplib_1.authenticator.generateSecret();
        const encrypted = this.securityService.encryptData(rawSecret);
        const mfaSecret = {
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
    async createQrCode(secret, email) {
        const otpAuthUrl = otplib_1.authenticator.keyuri(email, 'EcommerceApp', secret);
        try {
            return await (0, qrcode_1.toDataURL)(otpAuthUrl);
        }
        catch (error) {
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
    async verifyToken(userId, token) {
        const correlationId = crypto.randomUUID();
        const stateKey = `mfa:pending:${userId}`;
        try {
            // 1. Atomic Check and Lock
            const lockAcquired = await this.redis.set(stateKey, types_1.MfaStatus.PENDING, 'NX', 'EX', 300);
            if (!lockAcquired) {
                this.logger.warn({ userId, correlationId }, 'MFA verification attempt while locked or already in progress.');
                return false;
            }
            // 2. Retrieve and Decrypt Secret from PostgreSQL
            const encryptedDataRaw = await this.fetchEncryptedSecretFromDb(userId);
            const encryptedData = JSON.parse(encryptedDataRaw);
            const secret = this.securityService.decryptData(encryptedData);
            // 3. Validate Token
            const isValid = otplib_1.authenticator.check(token, secret);
            if (isValid) {
                await this.redis.set(stateKey, types_1.MfaStatus.VERIFIED, 'EX', 300);
                return true;
            }
            else {
                await this.redis.del(stateKey);
                this.logger.info({ userId, correlationId }, 'MFA validation failed.');
                return false;
            }
        }
        catch (error) {
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
    async disableMfa(userId) {
        const query = 'UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE user_id = $1';
        try {
            const result = await this.db.query(query, [userId]);
            if (result.rowCount === 0) {
                throw new Error('USER_NOT_FOUND');
            }
            this.logger.info({ userId }, 'MFA disabled successfully');
        }
        catch (error) {
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
    async fetchEncryptedSecretFromDb(userId) {
        const query = 'SELECT mfa_secret FROM users WHERE user_id = $1 AND mfa_secret IS NOT NULL';
        try {
            const result = await this.db.query(query, [userId]);
            if (result.rows.length === 0) {
                throw new Error('MFA_SECRET_NOT_FOUND');
            }
            return result.rows[0].mfa_secret;
        }
        catch (error) {
            this.logger.error({ userId, error }, 'Database error during MFA secret retrieval');
            throw new Error('DB_QUERY_FAILED');
        }
    }
}
exports.MfaService = MfaService;
