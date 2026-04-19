"use strict";
/**
 * @fileoverview Internal contract definitions for the Cart Service.
 * This module defines the domain models, state machine, and communication contracts
 * for the high-concurrency Shopping Cart management system.
 *
 * Financial fields are strictly typed as bigint to ensure precision.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CartConcurrencyError = exports.CartServiceError = exports.CartStatus = void 0;
exports.isCart = isCart;
exports.isCartItem = isCartItem;
/**
 * Supported Cart lifecycle states.
 */
var CartStatus;
(function (CartStatus) {
    /** Initial state for guest users or brand new sessions. */
    CartStatus["ACTIVE"] = "ACTIVE";
    /** Cart is transitioning to order completion. */
    CartStatus["PENDING_CHECKOUT"] = "PENDING_CHECKOUT";
    /** Cart has been successfully converted to an order. */
    CartStatus["PURCHASED"] = "PURCHASED";
    /** Cart has reached its expiry TTL without action. */
    CartStatus["ABANDONED"] = "ABANDONED";
})(CartStatus || (exports.CartStatus = CartStatus = {}));
/**
 * Custom error class for Cart Service operations.
 */
class CartServiceError extends Error {
    constructor(message, code, correlationId, originalError) {
        super(`${message} (Correlation ID: ${correlationId})`);
        this.message = message;
        this.code = code;
        this.correlationId = correlationId;
        this.originalError = originalError;
        this.name = 'CartServiceError';
    }
}
exports.CartServiceError = CartServiceError;
/**
 * Error thrown when a concurrency conflict (version mismatch) is detected.
 */
class CartConcurrencyError extends CartServiceError {
    constructor(correlationId, cartId, expectedVersion) {
        const message = cartId && expectedVersion !== undefined ? `Concurrency violation for cart ${cartId}: Expected version ${expectedVersion}` : 'Cart version mismatch detected.';
        super(message, 'CONCURRENCY_ERROR', correlationId);
        this.name = 'CartConcurrencyError';
    }
}
exports.CartConcurrencyError = CartConcurrencyError;
/**
 * Type guard for Cart entity.
 */
function isCart(obj) {
    return (typeof obj === 'object' &&
        obj !== null &&
        typeof obj.cartId === 'string' &&
        Array.isArray(obj.items) &&
        typeof obj.summary === 'object' &&
        typeof obj.status === 'string' &&
        typeof obj.lockId === 'string' &&
        typeof obj.version === 'number');
}
/**
 * Type guard for CartItem entity.
 */
function isCartItem(obj) {
    return (typeof obj === 'object' &&
        obj !== null &&
        typeof obj.productId === 'string' &&
        typeof obj.sku === 'string' &&
        typeof obj.quantity === 'number' &&
        typeof obj.pricePerUnit === 'bigint');
}
