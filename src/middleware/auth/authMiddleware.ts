import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * Interface representing the payload structure of our system's JWTs.
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

/**
 * Extends the Express Request object to include user and session information.
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
 * Redacts PII from logging payloads to prevent sensitive information leakage.
 */
const redactPII = (data: Record<string, any>): Record<string, any> => {
  const sensitiveKeys = ['email', 'password', 'token', 'mfa_secret', 'authorization'];
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
 * Creates the authentication middleware factory.
 * Provides a high-performance, security-critical gateway for the ecommerce backend.
 * 
 * @param redis - The pre-initialized ioredis client.
 * @param logger - The pre-configured pino logger instance.
 */
export const createAuthMiddleware = (redis: Redis, logger: Logger) => {
  return (options: AuthMiddlewareOptions = {}) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
      const authHeader = req.headers.authorization;

      // 1. Header Extraction & Sanitization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn({ correlationId, path: req.path }, 'Missing or invalid Authorization header');
        return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }

      const token = authHeader.split(' ')[1];

      try {
        // 2. JWT Validation
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
          throw new Error('JWT_SECRET is not configured');
        }

        const decoded = jwt.verify(token, jwtSecret) as TokenPayload;

        // 3. Session State Verification
        const sessionKey = `session:${decoded.sid}`;
        const sessionExists = await redis.exists(sessionKey);
        
        if (!sessionExists) {
          logger.warn({ correlationId, userId: decoded.sub, sid: decoded.sid }, 'Session expired or revoked');
          return res.status(401).json({ code: 'SESSION_EXPIRED', message: 'Session no longer valid' });
        }

        // 4. MFA Requirement Enforcement
        if (options.mfaRequired && !decoded.mfa_verified) {
          const mfaStatus = await redis.get(`mfa:status:${decoded.sub}`);
          if (mfaStatus !== 'VERIFIED') {
            logger.warn({ correlationId, userId: decoded.sub }, 'MFA verification required for this route');
            return res.status(403).json({ code: 'MFA_REQUIRED', message: 'MFA verification is required' });
          }
        }

        // 5. RBAC/ABAC Scope Check
        if (options.requiredRoles && options.requiredRoles.length > 0) {
          const hasRole = options.requiredRoles.every((role) => decoded.roles.includes(role));
          if (!hasRole) {
            logger.warn({ 
              correlationId, 
              userId: decoded.sub, 
              requiredRoles: options.requiredRoles,
              userRoles: decoded.roles 
            }, 'Insufficient permissions');
            return res.status(403).json({ code: 'FORBIDDEN', message: 'You do not have the required permissions' });
          }
        }

        // 6. Attach context and proceed
        req.user = decoded;
        req.session_id = decoded.sid;
        next();
      } catch (error: any) {
        if (error instanceof jwt.TokenExpiredError) {
          logger.warn({ correlationId, error: error.message }, 'Token expired');
          return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Token has expired' });
        }
        
        if (error instanceof jwt.JsonWebTokenError) {
          logger.warn({ correlationId, error: error.message }, 'Invalid token');
          return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Invalid token' });
        }

        // Log unexpected errors and return generic 500
        logger.error({ correlationId, error: redactPII({ err: error }) }, 'Authentication middleware failure');
        return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication system failure' });
      }
    };
  };
};
