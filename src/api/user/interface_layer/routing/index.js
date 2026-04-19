"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../middleware/security/auth.middleware");
/**
 * Configures and returns the Express router for the User API.
 *
 * @param deps - Dependencies including controllers and infrastructure clients.
 * @returns {Router} Configured Express router.
 */
const createUserRouter = (deps) => {
    const router = (0, express_1.Router)();
    const authMiddleware = (0, auth_middleware_1.createAuthMiddleware)(deps.redis, deps.logger);
    /**
     * POST /register
     * Bypasses authentication. Registers a new user.
     */
    router.post('/register', async (req, res, next) => {
        try {
            await deps.userRegistrationController.register(req, res, next);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * POST /login
     * Authenticates a user and returns a session or MFA challenge.
     */
    router.post('/login', async (req, res, next) => {
        try {
            await deps.authController.handleLogin(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * POST /refresh
     * Rotates an existing JWT session.
     */
    router.post('/refresh', async (req, res, next) => {
        try {
            await deps.authController.handleRefresh(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * GET /profile
     * Requires authenticated user. Retrieves user profile.
     */
    router.get('/profile', authMiddleware(), async (req, res, next) => {
        try {
            await deps.userProfileController.getProfile(req, res, next);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * PATCH /profile
     * Requires authenticated user. Updates user profile fields.
     */
    router.patch('/profile', authMiddleware(), async (req, res, next) => {
        try {
            await deps.userProfileController.updateProfile(req, res, next);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * POST /mfa/enable
     * Requires authenticated user. Initiates MFA setup process.
     */
    router.post('/mfa/enable', authMiddleware(), async (req, res, next) => {
        try {
            await deps.mfaController.enableMfa(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * POST /mfa/verify
     * Requires authenticated user. Finalizes MFA activation.
     */
    router.post('/mfa/verify', authMiddleware(), async (req, res, next) => {
        try {
            await deps.mfaController.verifyMfa(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    return router;
};
exports.createUserRouter = createUserRouter;
