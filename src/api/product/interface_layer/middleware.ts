import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import createError, { HttpError } from 'http-errors';

/**
 * @fileoverview Middleware suite for the product/inventory API.
 * Includes authentication (JWT+RBAC+MFA), request tracking, and global error handling.
 */

/**
 * Interface representing the payload structure of system JWTs.
 */
export interface TokenPayload {
  sub: string;
  email: string;
  roles: string[];
  mfa_verified: boolean;
  exp: number;
  jti: string;
  sid: string;
}

/**
 * Middleware options for fine-grained route control.
 */
export interface AuthMiddlewareOptions {
  mfaRequired?: boolean;
  requiredRoles?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      session_id?: string;
      correlationId?: string;
    }
  }
}

/**
 * Utility to redact PII from logging payloads.
 */
const redactPII = (data: Record<string, any>): Record<string, any> => {
  const sensitiveKeys = ['email', 'password', 'token', 'mfa_secret', 'authorization', 'cookie'];
  const redacted = { ...data };
  for (const key in redacted) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactPII(redacted[key]);
    }
  }
  return redacted;
};

/**
 * Middleware to generate or attach a Request-ID for tracing.
 */
export const correlationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers['x-request-id'] as string) || uuidv4();
  req.correlationId = correlationId;
  res.setHeader('x-request-id', correlationId);
  next();
};

/**
 * Factory for Authentication Middleware.
 * 
 * @param redis - Redis client instance.
 * @param logger - Pino logger instance.
 */
export const createAuthMiddleware = (redis: Redis, logger: Logger) => {
  return (options: AuthMiddlewareOptions = {}) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = req.correlationId || 'unknown';
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn({ correlationId, path: req.path }, 'Missing or invalid Authorization header');
        return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }

      const token = authHeader.split(' ')[1];

      try {
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) throw new Error('JWT_SECRET not configured');

        const decoded = jwt.verify(token, jwtSecret) as TokenPayload;

        // Verify session in Redis
        const sessionExists = await redis.exists(`session:${decoded.sid}`);
        if (!sessionExists) {
          logger.warn({ correlationId, userId: decoded.sub }, 'Session expired or revoked');
          return res.status(401).json({ code: 'SESSION_EXPIRED', message: 'Session no longer valid' });
        }

        // MFA Enforcement
        if (options.mfaRequired && !decoded.mfa_verified) {
          const mfaStatus = await redis.get(`mfa:status:${decoded.sub}`);
          if (mfaStatus !== 'VERIFIED') {
            logger.warn({ correlationId, userId: decoded.sub }, 'MFA required');
            return res.status(403).json({ code: 'MFA_REQUIRED', message: 'MFA verification required' });
          }
        }

        // RBAC Enforcement
        if (options.requiredRoles && options.requiredRoles.length > 0) {
          const hasRole = options.requiredRoles.every((role) => decoded.roles.includes(role));
          if (!hasRole) {
            logger.warn({ correlationId, userId: decoded.sub, requiredRoles: options.requiredRoles }, 'Forbidden');
            return res.status(403).json({ code: 'FORBIDDEN', message: 'Insufficient permissions' });
          }
        }

        req.user = decoded;
        req.session_id = decoded.sid;
        next();
      } catch (error: any) {
        logger.error({ correlationId, error: redactPII({ err: error }) }, 'Auth verification failed');
        return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
      }
    };
  };
};

/**
 * Global Error Handler for production-grade sanitization and observability.
 */
export const globalErrorMiddleware = (logger: Logger) => {
  return (err: any, req: Request, res: Response, next: NextFunction): void => {
    const correlationId = req.correlationId || 'unknown';
    
    let httpError: HttpError;
    if (createError.isHttpError(err)) {
      httpError = err;
    } else {
      httpError = createError(500, 'Internal Server Error', { expose: false });
    }

    const logContext = {
      correlationId,
      method: req.method,
      url: req.url,
      userId: req.user?.sub,
      status: httpError.status,
    };

    if (httpError.status >= 500) {
      logger.error({ ...logContext, err }, 'Critical System Error');
    } else {
      logger.warn({ ...logContext, err }, 'Operational Exception');
    }

    res.status(httpError.status).json({
      status: httpError.status,
      message: httpError.expose ? httpError.message : 'Internal Server Error',
      correlationId,
    });
  };
};
