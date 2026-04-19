import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import { MfaService } from '../../../../../services/user/auth_mfa_module/services/mfa.service';

const MfaVerifySchema = z.object({
  token: z.string().length(6, 'TOTP token must be 6 digits'),
});

/**
 * MfaController handles Multi-Factor Authentication lifecycle requests.
 */
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly logger: Logger
  ) {}

  async enableMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;

    if (!userId) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required', correlationId });
      return;
    }

    try {
      const mfaSecret = await this.mfaService.generateSecret(userId);
      const qrCode = await this.mfaService.createQrCode(mfaSecret.mfa_secret, (req as any).user!.email);

      this.logger.info({ correlationId, userId }, 'MFA enablement requested');

      res.status(200).json({
        mfa_id: mfaSecret.mfa_id,
        qr_code: qrCode,
        message: 'MFA setup initialized. Please scan the QR code and verify.',
        correlationId
      });
    } catch (error: any) {
      next(error);
    }
  }

  async verifyMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;

    if (!userId) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required', correlationId });
      return;
    }

    const validation = MfaVerifySchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ code: 'INVALID_INPUT', errors: validation.error.format(), correlationId });
      return;
    }

    try {
      const { token } = validation.data;
      const isValid = await this.mfaService.verifyToken(userId, token);

      if (isValid) {
        this.logger.info({ correlationId, userId }, 'MFA successfully verified');
        res.status(200).json({ message: 'MFA verified and enabled successfully.', correlationId });
      } else {
        this.logger.warn({ correlationId, userId }, 'MFA verification failed: Invalid token');
        res.status(403).json({ code: 'INVALID_MFA_TOKEN', message: 'The provided MFA token is invalid.', correlationId });
      }
    } catch (error: any) {
      next(error);
    }
  }
}
