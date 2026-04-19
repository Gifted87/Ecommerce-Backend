"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateInventoryMutation = exports.validateInventory = exports.validateProduct = exports.InventorySchema = exports.ProductSchema = void 0;
const zod_1 = require("zod");
/**
 * @fileoverview Product and Inventory domain schemas with strict validation logic.
 * Enforces SKU format [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID] and maintains
 * domain invariants for inventory state.
 *
 * This module serves as the primary data validation layer, ensuring integrity
 * before persistence in PostgreSQL.
 */
/**
 * SKU format: [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID]
 * Example: ELEC-LAP-001
 * Strict regex ensures no invalid characters or malformed identifiers.
 */
const skuRegex = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;
/**
 * Product Schema
 * Defines the core attributes for catalog entities.
 * Uses JSONB for metadata to allow extensibility while enforcing core fields.
 */
exports.ProductSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    sku: zod_1.z.string().regex(skuRegex, 'SKU must follow format [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID]'),
    name: zod_1.z.string().min(3, 'Product name must be at least 3 characters long'),
    price: zod_1.z.string().regex(/^\d+(\.\d{1,2})?$/, 'Price must be a valid decimal string'),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
    created_at: zod_1.z.date().default(() => new Date()),
    updated_at: zod_1.z.date().default(() => new Date()),
});
/**
 * Inventory Schema
 * Manages dynamic stock state and enforces consistency constraints.
 * Ensures total_stock >= reserved_stock at all times.
 */
exports.InventorySchema = zod_1.z
    .object({
    product_id: zod_1.z.string().uuid(),
    total_stock: zod_1.z.number().int().nonnegative(),
    reserved_stock: zod_1.z.number().int().nonnegative(),
})
    .refine((data) => data.total_stock >= data.reserved_stock, {
    message: 'Total stock must be greater than or equal to reserved stock',
    path: ['total_stock'],
})
    .transform((data) => ({
    ...data,
    available_stock: data.total_stock - data.reserved_stock,
}));
/**
 * Validates product data input using Zod safeParse for performance.
 *
 * @param data - The raw input data to validate.
 * @returns The result of the safeParse operation.
 */
const validateProduct = (data) => {
    return exports.ProductSchema.safeParse(data);
};
exports.validateProduct = validateProduct;
/**
 * Validates inventory data input using Zod safeParse for performance.
 *
 * @param data - The raw input data to validate.
 * @returns The result of the safeParse operation.
 */
const validateInventory = (data) => {
    return exports.InventorySchema.safeParse(data);
};
exports.validateInventory = validateInventory;
/**
 * Domain-specific integrity check for stock transitions.
 * Ensures the resulting inventory state is valid before performing database updates.
 *
 * @param current - The current inventory state.
 * @param totalChange - The change to be applied to total_stock (can be negative).
 * @param reservedChange - The change to be applied to reserved_stock (can be negative).
 * @returns An object containing the success status, the new inventory object, or an error message.
 */
const validateInventoryMutation = (current, totalChange, reservedChange) => {
    const nextTotal = current.total_stock + totalChange;
    const nextReserved = current.reserved_stock + reservedChange;
    // Ensure resulting stock levels are non-negative
    if (nextTotal < 0 || nextReserved < 0) {
        return { success: false, error: 'Negative stock levels are not permitted' };
    }
    // Ensure business invariant: total_stock >= reserved_stock
    if (nextTotal < nextReserved) {
        return { success: false, error: 'Cannot reserve more stock than total available' };
    }
    // Return the validated, transformed state
    return {
        success: true,
        data: {
            product_id: current.product_id,
            total_stock: nextTotal,
            reserved_stock: nextReserved,
            available_stock: nextTotal - nextReserved,
        },
    };
};
exports.validateInventoryMutation = validateInventoryMutation;
