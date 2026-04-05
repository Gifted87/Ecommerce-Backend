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
}

/**
 * Represents a line item in an order.
 */
export interface OrderItem {
  sku: string;
  quantity: number;
  unit_price: string; // Decimal string for precision
  item_total: string; // Decimal string for precision
}

/**
 * Shipping information containing sensitive PII.
 */
export interface ShippingAddress {
  street: string;
  city: string;
  postal_code: string;
  country: string; // ISO 3166-1 alpha-2
}

/**
 * Core Order domain entity.
 * Represents the persistent state of an order in the system.
 */
export interface Order {
  order_id: string; // UUID v4
  user_id: string; // UUID v4
  status: OrderStatus;
  items: OrderItem[];
  shipping_address: ShippingAddress;
  total_amount: string; // Decimal string
  version: number; // For optimistic locking
  correlation_id: string; // For distributed tracing
  tracking_number?: string;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

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
