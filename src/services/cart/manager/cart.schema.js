"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRemoveItem = exports.validateUpdateQuantity = exports.validateAddToCart = exports.RemoveItemSchema = exports.UpdateQuantitySchema = exports.AddToCartSchema = exports.CartItemSchema = void 0;
const zod_1 = require("zod");
/**
 * @fileoverview Schema definitions for shopping cart operations.
 * Enforces strict domain invariants for cart mutations within the ecommerce backend.
 */
/**
 * Shared CartItem schema for common validations.
 */
exports.CartItemSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid('Product ID must be a valid UUID v4'),
    quantity: zod_1.z.number().int().min(0, 'Quantity cannot be negative'),
    variantId: zod_1.z.string().optional(),
});
/**
 * AddToCartSchema
 * Validates the addition of items to a cart.
 * Requires: productId (UUID), quantity (>= 1).
 */
exports.AddToCartSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid('Product ID must be a valid UUID v4'),
    quantity: zod_1.z.number().int().min(1, 'Quantity must be at least 1'),
    variantId: zod_1.z.string().optional(),
});
/**
 * UpdateQuantitySchema
 * Validates updates to item quantities in the cart.
 * Allows quantity 0, which the service layer translates to removal.
 */
exports.UpdateQuantitySchema = zod_1.z.object({
    productId: zod_1.z.string().uuid('Product ID must be a valid UUID v4'),
    quantity: zod_1.z.number().int().min(0, 'Quantity cannot be negative'),
});
/**
 * RemoveItemSchema
 * Validates the removal of an item from the cart.
 */
exports.RemoveItemSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid('Product ID must be a valid UUID v4'),
});
/**
 * Utility function to validate AddToCart payloads.
 */
const validateAddToCart = (data) => exports.AddToCartSchema.safeParse(data);
exports.validateAddToCart = validateAddToCart;
/**
 * Utility function to validate UpdateQuantity payloads.
 */
const validateUpdateQuantity = (data) => exports.UpdateQuantitySchema.safeParse(data);
exports.validateUpdateQuantity = validateUpdateQuantity;
/**
 * Utility function to validate RemoveItem payloads.
 */
const validateRemoveItem = (data) => exports.RemoveItemSchema.safeParse(data);
exports.validateRemoveItem = validateRemoveItem;
