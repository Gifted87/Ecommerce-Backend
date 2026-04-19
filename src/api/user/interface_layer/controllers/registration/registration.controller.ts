import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { UserRegistrationSchema, toPublicUser } from '../../../../../services/user/auth_mfa_module/types';
import { UserService } from '../../../../../services/user/auth_mfa_module/services/user.service';

/**
 * Controller responsible for user registration HTTP endpoints.
 */
export class RegistrationController {
  constructor(
    private readonly userService: UserService,
    private readonly logger: Logger
  ) {}

  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    
    this.logger.info({ correlationId, path: req.path }, 'User registration request received');

    const validation = UserRegistrationSchema.safeParse(req.body);
    
    if (!validation.success) {
      this.logger.warn({ correlationId, errors: validation.error.format() }, 'Registration validation failed');
      res.status(400).json({ error: 'VALIDATION_FAILED', details: validation.error.format(), correlationId });
      return;
    }

    try {
      const user = await this.userService.register(validation.data);
      const publicUser = toPublicUser(user);
      this.logger.info({ correlationId, userId: user.user_id }, 'User registration completed successfully');
      res.status(201).json(publicUser);
    } catch (error: any) {
      this.logger.error({ correlationId, error: error.message }, 'Registration process failed');
      
      if (error.message === 'USER_ALREADY_EXISTS') {
        res.status(409).json({ error: 'USER_ALREADY_EXISTS', correlationId });
      } else {
        next(error);
      }
    }
  }
}
