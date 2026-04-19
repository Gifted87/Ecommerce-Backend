"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const uuid_1 = require("uuid");
/**
 * Redacts PII from logging payloads to prevent sensitive information leakage.
 * Specifically targets known sensitive keys used in authentication flows.
 *
 * @param data - The log object containing potentially sensitive fields.
 * @returns A new object with sensitive fields replaced by a redaction marker.
 */
const redactPII = (data) => {
    const sensitiveKeys = ['email', 'password', 'token', 'mfa_secret', 'authorization'];
    const redacted = { ...data };
    for (const key in redacted) {
        if (Object.prototype.hasOwnProperty.call(redacted, key)) {
            if (sensitiveKeys.includes(key.toLowerCase())) {
                redacted[key] = '[REDACTED]';
            }
            else if (typeof redacted[key] === 'object' && redacted[key] !== null && !Array.isArray(redacted[key])) {
                redacted[key] = redactPII(redacted[key]);
            }
        }
    }
    return redacted;
};
/**
 * Creates the production-grade authentication middleware factory.
 *
 * @param redis - The pre-initialized ioredis client instance.
 * @param logger - The pre-configured pino logger instance for structured JSON logging.
 * @returns A higher-order function that produces the Express middleware.
 */
const createAuthMiddleware = (redis, logger) => {
    return (options = {}) => {
        return async (req, res, next) => {
            const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
            const authHeader = req.headers.authorization;
            // 1. Header Extraction & Validation
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                logger.warn({ correlationId, path: req.path }, 'Missing or invalid Authorization header');
                return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
            }
            const token = authHeader.split(' ')[1];
            try {
                // 2. JWT Verification
                const jwtSecret = process.env.JWT_SECRET;
                if (!jwtSecret) {
                    logger.error({ correlationId }, 'Internal configuration error: JWT_SECRET missing');
                    return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'System configuration error' });
                }
                const decoded = jsonwebtoken_1.default.verify(token, jwtSecret);
                // 3. Session State Verification (Zero Trust)
                const sessionKey = `session:${decoded.sid}`;
                const sessionExists = await redis.exists(sessionKey);
                if (!sessionExists) {
                    logger.warn({ correlationId, userId: decoded.sub, sid: decoded.sid }, 'Session expired or revoked');
                    return res.status(401).json({ code: 'SESSION_EXPIRED', message: 'Session no longer valid' });
                }
                // 4. MFA Requirement Enforcement
                if (options.mfaRequired && !decoded.mfa_verified) {
                    const mfaStatus = await redis.get(`mfa:status:${decoded.sub}`);
                    if (mfaStatus !== 'VERIFIED') {
                        logger.warn({ correlationId, userId: decoded.sub }, 'MFA verification required for this route');
                        return res.status(403).json({ code: 'MFA_REQUIRED', message: 'MFA verification is required' });
                    }
                }
                // 5. RBAC/ABAC Scope Check
                if (options.requiredRoles && options.requiredRoles.length > 0) {
                    const hasRole = options.requiredRoles.every((role) => decoded.roles.includes(role));
                    if (!hasRole) {
                        logger.warn({
                            correlationId,
                            userId: decoded.sub,
                            requiredRoles: options.requiredRoles,
                            userRoles: decoded.roles
                        }, 'Insufficient permissions');
                        return res.status(403).json({ code: 'FORBIDDEN', message: 'You do not have the required permissions' });
                    }
                }
                // 6. Context Injection & Proceed
                req.user = decoded;
                req.session_id = decoded.sid;
                next();
            }
            catch (error) {
                if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
                    logger.warn({ correlationId, error: error.message }, 'Token expired');
                    return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Token has expired' });
                }
                if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
                    logger.warn({ correlationId, error: error.message }, 'Invalid token');
                    return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Authentication token is invalid' });
                }
                logger.error({
                    correlationId,
                    error: redactPII({ message: error.message, stack: error.stack })
                }, 'Authentication middleware unexpected failure');
                return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication system failure' });
            }
        };
    };
};
exports.createAuthMiddleware = createAuthMiddleware;
