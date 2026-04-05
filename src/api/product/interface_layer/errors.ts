/**
 * @fileoverview Domain-driven error hierarchy for the product and inventory interface layers.
 * Provides a strictly typed, production-ready taxonomy for high-throughput ecommerce operations.
 * Implements PII redaction and distributed tracing support via correlation IDs.
 */

/**
 * Metadata interface for error contextualization.
 */
export interface ErrorMetadata {
  [key: string]: unknown;
}

/**
 * Abstract base class for all domain-specific exceptions.
 * Enforces consistency in error reporting and observability.
 */
export abstract class AppDomainError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly errorCode: string;
  public readonly correlationId: string;
  public readonly timestamp: string;
  public readonly metadata: ErrorMetadata;

  constructor(message: string, correlationId: string, metadata: ErrorMetadata = {}) {
    super(message);
    this.name = this.constructor.name;
    this.correlationId = correlationId;
    this.metadata = metadata;
    this.timestamp = new Date().toISOString();

    // Ensure proper stack trace capture for debugging
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Serializes the error into a sanitized JSON format.
   * Redacts PII sensitive keys before propagation or logging.
   */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      correlationId: this.correlationId,
      timestamp: this.timestamp,
      metadata: this.sanitizeMetadata(this.metadata),
    };
  }

  /**
   * Sanitizes metadata to remove PII.
   * @param metadata The original metadata object.
   * @returns A new object with sensitive keys redacted.
   */
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
 * Thrown when a product or SKU is not found in the catalog.
 */
export class ProductNotFoundError extends AppDomainError {
  public readonly statusCode = 404;
  public readonly errorCode = 'PRODUCT_NOT_FOUND';

  constructor(sku: string, correlationId: string) {
    super(`Product with SKU ${sku} not found.`, correlationId, { sku });
  }
}

/**
 * Thrown when stock levels cannot satisfy a reservation attempt.
 */
export class InventoryLowError extends AppDomainError {
  public readonly statusCode = 400;
  public readonly errorCode = 'INVENTORY_LOW';

  constructor(sku: string, requested: number, available: number, correlationId: string) {
    super(`Insufficient inventory for SKU ${sku}.`, correlationId, { sku, requested, available });
  }
}

/**
 * Thrown when a distributed lock (e.g., Redis) cannot be acquired.
 */
export class ConcurrencyLockError extends AppDomainError {
  public readonly statusCode = 409;
  public readonly errorCode = 'CONCURRENCY_LOCK_FAILURE';

  constructor(resourceId: string, correlationId: string) {
    super(`Could not acquire lock for resource ${resourceId}.`, correlationId, { resourceId });
  }
}

/**
 * Thrown when data fails schema validation (e.g., after Zod processing).
 */
export class ValidationError extends AppDomainError {
  public readonly statusCode = 422;
  public readonly errorCode = 'VALIDATION_ERROR';

  constructor(errors: Array<{ path: (string | number)[]; message: string }>, correlationId: string) {
    super('Request validation failed.', correlationId, { errors });
  }
}

/**
 * Thrown for underlying database or storage layer failures.
 * Obscures original stack trace for security.
 */
export class RepositoryInternalError extends AppDomainError {
  public readonly statusCode = 500;
  public readonly errorCode = 'REPOSITORY_INTERNAL_ERROR';

  constructor(message: string, correlationId: string, originalError: unknown) {
    super(message, correlationId, {
      internalMessage: originalError instanceof Error ? originalError.message : String(originalError),
    });
  }
}

/**
 * Thrown when an RBAC/ABAC policy check fails.
 */
export class UnauthorizedAccessError extends AppDomainError {
  public readonly statusCode = 403;
  public readonly errorCode = 'UNAUTHORIZED_ACCESS';

  constructor(message: string, correlationId: string, resourceId: string) {
    super(message, correlationId, { resourceId });
  }
}

/**
 * Type guard to safely identify domain errors.
 */
export function isAppDomainError(error: unknown): error is AppDomainError {
  return error instanceof AppDomainError;
}
