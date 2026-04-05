import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'pino';

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
 * Type guard for DomainError.
 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Order Error Mapper implementation.
 * Stateless, high-performance utility to translate domain exceptions to HTTP responses.
 */
export class OrderErrorMapper {
  constructor(private readonly logger: Logger) {}

  /**
   * Maps an error to an appropriate HTTP status code.
   */
  private mapToHttpStatus(err: any): number {
    if (isDomainError(err)) {
      return err.statusCode;
    }

    // Circuit Breaker Errors (Opossum)
    if (err.code === 'EOPENBREAKER' || err.name === 'CircuitBreakerError') {
      return 503;
    }

    // Validation/Parsing Errors
    if (err.name === 'ValidationError' || err.name === 'ZodError') {
      return 422;
    }

    // Database / Concurrency Errors
    if (err.name === 'QueryFailedError' && (err as any).code === '23505') {
      return 409;
    }
    
    // Default system error
    return 500;
  }

  /**
   * Processes the error, logs it with observability context, and returns a sanitized response.
   */
  public handle(err: any, req: Request, res: Response): void {
    const requestId = (req.headers['x-correlation-id'] as string) || uuidv4();
    const statusCode = this.mapToHttpStatus(err);
    const isInternal = statusCode >= 500;

    // Structured logging with metadata
    const logMetadata = {
      requestId,
      statusCode,
      path: req.path,
      method: req.method,
      code: isDomainError(err) ? err.appCode : 'INTERNAL_SERVER_ERROR',
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    };

    if (isInternal) {
      this.logger.error({ err, ...logMetadata }, 'Internal Server Error encountered');
    } else {
      this.logger.warn({ err, ...logMetadata }, 'Operational error occurred');
    }

    // Sanitized response for the client
    const responseBody: ApiErrorResponse = {
      status: 'error',
      error: {
        code: isInternal ? 'INTERNAL_SERVER_ERROR' : (isDomainError(err) ? err.appCode : 'OPERATION_FAILED'),
        message: isInternal ? 'An unexpected error occurred.' : (err.message || 'An error occurred.'),
        details: isInternal ? null : (isDomainError(err) ? err.details : null),
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    res.setHeader('x-correlation-id', requestId);
    res.status(statusCode).json(responseBody);
  }
}
