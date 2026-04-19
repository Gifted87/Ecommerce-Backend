"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileController = void 0;
const uuid_1 = require("uuid");
const types_1 = require("../../../../../services/user/auth_mfa_module/types");
/**
 * @fileoverview ProfileController handles HTTP transport for user profile lifecycle.
 * Acts as an interface layer, delegating to UserService while enforcing security
 * and validation constraints.
 */
class ProfileController {
    constructor(userService, logger) {
        this.userService = userService;
        this.logger = logger;
    }
    /**
     * Retrieves the authenticated user's profile.
     * Ensures sensitive fields are redacted before returning.
     *
     * @param req Express Request object
     * @param res Express Response object
     * @param next Express NextFunction
     */
    async getProfile(req, res, next) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        const userId = req.user?.sub;
        if (!userId) {
            this.logger.warn({ correlationId }, 'Missing user ID in request context');
            res.status(401).json({ error: 'UNAUTHORIZED' });
            return;
        }
        try {
            const user = await this.userService.findById(userId);
            if (!user) {
                this.logger.warn({ correlationId, userId }, 'User not found');
                res.status(404).json({ error: 'USER_NOT_FOUND' });
                return;
            }
            const publicProfile = (0, types_1.toPublicUser)(user);
            res.status(200).json(publicProfile);
        }
        catch (error) {
            this.logger.error({ correlationId, error }, 'Failed to fetch user profile');
            next(error);
        }
    }
    /**
     * Updates the authenticated user's profile.
     * Validates input, performs ownership verification, and commits changes.
     *
     * @param req Express Request object
     * @param res Express Response object
     * @param next Express NextFunction
     */
    async updateProfile(req, res, next) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        const userId = req.user?.sub;
        if (!userId) {
            this.logger.warn({ correlationId }, 'Missing user ID in request context');
            res.status(401).json({ error: 'UNAUTHORIZED' });
            return;
        }
        const validation = types_1.UserUpdateSchema.safeParse(req.body);
        if (!validation.success) {
            this.logger.warn({ correlationId, errors: validation.error.format() }, 'Profile update validation failed');
            res.status(400).json({ error: 'VALIDATION_FAILED', details: validation.error.format() });
            return;
        }
        try {
            // In a production setup, ownership is inherently tied to the JWT 'sub' claim.
            // We pass the verified user ID to the service to ensure atomicity and correct targeting.
            const updatedUser = await this.userService.updateProfile(userId, validation.data);
            const publicProfile = (0, types_1.toPublicUser)(updatedUser);
            this.logger.info({ correlationId, userId }, 'Profile update completed');
            res.status(200).json(publicProfile);
        }
        catch (error) {
            this.logger.error({ correlationId, userId, error: error.message }, 'Failed to update user profile');
            if (error.message === 'USER_NOT_FOUND') {
                res.status(404).json({ error: 'USER_NOT_FOUND' });
            }
            else {
                next(error);
            }
        }
    }
}
exports.ProfileController = ProfileController;
