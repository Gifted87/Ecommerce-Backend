"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const zod_1 = require("zod");
const uuid_1 = require("uuid");
/**
 * Zod schema for login request validation.
 */
const LoginSchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format').trim().toLowerCase(),
    password: zod_1.z.string().min(1, 'Password is required'),
});
/**
 * Zod schema for refresh request validation.
 */
const RefreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(1, 'Refresh token is required'),
});
/**
 * @class AuthController
 * @description HTTP controller for handling user authentication and session refresh.
 */
class AuthController {
    constructor(authService, logger) {
        this.authService = authService;
        this.logger = logger;
    }
    /**
     * Handles POST /login requests.
     *
     * @param req - Express Request object.
     * @param res - Express Response object.
     */
    async handleLogin(req, res) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        this.logger.info({ correlationId, event: 'REQUEST_RECEIVED', method: 'POST', path: '/login' });
        try {
            const validationResult = LoginSchema.safeParse(req.body);
            if (!validationResult.success) {
                this.logger.warn({ correlationId, event: 'ERROR_OCCURRED', error: 'VALIDATION_FAILED' });
                res.status(400).json({ error: 'Invalid input', details: validationResult.error.format() });
                return;
            }
            this.logger.info({ correlationId, event: 'LOGIN_STARTED' });
            const { email, password } = validationResult.data;
            const ipAddress = req.ip || '0.0.0.0';
            const userAgent = req.headers['user-agent'] || 'unknown';
            const userId = await this.authService.verifyCredentials(email, password, ipAddress);
            const result = await this.authService.login(userId, ipAddress, userAgent);
            this.logger.info({ correlationId, event: 'LOGIN_COMPLETED', userId });
            if (result.mfaRequired) {
                res.status(202).json({
                    mfa_required: true,
                    session_id: result.sessionId,
                    message: 'MFA challenge required'
                });
            }
            else {
                res.status(200).json({
                    mfa_required: false,
                    token: result.token
                });
            }
        }
        catch (error) {
            this.handleError(res, error, correlationId);
        }
    }
    /**
     * Handles POST /refresh requests.
     *
     * @param req - Express Request object.
     * @param res - Express Response object.
     */
    async handleRefresh(req, res) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        this.logger.info({ correlationId, event: 'REQUEST_RECEIVED', method: 'POST', path: '/refresh' });
        try {
            const refreshToken = req.headers['authorization']?.split(' ')[1] || req.body.refreshToken;
            const validationResult = RefreshSchema.safeParse({ refreshToken });
            if (!validationResult.success) {
                this.logger.warn({ correlationId, event: 'ERROR_OCCURRED', error: 'VALIDATION_FAILED' });
                res.status(400).json({ error: 'Refresh token is required' });
                return;
            }
            this.logger.info({ correlationId, event: 'REFRESH_STARTED' });
            // Delegation to AuthService for token rotation logic
            const newTokens = await this.authService.refreshSession(validationResult.data.refreshToken);
            this.logger.info({ correlationId, event: 'REFRESH_COMPLETED' });
            res.status(200).json(newTokens);
        }
        catch (error) {
            this.handleError(res, error, correlationId);
        }
    }
    /**
     * Centralized error handling mapping service errors to HTTP status codes.
     */
    handleError(res, error, correlationId) {
        this.logger.error({ correlationId, event: 'ERROR_OCCURRED', error: error.message });
        if (error.statusCode === 401 || error.message.includes('Invalid credentials')) {
            res.status(401).json({ error: 'Unauthorized' });
        }
        else if (error.statusCode === 429) {
            res.status(429).json({ error: 'Too many requests' });
        }
        else {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}
exports.AuthController = AuthController;
