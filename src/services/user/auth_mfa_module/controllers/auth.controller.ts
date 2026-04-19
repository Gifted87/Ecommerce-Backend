import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import { AuthService } from '../services/auth.service';

const LoginSchema = z.object({
  email: z.string().email('Invalid email format').trim().toLowerCase(),
  password: z.string().min(1, 'Password is required'),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/**
 * HTTP controller for handling user authentication and session refresh.
 */
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly logger: Logger
  ) {}

  async handleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    this.logger.info({ correlationId, event: 'REQUEST_RECEIVED', method: 'POST', path: '/login' });

    try {
      const validationResult = LoginSchema.safeParse(req.body);
      if (!validationResult.success) {
        this.logger.warn({ correlationId, event: 'ERROR_OCCURRED', error: 'VALIDATION_FAILED' });
        res.status(400).json({ error: 'Invalid input', details: validationResult.error.format(), correlationId });
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
          message: 'MFA challenge required',
          correlationId
        });
      } else {
        res.status(200).json({
          mfa_required: false,
          token: result.token,
          correlationId
        });
      }
    } catch (error: any) {
      next(error);
    }
  }

  async handleRefresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    this.logger.info({ correlationId, event: 'REQUEST_RECEIVED', method: 'POST', path: '/refresh' });

    try {
      const refreshToken = req.headers['authorization']?.split(' ')[1] || req.body.refreshToken;
      
      const validationResult = RefreshSchema.safeParse({ refreshToken });
      if (!validationResult.success) {
        this.logger.warn({ correlationId, event: 'ERROR_OCCURRED', error: 'VALIDATION_FAILED' });
        res.status(400).json({ error: 'Refresh token is required', correlationId });
        return;
      }

      this.logger.info({ correlationId, event: 'REFRESH_STARTED' });
      const newTokens = await this.authService.refreshSession(validationResult.data.refreshToken);

      this.logger.info({ correlationId, event: 'REFRESH_COMPLETED' });
      res.status(200).json({ ...newTokens, correlationId });
    } catch (error: any) {
      next(error);
    }
  }
}
