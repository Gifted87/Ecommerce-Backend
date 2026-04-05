import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'pino';

/**
 * @fileoverview Response Management Subsystem (RMS)
 * Provides standardized response formatting, centralized error mapping,
 * and structured observability for the ecommerce backend.
 */

export interface ApiResponse<T = any> {
  status: 'success' | 'error';
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta: {
    requestId: string;
    timestamp: string;
  };
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly message: string,
    public readonly details: any = null
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Maps common domain exceptions to HTTP status codes.
 */
const getStatusCode = (error: Error): number => {
  if (error instanceof AppError) {
    return error.statusCode;
  }
  return 500;
};

/**
 * Response Manager class for handling standardized API outputs.
 */
export class ResponseManager {
  constructor(private logger: Logger) {}

  /**
   * Sends a successful JSON response.
   */
  public sendSuccess<T>(res: Response, data: T, statusCode: number = 200): void {
    const requestId = (res.req as any).requestId || uuidv4();
    const response: ApiResponse<T> = {
      status: 'success',
      data,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    this.logger.info({ requestId, statusCode, data }, 'Request processed successfully');
    res.status(statusCode).json(response);
  }

  /**
   * Sends a standardized error JSON response.
   * Sanitizes error details before exposure.
   */
  public sendError(res: Response, error: Error): void {
    const requestId = (res.req as any).requestId || uuidv4();
    const statusCode = getStatusCode(error);
    
    // Log the full error internally
    this.logger.error({ requestId, statusCode, error }, 'Request failed');

    const errorResponse: ApiResponse = {
      status: 'error',
      error: {
        code: error instanceof AppError ? error.code : 'INTERNAL_SERVER_ERROR',
        message: statusCode === 500 ? 'An unexpected error occurred.' : error.message,
        details: statusCode === 500 ? null : (error instanceof AppError ? error.details : null),
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    res.status(statusCode).json(errorResponse);
  }
}
