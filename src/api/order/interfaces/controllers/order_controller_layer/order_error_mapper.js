"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderErrorMapper = exports.DomainError = void 0;
exports.isDomainError = isDomainError;
const uuid_1 = require("uuid");
/**
 * Base class for all domain-specific errors.
 */
class DomainError extends Error {
    constructor(statusCode, appCode, message, details = null) {
        super(message);
        this.statusCode = statusCode;
        this.appCode = appCode;
        this.message = message;
        this.details = details;
        Object.setPrototypeOf(this, new.target.prototype);
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.DomainError = DomainError;
/**
 * Type guard for DomainError.
 */
function isDomainError(error) {
    return error instanceof DomainError;
}
/**
 * Order Error Mapper implementation.
 * Stateless, high-performance utility to translate domain exceptions to HTTP responses.
 */
class OrderErrorMapper {
    constructor(logger) {
        this.logger = logger;
    }
    /**
     * Maps an error to an appropriate HTTP status code.
     */
    mapToHttpStatus(err) {
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
        if (err.name === 'QueryFailedError' && err.code === '23505') {
            return 409;
        }
        // Default system error
        return 500;
    }
    /**
     * Processes the error, logs it with observability context, and returns a sanitized response.
     */
    handle(err, req, res) {
        const requestId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
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
        }
        else {
            this.logger.warn({ err, ...logMetadata }, 'Operational error occurred');
        }
        // Sanitized response for the client
        const responseBody = {
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
exports.OrderErrorMapper = OrderErrorMapper;
