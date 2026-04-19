"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderTransitions = exports.OrderModelSchema = exports.ShippingAddressSchema = exports.OrderItemSchema = exports.OrderStatus = void 0;
const zod_1 = require("zod");
/**
 * @fileoverview Order and Checkout Domain Types.
 * Definitive source of truth for order lifecycle data structures,
 * state transition contexts, and repository persistence contracts.
 */
/**
 * Supported Order Statuses.
 */
var OrderStatus;
(function (OrderStatus) {
    OrderStatus["PENDING"] = "PENDING";
    OrderStatus["PAID"] = "PAID";
    OrderStatus["SHIPPED"] = "SHIPPED";
    OrderStatus["DELIVERED"] = "DELIVERED";
    OrderStatus["CANCELLED"] = "CANCELLED";
    OrderStatus["REFUNDED"] = "REFUNDED";
    OrderStatus["PROCESSING"] = "PROCESSING";
    OrderStatus["PLACED"] = "PLACED";
    OrderStatus["FAILED"] = "FAILED";
})(OrderStatus || (exports.OrderStatus = OrderStatus = {}));
/**
 * Zod schema for order line items.
 */
exports.OrderItemSchema = zod_1.z.object({
    sku: zod_1.z.string(),
    quantity: zod_1.z.number().int().positive(),
    unit_price: zod_1.z.string().refine((val) => !isNaN(Number(val))),
    item_total: zod_1.z.string().refine((val) => !isNaN(Number(val))),
});
/**
 * Zod schema for shipping address.
 */
exports.ShippingAddressSchema = zod_1.z.object({
    street: zod_1.z.string(),
    city: zod_1.z.string(),
    postal_code: zod_1.z.string(),
    country: zod_1.z.string().length(2), // ISO 3166-1 alpha-2
});
/**
 * Zod schema for the Order model.
 */
exports.OrderModelSchema = zod_1.z.object({
    order_id: zod_1.z.string().uuid(),
    user_id: zod_1.z.string().uuid(),
    status: zod_1.z.nativeEnum(OrderStatus),
    items: zod_1.z.array(exports.OrderItemSchema),
    shipping_address: exports.ShippingAddressSchema,
    total_amount: zod_1.z.string().refine((val) => !isNaN(Number(val))),
    version: zod_1.z.number().int().nonnegative().optional(),
    correlation_id: zod_1.z.string().uuid().optional(),
    tracking_number: zod_1.z.string().optional(),
    created_at: zod_1.z.string().optional(),
    updated_at: zod_1.z.string().optional(),
});
/**
 * State Transition Map.
 */
exports.OrderTransitions = {
    [OrderStatus.PENDING]: [OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.PROCESSING, OrderStatus.FAILED],
    [OrderStatus.PROCESSING]: [OrderStatus.PLACED, OrderStatus.CANCELLED, OrderStatus.FAILED],
    [OrderStatus.PLACED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.FAILED],
    [OrderStatus.PAID]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.FAILED],
    [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.REFUNDED],
    [OrderStatus.DELIVERED]: [OrderStatus.REFUNDED],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.REFUNDED]: [],
    [OrderStatus.FAILED]: [OrderStatus.PENDING], // Allow retry by transitioning back to PENDING if applicable
};
