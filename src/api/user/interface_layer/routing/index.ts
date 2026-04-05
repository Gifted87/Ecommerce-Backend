import { Router, Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { Logger } from 'pino';
import { 
  UserRegistrationController, 
  UserProfileController, 
  MFAController 
} from '../controllers';
import { 
  createAuthMiddleware, 
  correlationMiddleware, 
  AuthMiddlewareOptions 
} from '../../middleware';

/**
 * @fileoverview User API Routing Module.
 * Defines endpoints for user management, profiles, and MFA operations.
 */

export interface RouterDependencies {
  redis: Redis;
  logger: Logger;
  userRegistrationController: UserRegistrationController;
  userProfileController: UserProfileController;
  mfaController: MFAController;
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

  // Apply correlation tracking to all routes
  router.use(correlationMiddleware);

  /**
   * POST /register
   * Bypasses authentication. Registers a new user.
   */
  router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.userRegistrationController.register(req, res);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /profile
   * Requires authenticated user. Retrieves user profile.
   */
  router.get('/profile', authMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.userProfileController.getProfile(req, res);
    } catch (error) {
      next(error);
    }
  });

  /**
   * PATCH /profile
   * Requires authenticated user. Updates user profile fields.
   */
  router.patch('/profile', authMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.userProfileController.updateProfile(req, res);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /mfa/enable
   * Requires authenticated user. Initiates MFA setup process.
   */
  router.post('/mfa/enable', authMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.mfaController.enable(req, res);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /mfa/verify
   * Requires authenticated user. Finalizes MFA activation.
   */
  router.post('/mfa/verify', authMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.mfaController.verify(req, res);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
