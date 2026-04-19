"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = exports.AuthError = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const types_1 = require("../types");
const uuid_1 = require("uuid");
const pino_1 = __importDefault(require("pino"));
const logger = (0, pino_1.default)({ level: 'info' });
/**
 * Custom exceptions for authentication workflow.
 */
class AuthError extends Error {
    constructor(message, statusCode = 401) {
        super(message);
        this.message = message;
        this.statusCode = statusCode;
    }
}
exports.AuthError = AuthError;
/**
 * @class AuthService
 * @description Orchestrates identity verification, MFA transitions, and session management.
 */
class AuthService {
    constructor(db, redis, securityService) {
        this.db = db;
        this.redis = redis;
        this.securityService = securityService;
        this.jwtExpiration = '15m';
        this.jwtSecret = process.env.JWT_SECRET || 'fallback_secret_must_be_configured_in_production';
    }
    /**
     * Verifies user credentials using Argon2id.
     * Implements rate limiting protection.
     */
    async verifyCredentials(email, password, ipAddress) {
        const correlationId = (0, uuid_1.v4)();
        logger.info({ correlationId, event: 'CREDENTIAL_VERIFICATION_START' });
        // Rate limiting check
        await this.checkRateLimit(email, ipAddress);
        const client = await this.db.connect();
        try {
            const { rows } = await client.query('SELECT user_id, password_hash FROM users WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
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
        }
        finally {
            client.release();
        }
    }
    /**
     * Orchestrates the login process.
     */
    async login(userId, ipAddress, userAgent) {
        const correlationId = (0, uuid_1.v4)();
        logger.info({ correlationId, event: 'LOGIN_ORCHESTRATION_START', userId });
        const client = await this.db.connect();
        try {
            const { rows } = await client.query('SELECT email, mfa_secret, is_verified FROM users WHERE user_id = $1', [userId]);
            const user = rows[0];
            // Logic: If mfa_secret exists and user is enabled, MFA is required
            const mfaEnabled = user.mfa_secret !== null;
            if (mfaEnabled) {
                const sessionId = await this.createSession(userId, types_1.MfaStatus.PENDING, ipAddress, userAgent);
                logger.info({ correlationId, event: 'MFA_REQUIRED', userId });
                return { mfaRequired: true, sessionId };
            }
            const token = await this.generateToken(userId, user.email, false);
            logger.info({ correlationId, event: 'LOGIN_SUCCESS', userId });
            return { mfaRequired: false, token };
        }
        finally {
            client.release();
        }
    }
    /**
     * Rotates a JWT session if the refresh token is valid.
     */
    async refreshSession(refreshToken) {
        const correlationId = (0, uuid_1.v4)();
        logger.info({ correlationId, event: 'REFRESH_SESSION_START' });
        try {
            const decoded = jsonwebtoken_1.default.verify(refreshToken, this.jwtSecret);
            const userId = decoded.sub;
            const { rows } = await this.db.query('SELECT email FROM users WHERE user_id = $1', [userId]);
            if (rows.length === 0)
                throw new AuthError('User not found', 404);
            const newToken = await this.generateToken(userId, rows[0].email, decoded.mfa_verified);
            return { token: newToken };
        }
        catch (error) {
            logger.error({ correlationId, error, event: 'REFRESH_SESSION_FAILED' });
            throw new AuthError('Invalid refresh token');
        }
    }
    async createSession(userId, mfaStatus, ip, ua) {
        const sessionId = (0, uuid_1.v4)();
        const session = {
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
    async generateToken(userId, email, mfaVerified) {
        const payload = {
            sub: userId,
            email: email,
            roles: ['user'],
            mfa_verified: mfaVerified,
            exp: Math.floor(Date.now() / 1000) + 900,
            jti: (0, uuid_1.v4)(),
            sid: (0, uuid_1.v4)()
        };
        return jsonwebtoken_1.default.sign(payload, this.jwtSecret);
    }
    async checkRateLimit(email, ip) {
        const now = Date.now();
        const userKey = `rate_limit:user:${email}`;
        const ipKey = `rate_limit:ip:${ip}`;
        const multi = this.redis.multi();
        multi.incr(userKey);
        multi.pexpire(userKey, 60000);
        multi.incr(ipKey);
        multi.pexpire(ipKey, 60000);
        const results = await multi.exec();
        if (!results)
            throw new AuthError('Rate limit processing error', 500);
        const [uCount, , iCount] = results.map(r => r[1]);
        if (uCount > 5 || iCount > 20) {
            throw new AuthError('Too many attempts. Please try again later.', 429);
        }
    }
}
exports.AuthService = AuthService;
