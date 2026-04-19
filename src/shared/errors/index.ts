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

export class ValidationError extends DomainError {
  constructor(message: string, details: any = null) {
    super(400, 'VALIDATION_FAILED', message, details);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string = 'Not Found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details: any = null) {
    super(409, 'CONFLICT', message, details);
    this.name = 'ConflictError';
  }
}

export class ServiceUnavailableError extends DomainError {
  constructor(message: string = 'Service Temporarily Unavailable') {
    super(503, 'SERVICE_UNAVAILABLE', message);
    this.name = 'ServiceUnavailableError';
  }
}
