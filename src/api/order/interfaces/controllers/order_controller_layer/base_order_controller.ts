import { Request, Response } from 'express';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * Custom error types for mapping to HTTP status codes.
 */
export class DomainConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'DomainConflictError'; }
}
export class InvalidStateError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidStateError'; }
}
export class ResourceNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'ResourceNotFoundError'; }
}

/**
 * BaseOrderController provides the standard request-response lifecycle,
 * observability, and error handling for all order-related controllers.
 */
export abstract class BaseOrderController {
  constructor(protected readonly logger: Logger) {}

  /**
   * Generates or extracts a correlation ID for request tracing.
   */
  protected getCorrelationId(req: Request): string {
    return (req.headers['x-correlation-id'] as string) || uuidv4();
  }

  /**
   * Constructs a standardized success response.
   */
  protected sendSuccess<T>(res: Response, data: T, traceId: string): void {
    res.status(200).json({
      data,
      meta: {
        trace_id: traceId,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Centralized error handling and mapping.
   */
  protected handleError(error: unknown, res: Response, traceId: string): void {
    const status = this.mapErrorToStatus(error);
    const message = this.sanitizeErrorMessage(error);

    this.logger.error({
      err: error,
      trace_id: traceId,
      status,
    }, 'Request failed');

    res.status(status).json({
      error_code: this.mapErrorToCode(error),
      message,
      trace_id: traceId,
    });
  }

  private mapErrorToStatus(error: unknown): number {
    if (error instanceof DomainConflictError) return 409;
    if (error instanceof InvalidStateError) return 422;
    if (error instanceof ResourceNotFoundError) return 404;
    return 500;
  }

  private mapErrorToCode(error: unknown): string {
    if (error instanceof DomainConflictError) return 'CONFLICT';
    if (error instanceof InvalidStateError) return 'INVALID_STATE';
    if (error instanceof ResourceNotFoundError) return 'NOT_FOUND';
    return 'INTERNAL_SERVER_ERROR';
  }

  private sanitizeErrorMessage(error: unknown): string {
    if (error instanceof DomainConflictError || 
        error instanceof InvalidStateError || 
        error instanceof ResourceNotFoundError) {
      return (error as Error).message;
    }
    return 'An unexpected error occurred.';
  }

  /**
   * Log the entry of a handler.
   */
  protected logEntry(method: string, traceId: string, req: Request): void {
    this.logger.info({
      method,
      trace_id: traceId,
      url: req.originalUrl,
    }, 'Request started');
  }

  /**
   * Log the exit of a handler with duration.
   */
  protected logExit(method: string, traceId: string, startTime: number): void {
    const duration = Date.now() - startTime;
    this.logger.info({
      method,
      trace_id: traceId,
      duration_ms: duration,
    }, 'Request finished');
  }

  /**
   * Hook for resource cleanup in finally blocks.
   */
  protected abstract cleanup(): Promise<void>;
}
