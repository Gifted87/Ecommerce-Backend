"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderValidator = exports.PaginationQuerySchema = exports.CheckoutRequestSchema = exports.ValidationError = exports.ValidationErrorCode = void 0;
const zod_1 = require("zod");
const decimal_js_1 = require("decimal.js");
/**
 * Machine-readable error codes for validation failures.
 */
var ValidationErrorCode;
(function (ValidationErrorCode) {
    ValidationErrorCode["INVALID_SKU_FORMAT"] = "INVALID_SKU_FORMAT";
    ValidationErrorCode["EXCEEDS_MAX_ITEMS"] = "EXCEEDS_MAX_ITEMS";
    ValidationErrorCode["INVALID_PAGINATION_RANGE"] = "INVALID_PAGINATION_RANGE";
    ValidationErrorCode["INVALID_DATE_RANGE"] = "INVALID_DATE_RANGE";
    ValidationErrorCode["CALCULATION_MISMATCH"] = "CALCULATION_MISMATCH";
    ValidationErrorCode["INVALID_SCHEMA"] = "INVALID_SCHEMA";
})(ValidationErrorCode || (exports.ValidationErrorCode = ValidationErrorCode = {}));
/**
 * Unified application-specific validation error.
 */
class ValidationError extends Error {
    constructor(details, correlationId) {
        super('Validation failed');
        this.details = details;
        this.correlationId = correlationId;
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
const SKU_REGEX = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;
/**
 * Zod schema for individual order items.
 */
const OrderItemSchema = zod_1.z.object({
    sku: zod_1.z.string().regex(SKU_REGEX, { message: 'Invalid SKU format' }),
    unit_price: zod_1.z.string().refine((val) => {
        try {
            const d = new decimal_js_1.Decimal(val);
            return d.isPositive() || d.isZero();
        }
        catch {
            return false;
        }
    }, { message: 'Unit price must be a non-negative decimal' }),
    quantity: zod_1.z.number().int().positive({ message: 'Quantity must be a positive integer' }),
    item_total: zod_1.z.string(),
});
/**
 * Zod schema for the checkout request body.
 */
exports.CheckoutRequestSchema = zod_1.z.object({
    items: zod_1.z.array(OrderItemSchema).min(1).max(50, { message: 'Order exceeds maximum item limit of 50' }),
    total_amount: zod_1.z.string(),
    shipping_address: zod_1.z.string(),
    payment_token: zod_1.z.string(),
});
/**
 * Zod schema for paginated queries.
 */
exports.PaginationQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100),
    from: zod_1.z.string().datetime().optional(),
    to: zod_1.z.string().datetime().optional(),
}).refine((data) => {
    if (data.from && data.to) {
        return new Date(data.from) < new Date(data.to);
    }
    return true;
}, { message: 'From date must be before to date', path: ['from'] });
/**
 * Validator class providing static methods for domain-level validation.
 */
class OrderValidator {
    /**
     * Validates checkout request payload, enforcing schema and business invariants.
     */
    static validateCheckout(payload, correlationId) {
        const result = exports.CheckoutRequestSchema.safeParse(payload);
        if (!result.success) {
            throw new ValidationError(result.error.issues.map((issue) => ({
                path: issue.path.map((p) => String(p)),
                message: issue.message,
                code: ValidationErrorCode.INVALID_SCHEMA,
            })), correlationId);
        }
        const data = result.data;
        const errors = [];
        let runningTotal = new decimal_js_1.Decimal(0);
        for (let i = 0; i < data.items.length; i++) {
            const item = data.items[i];
            const itemPath = ['items', i.toString()];
            const unitPrice = new decimal_js_1.Decimal(item.unit_price);
            const quantity = new decimal_js_1.Decimal(item.quantity);
            const itemTotal = new decimal_js_1.Decimal(item.item_total);
            if (!unitPrice.mul(quantity).equals(itemTotal)) {
                errors.push({
                    path: [...itemPath, 'item_total'],
                    message: 'Calculation mismatch: unit_price * quantity != item_total',
                    code: ValidationErrorCode.CALCULATION_MISMATCH,
                });
            }
            runningTotal = runningTotal.add(itemTotal);
        }
        if (!runningTotal.equals(new decimal_js_1.Decimal(data.total_amount))) {
            errors.push({
                path: ['total_amount'],
                message: 'Order total mismatch',
                code: ValidationErrorCode.CALCULATION_MISMATCH,
            });
        }
        if (errors.length > 0) {
            throw new ValidationError(errors, correlationId);
        }
        return data;
    }
    /**
     * Validates pagination parameters.
     */
    static validatePagination(query, correlationId) {
        const result = exports.PaginationQuerySchema.safeParse(query);
        if (!result.success) {
            throw new ValidationError(result.error.issues.map((issue) => ({
                path: issue.path.map((p) => String(p)),
                message: issue.message,
                code: ValidationErrorCode.INVALID_PAGINATION_RANGE,
            })), correlationId);
        }
        return result.data;
    }
    /**
     * Redacts sensitive data from PII-containing objects for logs.
     */
    static redactPII(data) {
        if (!data || typeof data !== 'object')
            return data;
        const redacted = { ...data };
        if ('shipping_address' in redacted)
            redacted.shipping_address = '[REDACTED]';
        if ('payment_token' in redacted)
            redacted.payment_token = '[REDACTED]';
        return redacted;
    }
}
exports.OrderValidator = OrderValidator;
