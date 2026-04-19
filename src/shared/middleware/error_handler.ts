import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { DomainError } from '../errors/index';
import logger from '../logger';

/**
 * Standardized API Error Response structure.
 */
export interface ApiErrorResponse {
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
 * Maps common error types to HTTP status codes.
 */
const mapToHttpStatus = (error: any): number => {
  if (error instanceof DomainError) {
    return error.statusCode;
  }
  
  if (error instanceof z.ZodError) {
    return 400;
  }

  // Handle common external library errors
  if (error.name === 'ValidationError' || error.name === 'ZodError') {
    return 400;
  }

  // Circuit Breaker Errors
  if (error.code === 'EOPENBREAKER' || error.name === 'CircuitBreakerError') {
    return 503;
  }

  // Database / Concurrency Errors (PostgreSQL)
  if (error.code === '23505') { // unique_violation
    return 409;
  }
  
  if (error.code === '40P01') { // deadlock_detected
    return 409;
  }

  return 500;
};

/**
 * Global Error Handler for the entire application.
 * Ensures consistent error formatting, observability, and security shielding.
 */
export const handleGlobalError = (
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
      code: isInternal ? 'INTERNAL_SERVER_ERROR' : (err.appCode || (err instanceof z.ZodError ? 'VALIDATION_FAILED' : 'OPERATION_FAILED')),
      message: isInternal ? 'An unexpected error occurred.' : (err.message || 'An error occurred.'),
      details: isInternal ? null : (err instanceof z.ZodError ? err.format() : (err instanceof DomainError ? err.details : null)),
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  };

  // Structured Logging with hierarchical context
  const logMetadata = {
    requestId,
    statusCode,
    path: req.path,
    method: req.method,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    body: (statusCode === 400 || statusCode === 422) ? req.body : undefined, // Log body only for validation errors to aid debugging
  };

  if (isInternal) {
    logger.error({ err, ...logMetadata }, 'Internal Server Error encountered');
  } else {
    logger.warn({ err, ...logMetadata }, 'Operational error occurred');
  }

  res.setHeader('x-correlation-id', requestId);
  res.status(statusCode).json(errorPayload);
};
