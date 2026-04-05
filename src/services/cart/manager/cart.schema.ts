import { z } from 'zod';

/**
 * @fileoverview Schema definitions for shopping cart operations.
 * Enforces strict domain invariants for cart mutations within the ecommerce backend.
 */

/**
 * Shared CartItem schema for common validations.
 */
export const CartItemSchema = z.object({
  productId: z.string().uuid('Product ID must be a valid UUID v4'),
  quantity: z.number().int().min(0, 'Quantity cannot be negative'),
  variantId: z.string().optional(),
});

/**
 * AddToCartSchema
 * Validates the addition of items to a cart.
 * Requires: productId (UUID), quantity (>= 1).
 */
export const AddToCartSchema = z.object({
  productId: z.string().uuid('Product ID must be a valid UUID v4'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
  variantId: z.string().optional(),
});

/**
 * UpdateQuantitySchema
 * Validates updates to item quantities in the cart.
 * Allows quantity 0, which the service layer translates to removal.
 */
export const UpdateQuantitySchema = z.object({
  productId: z.string().uuid('Product ID must be a valid UUID v4'),
  quantity: z.number().int().min(0, 'Quantity cannot be negative'),
});

/**
 * RemoveItemSchema
 * Validates the removal of an item from the cart.
 */
export const RemoveItemSchema = z.object({
  productId: z.string().uuid('Product ID must be a valid UUID v4'),
});

/**
 * Type inference for validated schemas.
 */
export type CartItem = z.infer<typeof CartItemSchema>;
export type AddToCartRequest = z.infer<typeof AddToCartSchema>;
export type UpdateQuantityRequest = z.infer<typeof UpdateQuantitySchema>;
export type RemoveItemRequest = z.infer<typeof RemoveItemSchema>;

/**
 * Utility function to validate AddToCart payloads.
 */
export const validateAddToCart = (data: unknown) => AddToCartSchema.safeParse(data);

/**
 * Utility function to validate UpdateQuantity payloads.
 */
export const validateUpdateQuantity = (data: unknown) => UpdateQuantitySchema.safeParse(data);

/**
 * Utility function to validate RemoveItem payloads.
 */
export const validateRemoveItem = (data: unknown) => RemoveItemSchema.safeParse(data);
