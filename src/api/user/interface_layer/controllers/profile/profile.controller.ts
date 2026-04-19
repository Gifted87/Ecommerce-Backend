import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { UserUpdateSchema, toPublicUser } from '../../../../../services/user/auth_mfa_module/types';
import { UserService } from '../../../../../services/user/auth_mfa_module/services/user.service';

/**
 * ProfileController handles HTTP transport for user profile lifecycle.
 */
export class ProfileController {
  constructor(
    private readonly userService: UserService,
    private readonly logger: Logger
  ) {}

  async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;

    if (!userId) {
      this.logger.warn({ correlationId }, 'Missing user ID in request context');
      res.status(401).json({ error: 'UNAUTHORIZED', correlationId });
      return;
    }

    try {
      const user = await this.userService.findById(userId);

      if (!user) {
        this.logger.warn({ correlationId, userId }, 'User not found');
        res.status(404).json({ error: 'USER_NOT_FOUND', correlationId });
        return;
      }

      const publicProfile = toPublicUser(user);
      res.status(200).json(publicProfile);
    } catch (error: any) {
      this.logger.error({ correlationId, error }, 'Failed to fetch user profile');
      next(error);
    }
  }

  async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;

    if (!userId) {
      this.logger.warn({ correlationId }, 'Missing user ID in request context');
      res.status(401).json({ error: 'UNAUTHORIZED', correlationId });
      return;
    }

    const validation = UserUpdateSchema.safeParse(req.body);

    if (!validation.success) {
      this.logger.warn({ correlationId, errors: validation.error.format() }, 'Profile update validation failed');
      res.status(400).json({ error: 'VALIDATION_FAILED', details: validation.error.format(), correlationId });
      return;
    }

    try {
      const updatedUser = await this.userService.updateProfile(userId, validation.data);
      const publicProfile = toPublicUser(updatedUser);
      this.logger.info({ correlationId, userId }, 'Profile update completed');
      res.status(200).json(publicProfile);
    } catch (error: any) {
      this.logger.error({ correlationId, userId, error: error.message }, 'Failed to update user profile');
      if (error.message === 'USER_NOT_FOUND') {
        res.status(404).json({ error: 'USER_NOT_FOUND', correlationId });
      } else {
        next(error);
      }
    }
  }
}
