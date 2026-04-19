/**
 * @fileoverview Domain-driven error hierarchy for the Cart Service.
 * Provides structured, typed, and secure error handling across service boundaries.
 * Enforces traceability, semantic consistency, and PII redaction.
 */

/**
 * Interface defining the required metadata for cart service errors.
 * Ensures compatibility with structured logging systems (e.g., Pino) and distributed tracing.
 */
export interface ErrorDetails {
  readonly errorCode: string;
  readonly cartId?: string;
  readonly userId?: string;
  readonly guestId?: string;
  readonly resourceId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: string;
}

/**
 * Base abstract class for all Cart Service specific exceptions.
 * Implements standard diagnostic fields and serialization logic.
 */
export abstract class CartServiceError extends Error {
  public abstract readonly statusCode: number;
  public readonly errorCode: string;
  public readonly timestamp: string;
  public readonly details: Omit<ErrorDetails, 'timestamp' | 'errorCode'>;

  constructor(
    message: string,
    errorCode: string,
    details: Omit<ErrorDetails, 'timestamp' | 'errorCode'> = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.errorCode = errorCode;
    this.timestamp = new Date().toISOString();
    this.details = Object.freeze({ ...details });

    // Ensure the stack trace is captured correctly
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Returns a sanitized JSON representation of the error, suitable for logging
   * or API error responses, preventing PII propagation.
   */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      errorCode: this.errorCode,
      statusCode: this.statusCode,
      timestamp: this.timestamp,
      details: this.details,
    };
  }
}

/**
 * Generic cart service error, not abstract.
 */
export class CartGeneralError extends CartServiceError {
  public readonly statusCode = 500;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'CART_GENERAL_ERROR', details);
  }
}

/**
 * Thrown when a requested CartId does not exist or has expired.
 */
export class CartNotFoundError extends CartServiceError {
  public readonly statusCode = 404;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'CART_NOT_FOUND', details);
  }
}

/**
 * Thrown when the user session is no longer valid or authenticated.
 */
export class SessionExpiredError extends CartServiceError {
  public readonly statusCode = 401;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'SESSION_EXPIRED', details);
  }
}

/**
 * Thrown during version mismatches in concurrent write operations (Optimistic Locking).
 */
export class CartConcurrencyError extends CartServiceError {
  public readonly statusCode = 409;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'CART_CONCURRENCY_CONFLICT', details);
  }
}

/**
 * Thrown when cart item data fails business domain schema validation.
 */
export class CartItemValidationError extends CartServiceError {
  public readonly statusCode = 422;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'CART_ITEM_VALIDATION_FAILED', details);
  }
}

/**
 * Thrown when a session is explicitly blocked or revoked due to security policy enforcement.
 */
export class SessionRevocationError extends CartServiceError {
  public readonly statusCode = 403;

  constructor(message: string, details?: Omit<ErrorDetails, 'timestamp' | 'errorCode'>) {
    super(message, 'SESSION_REVOKED', details);
  }
}

/**
 * Type guard to safely identify and handle CartServiceError instances.
 */
export function isCartServiceError(error: unknown): error is CartServiceError {
  return error instanceof CartServiceError;
}
