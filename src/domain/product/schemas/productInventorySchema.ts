import { z } from 'zod';

/**
 * @fileoverview Product and Inventory domain schemas with strict validation logic.
 * Enforces SKU format [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID] and maintains
 * domain invariants for inventory state.
 */

// SKU format: [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID]
// Example: ELEC-LAP-001
const skuRegex = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;

/**
 * Product Schema
 * Defines the core attributes for catalog entities.
 */
export const ProductSchema = z.object({
  id: z.string().uuid(),
  sku: z.string().regex(skuRegex, 'SKU must follow format [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID]'),
  name: z.string().min(3, 'Product name must be at least 3 characters long'),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Price must be a valid decimal string'),
  metadata: z.record(z.unknown()).optional(),
  created_at: z.date().default(() => new Date()),
  updated_at: z.date().default(() => new Date()),
});

export type Product = z.infer<typeof ProductSchema>;

/**
 * Inventory Schema
 * Manages dynamic stock state and enforces consistency constraints.
 */
export const InventorySchema = z
  .object({
    product_id: z.string().uuid(),
    total_stock: z.number().int().nonnegative(),
    reserved_stock: z.number().int().nonnegative(),
  })
  .refine(
    (data) => data.total_stock >= data.reserved_stock,
    {
      message: 'Total stock must be greater than or equal to reserved stock',
      path: ['total_stock'],
    }
  )
  .transform((data) => ({
    ...data,
    available_stock: data.total_stock - data.reserved_stock,
  }));

export type Inventory = z.infer<typeof InventorySchema>;

/**
 * Validates product data input.
 */
export const validateProduct = (data: unknown) => {
  return ProductSchema.safeParse(data);
};

/**
 * Validates inventory data input.
 */
export const validateInventory = (data: unknown) => {
  return InventorySchema.safeParse(data);
};

/**
 * Domain-specific integrity check for stock transitions.
 * Ensures the resulting inventory state is valid.
 */
export const validateInventoryMutation = (
  current: Inventory,
  totalChange: number,
  reservedChange: number
): { success: boolean; data?: Inventory; error?: string } => {
  const nextTotal = current.total_stock + totalChange;
  const nextReserved = current.reserved_stock + reservedChange;

  if (nextTotal < 0 || nextReserved < 0) {
    return { success: false, error: 'Negative stock levels are not permitted' };
  }

  if (nextTotal < nextReserved) {
    return { success: false, error: 'Cannot reserve more stock than total available' };
  }

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
