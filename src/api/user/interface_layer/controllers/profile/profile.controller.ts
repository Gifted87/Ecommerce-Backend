import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { UserUpdateSchema, toPublicUser } from '../../../domain/schemas/user.schema';
import { UserService } from '../../../domain/services/user.service';

/**
 * @fileoverview ProfileController handles HTTP transport for user profile lifecycle.
 * Acts as an interface layer, delegating to UserService while enforcing security
 * and validation constraints.
 */

export class ProfileController {
  constructor(
    private readonly userService: UserService,
    private readonly logger: Logger
  ) {}

  /**
   * Retrieves the authenticated user's profile.
   * Ensures sensitive fields are redacted before returning.
   * 
   * @param req Express Request object
   * @param res Express Response object
   * @param next Express NextFunction
   */
  async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    const userId = (req as any).user?.sub;

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

      const publicProfile = toPublicUser(user);
      res.status(200).json(publicProfile);
    } catch (error) {
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
  async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    const userId = (req as any).user?.sub;

    if (!userId) {
      this.logger.warn({ correlationId }, 'Missing user ID in request context');
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const validation = UserUpdateSchema.safeParse(req.body);

    if (!validation.success) {
      this.logger.warn({ correlationId, errors: validation.error.format() }, 'Profile update validation failed');
      res.status(400).json({ error: 'VALIDATION_FAILED', details: validation.error.format() });
      return;
    }

    try {
      // In a production setup, ownership is inherently tied to the JWT 'sub' claim.
      // We pass the verified user ID to the service to ensure atomicity and correct targeting.
      const updatedUser = await this.userService.updateProfile(userId, validation.data);

      if (!updatedUser) {
        this.logger.error({ correlationId, userId }, 'Failed to update user - user not found');
        res.status(404).json({ error: 'USER_NOT_FOUND' });
        return;
      }

      const publicProfile = toPublicUser(updatedUser);
      res.status(200).json(publicProfile);
    } catch (error) {
      this.logger.error({ correlationId, error }, 'Profile update operation failed');
      next(error);
    }
  }
}
