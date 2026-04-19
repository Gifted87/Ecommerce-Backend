"use strict";
/**
 * @fileoverview Domain-driven error hierarchy for the Cart Service.
 * Provides structured, typed, and secure error handling across service boundaries.
 * Enforces traceability, semantic consistency, and PII redaction.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionRevocationError = exports.CartItemValidationError = exports.CartConcurrencyError = exports.SessionExpiredError = exports.CartNotFoundError = exports.CartServiceError = void 0;
exports.isCartServiceError = isCartServiceError;
/**
 * Base abstract class for all Cart Service specific exceptions.
 * Implements standard diagnostic fields and serialization logic.
 */
class CartServiceError extends Error {
    constructor(message, errorCode, details = {}) {
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
    toJSON() {
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
exports.CartServiceError = CartServiceError;
/**
 * Thrown when a requested CartId does not exist or has expired.
 */
class CartNotFoundError extends CartServiceError {
    constructor(message, details) {
        super(message, 'CART_NOT_FOUND', details);
        this.statusCode = 404;
    }
}
exports.CartNotFoundError = CartNotFoundError;
/**
 * Thrown when the user session is no longer valid or authenticated.
 */
class SessionExpiredError extends CartServiceError {
    constructor(message, details) {
        super(message, 'SESSION_EXPIRED', details);
        this.statusCode = 401;
    }
}
exports.SessionExpiredError = SessionExpiredError;
/**
 * Thrown during version mismatches in concurrent write operations (Optimistic Locking).
 */
class CartConcurrencyError extends CartServiceError {
    constructor(message, details) {
        super(message, 'CART_CONCURRENCY_CONFLICT', details);
        this.statusCode = 409;
    }
}
exports.CartConcurrencyError = CartConcurrencyError;
/**
 * Thrown when cart item data fails business domain schema validation.
 */
class CartItemValidationError extends CartServiceError {
    constructor(message, details) {
        super(message, 'CART_ITEM_VALIDATION_FAILED', details);
        this.statusCode = 422;
    }
}
exports.CartItemValidationError = CartItemValidationError;
/**
 * Thrown when a session is explicitly blocked or revoked due to security policy enforcement.
 */
class SessionRevocationError extends CartServiceError {
    constructor(message, details) {
        super(message, 'SESSION_REVOKED', details);
        this.statusCode = 403;
    }
}
exports.SessionRevocationError = SessionRevocationError;
/**
 * Type guard to safely identify and handle CartServiceError instances.
 */
function isCartServiceError(error) {
    return error instanceof CartServiceError;
}
