import { z } from 'zod';

/**
 * @fileoverview Order and Checkout Domain Schemas.
 * Acts as the single source of truth for order lifecycle and validation.
 */

/**
 * Supported Order States
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
}

/**
 * Valid state transitions mapping
 */
export const OrderTransitions: Record<OrderStatus, OrderStatus[]> = {
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
export const OrderItemSchema = z.object({
  sku: z.string().min(1, 'SKU is required'),
  quantity: z.number().int().positive('Quantity must be a positive integer'),
  unit_price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Unit price must be a valid decimal string'),
  item_total: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Item total must be a valid decimal string'),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;

/**
 * Zod schema for shipping information
 * Separated to handle potential PII in a dedicated security context
 */
export const ShippingAddressSchema = z.object({
  street: z.string().min(1, 'Street is required'),
  city: z.string().min(1, 'City is required'),
  postal_code: z.string().min(1, 'Postal code is required'),
  country: z.string().length(2, 'Use ISO 3166-1 alpha-2 country code'),
});

export type ShippingAddress = z.infer<typeof ShippingAddressSchema>;

/**
 * Zod schema for initial Order Request
 */
export const OrderRequestSchema = z.object({
  user_id: z.string().uuid('Invalid user ID format'),
  items: z.array(OrderItemSchema).min(1, 'Order must contain at least one item'),
  shipping_address: ShippingAddressSchema,
  payment_token: z.string().min(1, 'Payment token is required'),
});

export type OrderRequest = z.infer<typeof OrderRequestSchema>;

/**
 * Zod schema for internal persistence Order Model
 */
export const OrderModelSchema = z.object({
  order_id: z.string().uuid(),
  user_id: z.string().uuid(),
  status: z.nativeEnum(OrderStatus),
  items: z.array(OrderItemSchema),
  shipping_address: ShippingAddressSchema,
  total_amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  tracking_number: z.string().optional(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type OrderModel = z.infer<typeof OrderModelSchema>;

/**
 * Validates a state transition.
 * @param currentStatus The current order status.
 * @param nextStatus The intended target status.
 * @param context Additional context required for specific transitions (e.g., tracking number for SHIPPED).
 * @returns { valid: boolean, error?: string }
 */
export const validateStateTransition = (
  currentStatus: OrderStatus,
  nextStatus: OrderStatus,
  context?: { tracking_number?: string }
): { valid: boolean; error?: string } => {
  const allowed = OrderTransitions[currentStatus];

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

/**
 * Helper to safely parse OrderRequest
 */
export const parseOrderRequest = (data: unknown) => {
  return OrderRequestSchema.safeParse(data);
};
