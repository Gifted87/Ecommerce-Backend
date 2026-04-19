import { Router, Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { Logger } from 'pino';
import { RegistrationController } from '../controllers/registration/registration.controller';
import { ProfileController } from '../controllers/profile/profile.controller';
import { MfaController } from '../controllers/mfa/mfaController';
import { AuthController } from '../../../../services/user/auth_mfa_module/controllers/auth.controller';
import { 
  createAuthMiddleware, 
} from '../middleware/security/auth.middleware';

/**
 * @fileoverview User API Routing Module.
 * Defines endpoints for user management, profiles, and MFA operations.
 */

export interface RouterDependencies {
  redis: Redis;
  logger: Logger;
  userRegistrationController: RegistrationController;
  userProfileController: ProfileController;
  mfaController: MfaController;
  authController: AuthController;
}

/**
 * Configures and returns the Express router for the User API.
 * 
 * @param deps - Dependencies including controllers and infrastructure clients.
 * @returns {Router} Configured Express router.
 */
export const createUserRouter = (deps: RouterDependencies): Router => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(deps.redis, deps.logger);

  /**
   * POST /register
   * Bypasses authentication. Registers a new user.
   */
  router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.userRegistrationController.register(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /login
   * Authenticates a user and returns a session or MFA challenge.
   */
  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.authController.handleLogin(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /refresh
   * Rotates an existing JWT session.
   */
  router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.authController.handleRefresh(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /profile
   * Requires authenticated user. Retrieves user profile.
   */
  router.get('/profile', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.userProfileController.getProfile(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * PATCH /profile
   * Requires authenticated user. Updates user profile fields.
   */
  router.patch('/profile', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.userProfileController.updateProfile(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /mfa/enable
   * Requires authenticated user. Initiates MFA setup process.
   */
  router.post('/mfa/enable', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.mfaController.enableMfa(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /mfa/verify
   * Requires authenticated user. Finalizes MFA activation.
   */
  router.post('/mfa/verify', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.mfaController.verifyMfa(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
