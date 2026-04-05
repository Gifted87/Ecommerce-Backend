import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { Logger } from 'pino';
import { TokenPayload, MfaStatus } from '../types';

/**
 * Interface for extended Request object.
 */
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      session_id?: string;
    }
  }
}

/**
 * Middleware options for fine-grained route control.
 */
interface AuthMiddlewareOptions {
  mfaRequired?: boolean;
  requiredRoles?: string[];
}

/**
 * Redacts PII from logging payloads.
 */
const redactPII = (data: Record<string, any>): Record<string, any> => {
  const sensitiveKeys = ['email', 'password', 'token', 'mfa_secret'];
  const redacted = { ...data };
  for (const key in redacted) {
    if (sensitiveKeys.includes(key)) {
      redacted[key] = '[REDACTED]';
    }
  }
  return redacted;
};

/**
 * Creates the authentication middleware factory.
 */
export const createAuthMiddleware = (
  redis: Redis,
  logger: Logger
) => {
  return (options: AuthMiddlewareOptions = {}) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = (req.headers['x-correlation-id'] as string) || 'generated-uuid';
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn({ correlationId, path: req.path }, 'Missing or invalid Authorization header');
        return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }

      const token = authHeader.split(' ')[1];

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as TokenPayload;

        // 1. Check Session Validity in Redis
        const session = await redis.get(`session:${decoded.sid}`);
        if (!session) {
          logger.warn({ correlationId, userId: decoded.sub }, 'Session expired or invalid');
          return res.status(401).json({ code: 'SESSION_EXPIRED', message: 'Session no longer valid' });
        }

        // 2. MFA Requirement Enforcement
        if (options.mfaRequired && !decoded.mfa_verified) {
          const mfaStatus = await redis.get(`mfa:status:${decoded.sub}`);
          if (mfaStatus !== MfaStatus.VERIFIED) {
            logger.warn({ correlationId, userId: decoded.sub }, 'MFA verification required for this route');
            return res.status(403).json({ code: 'MFA_REQUIRED', message: 'MFA verification is required' });
          }
        }

        // 3. RBAC/ABAC Scope Check
        if (options.requiredRoles && options.requiredRoles.length > 0) {
          const hasRole = options.requiredRoles.every(role => decoded.roles.includes(role));
          if (!hasRole) {
            logger.warn({ correlationId, userId: decoded.sub, requiredRoles: options.requiredRoles }, 'Insufficient permissions');
            return res.status(403).json({ code: 'FORBIDDEN', message: 'You do not have the required permissions' });
          }
        }

        // 4. Attach context and proceed
        req.user = decoded;
        req.session_id = decoded.sid;
        next();
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          logger.warn({ correlationId, error: error.message }, 'Token expired');
          return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Token has expired' });
        }
        
        logger.error({ correlationId, error: redactPII({ err: error }) }, 'Authentication middleware failure');
        return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication system failure' });
      }
    };
  };
};
