"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseOrderRequest = exports.validateStateTransition = exports.OrderModelSchema = exports.OrderRequestSchema = exports.ShippingAddressSchema = exports.OrderItemSchema = exports.OrderTransitions = exports.OrderStatus = void 0;
const zod_1 = require("zod");
/**
 * @fileoverview Order and Checkout Domain Schemas.
 * Acts as the single source of truth for order lifecycle and validation.
 */
/**
 * Supported Order States
 */
var OrderStatus;
(function (OrderStatus) {
    OrderStatus["PENDING"] = "PENDING";
    OrderStatus["PAID"] = "PAID";
    OrderStatus["SHIPPED"] = "SHIPPED";
    OrderStatus["DELIVERED"] = "DELIVERED";
    OrderStatus["CANCELLED"] = "CANCELLED";
    OrderStatus["REFUNDED"] = "REFUNDED";
})(OrderStatus || (exports.OrderStatus = OrderStatus = {}));
/**
 * Valid state transitions mapping
 */
exports.OrderTransitions = {
    [OrderStatus.PENDING]: [OrderStatus.PAID, OrderStatus.CANCELLED],
    [OrderStatus.PAID]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
    [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
    [OrderStatus.DELIVERED]: [],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.REFUNDED]: [],
};
/**
 * Zod schema for an individual Order Item
 */
exports.OrderItemSchema = zod_1.z.object({
    sku: zod_1.z.string().min(1, 'SKU is required'),
    quantity: zod_1.z.number().int().positive('Quantity must be a positive integer'),
    unit_price: zod_1.z.string().regex(/^\d+(\.\d{1,2})?$/, 'Unit price must be a valid decimal string'),
    item_total: zod_1.z.string().regex(/^\d+(\.\d{1,2})?$/, 'Item total must be a valid decimal string'),
});
/**
 * Zod schema for shipping information
 * Separated to handle potential PII in a dedicated security context
 */
exports.ShippingAddressSchema = zod_1.z.object({
    street: zod_1.z.string().min(1, 'Street is required'),
    city: zod_1.z.string().min(1, 'City is required'),
    postal_code: zod_1.z.string().min(1, 'Postal code is required'),
    country: zod_1.z.string().length(2, 'Use ISO 3166-1 alpha-2 country code'),
});
/**
 * Zod schema for initial Order Request
 */
exports.OrderRequestSchema = zod_1.z.object({
    user_id: zod_1.z.string().uuid('Invalid user ID format'),
    items: zod_1.z.array(exports.OrderItemSchema).min(1, 'Order must contain at least one item'),
    shipping_address: exports.ShippingAddressSchema,
    payment_token: zod_1.z.string().min(1, 'Payment token is required'),
});
/**
 * Zod schema for internal persistence Order Model
 */
exports.OrderModelSchema = zod_1.z.object({
    order_id: zod_1.z.string().uuid(),
    user_id: zod_1.z.string().uuid(),
    status: zod_1.z.nativeEnum(OrderStatus),
    items: zod_1.z.array(exports.OrderItemSchema),
    shipping_address: exports.ShippingAddressSchema,
    total_amount: zod_1.z.string().regex(/^\d+(\.\d{1,2})?$/),
    tracking_number: zod_1.z.string().optional(),
    created_at: zod_1.z.date(),
    updated_at: zod_1.z.date(),
});
/**
 * Validates a state transition.
 * @param currentStatus The current order status.
 * @param nextStatus The intended target status.
 * @param context Additional context required for specific transitions (e.g., tracking number for SHIPPED).
 * @returns { valid: boolean, error?: string }
 */
const validateStateTransition = (currentStatus, nextStatus, context) => {
    const allowed = exports.OrderTransitions[currentStatus];
    if (!allowed.includes(nextStatus)) {
        return {
            valid: false,
            error: `INVALID_TRANSITION: Cannot transition from ${currentStatus} to ${nextStatus}`,
        };
    }
    if (nextStatus === OrderStatus.SHIPPED) {
        if (!context?.tracking_number || context.tracking_number.trim().length === 0) {
            return {
                valid: false,
                error: 'MISSING_FULFILLMENT_INFO: SHIPPED state requires a tracking number',
            };
        }
    }
    return { valid: true };
};
exports.validateStateTransition = validateStateTransition;
/**
 * Helper to safely parse OrderRequest
 */
const parseOrderRequest = (data) => {
    return exports.OrderRequestSchema.safeParse(data);
};
exports.parseOrderRequest = parseOrderRequest;
