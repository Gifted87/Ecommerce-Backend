import { z } from 'zod';

/**
 * Core System Enums
 */
export enum OrderState {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  REFUNDED = 'REFUNDED',
  SHIPPED = 'SHIPPED',
  CANCELLED = 'CANCELLED',
}

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
  SUPPORT = 'SUPPORT',
}

/**
 * User Contract
 */
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  passwordHash: z.string(), // Argon2id hash
  salt: z.string(),
  role: z.nativeEnum(UserRole),
  mfaEnabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserContract = z.infer<typeof UserSchema>;

/**
 * Product Contract
 */
export const ProductSchema = z.object({
  sku: z.string(),
  name: z.string(),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/), // Decimal stored as string for precision
  stockQuantity: z.number().int().nonnegative(),
  attributes: z.record(z.string(), z.any()), // JSONB dynamic attributes
  version: z.number().int(), // Optimistic locking
});

export type ProductContract = z.infer<typeof ProductSchema>;

/**
 * Order Contract
 */
export const ProductSnapshotSchema = z.object({
  sku: z.string(),
  priceAtPurchase: z.string(),
  quantity: z.number().int().positive(),
});

export const OrderSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  items: z.array(ProductSnapshotSchema),
  totalAmount: z.string(),
  currency: z.string().length(3),
  state: z.nativeEnum(OrderState),
  correlationId: z.string().uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrderContract = z.infer<typeof OrderSchema>;

/**
 * Payment Contract
 */
export const PaymentSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  status: z.nativeEnum(OrderState).refine(
    (s) => [OrderState.PENDING, OrderState.AUTHORIZED, OrderState.CAPTURED, OrderState.REFUNDED].includes(s)
  ),
  amount: z.string(),
  token: z.string(), // Encrypted payment token
  correlationId: z.string().uuid(),
});

export type PaymentContract = z.infer<typeof PaymentSchema>;

/**
 * Kafka Event Schemas
 */
export const OrderEventSchema = z.object({
  correlationId: z.string().uuid(),
  timestamp: z.date(),
  type: z.enum(['ORDER_CREATED', 'PAYMENT_RECEIVED', 'ORDER_SHIPPED', 'ORDER_CANCELLED']),
  payload: z.object({
    orderId: z.string().uuid(),
    userId: z.string().uuid(),
  }),
});

export type OrderEvent = z.infer<typeof OrderEventSchema>;

export const InventoryEventSchema = z.object({
  correlationId: z.string().uuid(),
  timestamp: z.date(),
  type: z.enum(['INVENTORY_DECREMENTED', 'INVENTORY_INCREMENTED']),
  payload: z.object({
    sku: z.string(),
    quantity: z.number().int(),
  }),
});

export type InventoryEvent = z.infer<typeof InventoryEventSchema>;
