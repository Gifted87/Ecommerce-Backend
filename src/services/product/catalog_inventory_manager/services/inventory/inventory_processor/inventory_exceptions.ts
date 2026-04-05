/**
 * Inventory service exception hierarchy.
 * Provides structured, typed, and secure error handling for high-concurrency inventory operations.
 */

export interface ErrorMetadata {
  [key: string]: unknown;
}

/**
 * Base abstract class for all inventory service related errors.
 */
export abstract class InventoryServiceError extends Error {
  public abstract readonly statusCode: number;
  public readonly errorCode: string;
  public readonly correlationId: string;
  public readonly metadata: ErrorMetadata;
  public readonly timestamp: string;

  constructor(
    message: string,
    errorCode: string,
    correlationId: string,
    metadata: ErrorMetadata = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.errorCode = errorCode;
    this.correlationId = correlationId;
    this.metadata = metadata;
    this.timestamp = new Date().toISOString();

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Serializes the error for safe JSON logging, masking sensitive metadata.
   */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      errorCode: this.errorCode,
      correlationId: this.correlationId,
      timestamp: this.timestamp,
      metadata: this.sanitizeMetadata(this.metadata),
    };
  }

  private sanitizeMetadata(metadata: ErrorMetadata): ErrorMetadata {
    const sensitiveKeys = ['password', 'token', 'authorization', 'secret', 'creditCard'];
    const sanitized: ErrorMetadata = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

/**
 * Thrown when a request demands more items than are currently available.
 */
export class InsufficientStockError extends InventoryServiceError {
  public readonly statusCode = 400;

  constructor(
    productId: string,
    requestedAmount: number,
    correlationId: string,
    message = 'Insufficient stock for requested product'
  ) {
    super(message, 'INSUFFICIENT_STOCK', correlationId, { productId, requestedAmount });
  }
}

/**
 * Thrown when a database or cache lock cannot be acquired within the time limit.
 */
export class ConcurrencyLockError extends InventoryServiceError {
  public readonly statusCode = 409;

  constructor(
    productId: string,
    correlationId: string,
    message = 'Could not acquire lock for inventory update'
  ) {
    super(message, 'CONCURRENCY_LOCK_CONFLICT', correlationId, { productId });
  }
}

/**
 * Wrapper for database-level repository errors.
 */
export class RepositoryError extends InventoryServiceError {
  public readonly statusCode = 500;

  constructor(
    originalError: unknown,
    correlationId: string,
    isTransient: boolean,
    message = 'Database repository operation failed'
  ) {
    super(message, 'REPOSITORY_ERROR', correlationId, {
      isTransient,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
    });
  }
}

/**
 * Aggregated validation errors for schema mismatches.
 */
export class ValidationError extends InventoryServiceError {
  public readonly statusCode = 422;

  constructor(
    errors: { path: string[]; message: string }[],
    correlationId: string,
    message = 'Validation failed'
  ) {
    super(message, 'VALIDATION_ERROR', correlationId, { errors });
  }
}

/**
 * Type guard to verify if an error is an InventoryServiceError.
 */
export function isInventoryServiceError(error: unknown): error is InventoryServiceError {
  return error instanceof InventoryServiceError;
}
