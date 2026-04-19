"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSecurityMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const uuid_1 = require("uuid");
/**
 * Redacts PII from logging payloads to prevent leakage.
 */
const redactPII = (data) => {
    const sensitiveKeys = ['email', 'password', 'token', 'mfa_secret', 'authorization', 'cookie', 'set-cookie'];
    const redacted = { ...data };
    for (const key in redacted) {
        if (sensitiveKeys.includes(key.toLowerCase())) {
            redacted[key] = '[REDACTED]';
        }
        else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
            redacted[key] = redactPII(redacted[key]);
        }
    }
    return redacted;
};
/**
 * Middleware factory for security and observability enforcement.
 *
 * @param redis - Production-grade Redis client for session validation.
 * @param logger - Pre-configured Pino logger instance.
 */
const createSecurityMiddleware = (redis, logger) => {
    return {
        /**
         * Injects Correlation ID and logger into request.
         */
        telemetry: (req, res, next) => {
            const startTime = process.hrtime();
            const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
            req.correlationId = correlationId;
            req.log = logger.child({ correlationId, method: req.method, url: req.url });
            res.setHeader('x-correlation-id', correlationId);
            res.on('finish', () => {
                const diff = process.hrtime(startTime);
                const durationMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(3);
                req.log.info({ status: res.statusCode, durationMs }, 'Request completed');
            });
            next();
        },
        /**
         * Enforces JWT authentication, Session validation, MFA, and RBAC.
         */
        authenticate: (options = {}) => {
            return async (req, res, next) => {
                const authHeader = req.headers.authorization;
                const correlationId = req.correlationId;
                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    req.log.warn('Missing or invalid Authorization header');
                    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required', correlationId });
                }
                const token = authHeader.split(' ')[1];
                const jwtSecret = process.env.JWT_SECRET;
                if (!jwtSecret) {
                    req.log.error('JWT_SECRET not configured');
                    return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Auth system configuration error', correlationId });
                }
                try {
                    const decoded = jsonwebtoken_1.default.verify(token, jwtSecret);
                    try {
                        const sessionExists = await redis.exists(`session:${decoded.sid}`);
                        if (!sessionExists) {
                            req.log.warn({ sid: decoded.sid }, 'Session expired or revoked');
                            return res.status(401).json({ code: 'SESSION_EXPIRED', message: 'Session no longer valid', correlationId });
                        }
                    }
                    catch (redisError) {
                        req.log.error({ error: redisError }, 'Redis connectivity failure');
                        return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Auth storage unavailable', correlationId });
                    }
                    if (options.mfaRequired && !decoded.mfa_verified) {
                        req.log.warn('MFA verification required');
                        return res.status(403).json({ code: 'MFA_REQUIRED', message: 'MFA verification required', correlationId });
                    }
                    if (options.requiredRoles && options.requiredRoles.length > 0) {
                        const hasRole = options.requiredRoles.every((role) => decoded.roles.includes(role));
                        if (!hasRole) {
                            req.log.warn({ requiredRoles: options.requiredRoles }, 'Insufficient permissions');
                            return res.status(403).json({ code: 'FORBIDDEN', message: 'Insufficient permissions', correlationId });
                        }
                    }
                    req.user = decoded;
                    req.session_id = decoded.sid;
                    next();
                }
                catch (error) {
                    if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
                        req.log.warn('Token expired');
                        return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Token has expired', correlationId });
                    }
                    req.log.error({ error: redactPII({ err: error }) }, 'Token validation failure');
                    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token', correlationId });
                }
            };
        }
    };
};
exports.createSecurityMiddleware = createSecurityMiddleware;
