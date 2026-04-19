"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDomainError = exports.DomainError = void 0;
const uuid_1 = require("uuid");
const pino_1 = __importDefault(require("pino"));
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
 * Logger configuration for the error handler.
 */
const logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
        paths: ['password', 'credit_card', 'authorization', 'token', 'cookie', 'secret', 'email'],
        censor: '[REDACTED]'
    },
    base: { service: 'order-api-interface' },
});
/**
 * Maps common domain error types and codes to HTTP status codes.
 */
const mapToHttpStatus = (error) => {
    if (error instanceof DomainError) {
        return error.statusCode;
    }
    if (error.code === 'EOPENBREAKER' || error.name === 'CircuitBreakerError') {
        return 503;
    }
    // Handle common external library errors
    if (error.name === 'ValidationError' || error.name === 'ZodError') {
        return 400;
    }
    return 500;
};
/**
 * Global Error Handler for the Order API.
 * Ensures consistent error formatting, observability, and security shielding.
 */
const handleDomainError = (err, req, res, _next) => {
    const requestId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
    const statusCode = mapToHttpStatus(err);
    // Security Masking: For 500 errors, hide internal details from client
    const isInternal = statusCode >= 500;
    const errorPayload = {
        status: 'error',
        error: {
            code: isInternal ? 'INTERNAL_SERVER_ERROR' : (err.appCode || 'OPERATION_FAILED'),
            message: isInternal ? 'An unexpected error occurred.' : (err.message || 'An error occurred.'),
            details: isInternal ? null : (err instanceof DomainError ? err.details : null),
        },
        meta: {
            requestId,
            timestamp: new Date().toISOString(),
        },
    };
    // Structured Logging
    const logMetadata = {
        requestId,
        statusCode,
        path: req.path,
        method: req.method,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
        body: req.body,
    };
    if (isInternal) {
        logger.error({ err, ...logMetadata }, 'Internal Server Error encountered');
    }
    else {
        logger.warn({ err, ...logMetadata }, 'Operational error occurred');
    }
    res.setHeader('x-correlation-id', requestId);
    res.status(statusCode).json(errorPayload);
};
exports.handleDomainError = handleDomainError;
