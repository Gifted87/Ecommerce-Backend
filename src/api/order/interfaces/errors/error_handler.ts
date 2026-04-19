import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import createError, { HttpError } from 'http-errors';

/**
 * Base class for all domain-specific errors.
 */
export class DomainError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly appCode: string,
    public readonly message: string,
    public readonly details: any = null
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Logger configuration for the error handler.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['password', 'credit_card', 'authorization', 'token', 'cookie', 'secret', 'email'],
    censor: '[REDACTED]'
  },
  base: { service: 'order-api-interface' },
});

/**
 * Maps common domain error types and codes to HTTP status codes.
 */
const mapToHttpStatus = (error: any): number => {
  if (error instanceof DomainError) {
    return error.statusCode;
  }
  
  if (error.code === 'EOPENBREAKER' || error.name === 'CircuitBreakerError') {
    return 503;
  }

  // Handle common external library errors
  if (error.name === 'ValidationError' || error.name === 'ZodError') {
    return 400;
  }

  return 500;
};

/**
 * Standardized error response interface.
 */
interface ApiErrorResponse {
  status: 'error';
  error: {
    code: string;
    message: string;
    details?: any;
  };
  meta: {
    requestId: string;
    timestamp: string;
  };
}

/**
 * Global Error Handler for the Order API.
 * Ensures consistent error formatting, observability, and security shielding.
 */
export const handleDomainError = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = (req.headers['x-correlation-id'] as string) || uuidv4();
  const statusCode = mapToHttpStatus(err);
  
  // Security Masking: For 500 errors, hide internal details from client
  const isInternal = statusCode >= 500;
  
  const errorPayload: ApiErrorResponse = {
    status: 'error',
    error: {
      code: isInternal ? 'INTERNAL_SERVER_ERROR' : (err.appCode || 'OPERATION_FAILED'),
      message: isInternal ? 'An unexpected error occurred.' : (err.message || 'An error occurred.'),
      details: isInternal ? null : (err instanceof DomainError ? err.details : null),
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  };

  // Structured Logging
  const logMetadata = {
    requestId,
    statusCode,
    path: req.path,
    method: req.method,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    body: req.body,
  };

  if (isInternal) {
    logger.error({ err, ...logMetadata }, 'Internal Server Error encountered');
  } else {
    logger.warn({ err, ...logMetadata }, 'Operational error occurred');
  }

  res.setHeader('x-correlation-id', requestId);
  res.status(statusCode).json(errorPayload);
};
