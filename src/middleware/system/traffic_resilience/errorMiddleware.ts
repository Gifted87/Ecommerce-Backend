import { Request, Response, NextFunction } from 'express';
import createError, { HttpError } from 'http-errors';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * @fileoverview Global Error Handling Middleware for the ecommerce backend.
 * Provides centralized error sanitization, structured logging, 
 * correlation ID tracking, and production-grade security shielding.
 */

// Initialize logger instance for error handling context
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'password',
      'credit_card',
      'authorization',
      'token',
      'cookie',
      'set-cookie',
      'secret'
    ],
    censor: '[REDACTED]'
  },
  base: {
    pid: process.pid,
    service: 'ecommerce-api-gateway'
  },
  formatters: {
    level: (label: string) => ({ level: label }),
  },
});

/**
 * Global Error Handler Factory.
 * Enforces production security, structured observability, and consistent API error responses.
 */
export const globalErrorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Ensure correlation ID presence for tracing
  const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
  req.headers['x-correlation-id'] = correlationId;

  // Normalize error to HttpError
  let httpError: HttpError;
  
  if (createError.isHttpError(err)) {
    httpError = err;
  } else {
    // Default to 500 Internal Server Error for unhandled exceptions
    // Shield internal stack traces by not passing the original err to the constructor
    httpError = createError(500, 'Internal Server Error', {
      expose: false,
    });
  }

  // Structured Logging
  const logContext = {
    correlationId,
    method: req.method,
    url: req.url,
    userId: (req as any).user?.id,
    sku: (req as any).params?.sku,
    status: httpError.status,
    message: httpError.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  };

  if (httpError.status >= 500) {
    logger.error({ err, ...logContext }, 'Critical Application Exception');
  } else {
    logger.warn({ err, ...logContext }, 'Operational Error');
  }

  // Set header for traceability
  res.setHeader('x-correlation-id', correlationId);

  // Response sanitization
  const responseBody = {
    status: httpError.status,
    message: httpError.message,
    correlationId,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  res.status(httpError.status).json(responseBody);
};
