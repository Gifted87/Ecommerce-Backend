import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import { MfaService } from '../services/mfa.service';

/**
 * Validation schema for Verify MFA request.
 */
const VerifyMfaSchema = z.object({
  token: z.string().length(6, 'OTP must be exactly 6 digits'),
});

/**
 * MfaController handles HTTP transport for MFA lifecycle (setup, verification, disabling).
 * It acts as an orchestrator, delegating domain logic to MfaService.
 */
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly logger: Logger
  ) {}

  /**
   * Health check endpoint to verify MFA Service connectivity.
   */
  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      // In a real system, verify DB and Redis connectivity here
      res.status(200).json({ status: 'UP', service: 'MfaController' });
    } catch (error) {
      this.logger.error({ error }, 'MfaController health check failed');
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }

  /**
   * Handles MFA setup: initiates TOTP secret generation.
   */
  async setup(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = (req as any).user?.id;
    const email = (req as any).user?.email;

    if (!userId || !email) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    try {
      const mfaSecret = await this.mfaService.generateSecret(userId);
      const qrCode = await this.mfaService.createQrCode(mfaSecret.mfa_secret, email);

      res.status(200).json({
        mfa_id: mfaSecret.mfa_id,
        secret: mfaSecret.mfa_secret,
        qr_code: qrCode,
      });
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to setup MFA');
      next(error);
    }
  }

  /**
   * Handles MFA verification: validates OTP token.
   */
  async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = (req as any).user?.id;
    const validation = VerifyMfaSchema.safeParse(req.body);

    if (!userId) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    if (!validation.success) {
      res.status(400).json({ error: validation.error.format() });
      return;
    }

    try {
      const { token } = validation.data;
      const isValid = await this.mfaService.verifyToken(userId, token);

      if (isValid) {
        res.status(200).json({ status: 'VERIFIED' });
      } else {
        res.status(401).json({ error: 'INVALID_TOKEN' });
      }
    } catch (error) {
      this.logger.error({ userId, error }, 'MFA verification error');
      next(error);
    }
  }

  /**
   * Handles MFA deactivation.
   */
  async disable(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    try {
      // Assuming MfaService has a disable method as per requirements
      await this.mfaService.disableMfa(userId);
      res.status(204).send();
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to disable MFA');
      next(error);
    }
  }
}
