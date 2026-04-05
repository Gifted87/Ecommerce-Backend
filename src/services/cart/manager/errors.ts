/**
 * Production-ready error hierarchy for Cart and Session management.
 * Provides structured, typed, and secure error handling across service boundaries.
 */

export interface ErrorDetails {
  errorCode: string;
  cartId?: string;
  userId?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export abstract class CartServiceError extends Error {
  public abstract readonly statusCode: number;
  public readonly errorCode: string;
  public readonly timestamp: string;
  public readonly details: Omit<ErrorDetails, 'timestamp' | 'errorCode'>;

  constructor(message: string, errorCode: string, details: Omit<ErrorDetails, 'timestamp' | 'errorCode'> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.errorCode = errorCode;
    this.timestamp = new Date().toISOString();
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      errorCode: this.errorCode,
      timestamp: this.timestamp,
    };
  }
}

export class CartNotFoundError extends CartServiceError {
  public readonly statusCode = 404;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'CART_NOT_FOUND', details);
  }
}

export class SessionExpiredError extends CartServiceError {
  public readonly statusCode = 401;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'SESSION_EXPIRED', details);
  }
}

export class CartConcurrencyError extends CartServiceError {
  public readonly statusCode = 409;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'CART_CONCURRENCY_CONFLICT', details);
  }
}

export class CartItemValidationError extends CartServiceError {
  public readonly statusCode = 422;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'CART_ITEM_VALIDATION_FAILED', details);
  }
}

export class SessionRevocationError extends CartServiceError {
  public readonly statusCode = 403;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'SESSION_REVOKED', details);
  }
}

/**
 * Type guard for safe error handling in service and controller layers.
 */
export function isCartServiceError(error: unknown): error is CartServiceError {
  return error instanceof CartServiceError;
}
