import { Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { AuthService } from '../services/auth.service';

/**
 * Zod schema for login request validation.
 */
const LoginSchema = z.object({
  email: z.string().email('Invalid email format').trim().toLowerCase(),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Zod schema for refresh request validation.
 */
const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/**
 * @class AuthController
 * @description HTTP controller for handling user authentication and session refresh.
 */
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly logger: Logger
  ) {}

  /**
   * Handles POST /login requests.
   * 
   * @param req - Express Request object.
   * @param res - Express Response object.
   */
  async handleLogin(req: Request, res: Response): Promise<void> {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
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
      } else {
        res.status(200).json({
          mfa_required: false,
          token: result.token
        });
      }
    } catch (error: any) {
      this.handleError(res, error, correlationId);
    }
  }

  /**
   * Handles POST /refresh requests.
   * 
   * @param req - Express Request object.
   * @param res - Express Response object.
   */
  async handleRefresh(req: Request, res: Response): Promise<void> {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
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
    } catch (error: any) {
      this.handleError(res, error, correlationId);
    }
  }

  /**
   * Centralized error handling mapping service errors to HTTP status codes.
   */
  private handleError(res: Response, error: any, correlationId: string): void {
    this.logger.error({ correlationId, event: 'ERROR_OCCURRED', error: error.message });

    if (error.statusCode === 401 || error.message.includes('Invalid credentials')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else if (error.statusCode === 429) {
      res.status(429).json({ error: 'Too many requests' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
