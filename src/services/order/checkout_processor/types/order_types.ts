import { z } from 'zod';

/**
 * @fileoverview Order and Checkout Domain Types.
 * Definitive source of truth for order lifecycle data structures,
 * state transition contexts, and repository persistence contracts.
 */

/**
 * Supported Order Statuses.
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  PROCESSING = 'PROCESSING',
  PLACED = 'PLACED',
  FAILED = 'FAILED',
}

/**
 * Zod schema for order line items.
 */
export const OrderItemSchema = z.object({
  sku: z.string(),
  quantity: z.number().int().positive(),
  unit_price: z.string().refine((val) => !isNaN(Number(val))),
  item_total: z.string().refine((val) => !isNaN(Number(val))),
});

/**
 * Zod schema for shipping address.
 */
export const ShippingAddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  postal_code: z.string(),
  country: z.string().length(2), // ISO 3166-1 alpha-2
});

/**
 * Zod schema for the Order model.
 */
export const OrderModelSchema = z.object({
  order_id: z.string().uuid(),
  user_id: z.string().uuid(),
  status: z.nativeEnum(OrderStatus),
  items: z.array(OrderItemSchema),
  shipping_address: ShippingAddressSchema,
  total_amount: z.string().refine((val) => !isNaN(Number(val))),
  version: z.number().int().nonnegative().optional(),
  correlation_id: z.string().uuid().optional(),
  tracking_number: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export const OrderRequestSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  items: z.array(OrderItemSchema),
  total_amount: z.string(),
  shipping_address: ShippingAddressSchema,
  payment_token: z.string(),
  correlationId: z.string().uuid(),
});

/**
 * Represents the persistent state of an order in the system.
 */
export type OrderModel = z.infer<typeof OrderModelSchema>;
export type Order = OrderModel; // Alias for backward compatibility
export type OrderItem = z.infer<typeof OrderItemSchema>;
export type ShippingAddress = z.infer<typeof ShippingAddressSchema>;
export type OrderRequest = z.infer<typeof OrderRequestSchema>;

/**
 * Context for state transitions.
 */
export interface ShippingTransitionContext {
  tracking_number: string;
}

export type OrderTransitionContext = ShippingTransitionContext | undefined;

/**
 * Repository Operation Result Discriminators.
 */
export type RepositoryResult<T> =
  | { success: true; data: T }
  | { success: false; error: 'NOT_FOUND' | 'CONNECTION_TIMEOUT' | 'CONSTRAINT_VIOLATION' | 'CONCURRENCY_ERROR' | 'UNKNOWN_ERROR'; message: string };

/**
 * High-level repository contract for Order persistence.
 */
export interface IOrderRepository {
  /**
   * Creates a new order within a transaction.
   */
  create(order: Omit<Order, 'created_at' | 'updated_at' | 'version'>, tx?: unknown): Promise<RepositoryResult<Order>>;

  /**
   * Retrieves an order by ID.
   */
  findById(order_id: string): Promise<RepositoryResult<Order>>;

  /**
   * Updates an order status with optimistic locking.
   */
  updateStatus(
    order_id: string,
    next_status: OrderStatus,
    current_version: number,
    context?: OrderTransitionContext,
    tx?: unknown
  ): Promise<RepositoryResult<Order>>;
}

/**
 * Unit of Work contract for atomic operations.
 */
export interface IUnitOfWork {
  executeInTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}

/**
 * State Transition Map.
 */
export const OrderTransitions: Record<OrderStatus, OrderStatus[]> = {
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
