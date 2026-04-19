"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MfaController = void 0;
const zod_1 = require("zod");
/**
 * Validation schema for MFA verification input.
 */
const MfaVerifySchema = zod_1.z.object({
    token: zod_1.z.string().length(6, 'TOTP token must be 6 digits'),
});
/**
 * MfaController handles Multi-Factor Authentication lifecycle requests.
 * Acts as an interface layer, delegating business logic to MfaService.
 */
class MfaController {
    constructor(mfaService, logger) {
        this.mfaService = mfaService;
        this.logger = logger;
    }
    /**
     * Generates a new MFA secret for the authenticated user and returns a QR code.
     * Requires: Authenticated session.
     *
     * @param req - Express Request object containing user context.
     * @param res - Express Response object.
     */
    async enableMfa(req, res) {
        const correlationId = req.headers['x-correlation-id'] || 'unknown';
        const userId = req.user?.sub;
        if (!userId) {
            res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
            return;
        }
        try {
            const mfaSecret = await this.mfaService.generateSecret(userId);
            const qrCode = await this.mfaService.createQrCode(mfaSecret.mfa_secret, req.user.email);
            this.logger.info({ correlationId, userId }, 'MFA enablement requested');
            res.status(200).json({
                mfa_id: mfaSecret.mfa_id,
                qr_code: qrCode,
                message: 'MFA setup initialized. Please scan the QR code and verify.',
            });
        }
        catch (error) {
            this.logger.error({ correlationId, userId, error }, 'Failed to initialize MFA setup');
            res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred during MFA initialization.' });
        }
    }
    /**
     * Verifies the user-submitted TOTP code and completes the MFA binding.
     * Requires: Authenticated session, PENDING MFA state.
     *
     * @param req - Express Request object.
     * @param res - Express Response object.
     */
    async verifyMfa(req, res) {
        const correlationId = req.headers['x-correlation-id'] || 'unknown';
        const userId = req.user?.sub;
        if (!userId) {
            res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
            return;
        }
        const validation = MfaVerifySchema.safeParse(req.body);
        if (!validation.success) {
            res.status(400).json({ code: 'INVALID_INPUT', errors: validation.error.format() });
            return;
        }
        try {
            const { token } = validation.data;
            const isValid = await this.mfaService.verifyToken(userId, token);
            if (isValid) {
                this.logger.info({ correlationId, userId }, 'MFA successfully verified');
                res.status(200).json({ message: 'MFA verified and enabled successfully.' });
            }
            else {
                this.logger.warn({ correlationId, userId }, 'MFA verification failed: Invalid token');
                res.status(403).json({ code: 'INVALID_MFA_TOKEN', message: 'The provided MFA token is invalid.' });
            }
        }
        catch (error) {
            this.logger.error({ correlationId, userId, error }, 'MFA verification process crashed');
            res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred during MFA verification.' });
        }
    }
}
exports.MfaController = MfaController;
