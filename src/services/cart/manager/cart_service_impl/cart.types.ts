/**
 * @fileoverview Internal contract definitions for the Cart Service.
 * This module defines the domain models, state machine, and communication contracts
 * for the high-concurrency Shopping Cart management system.
 * 
 * Financial fields are strictly typed as bigint to ensure precision.
 */

/**
 * UUID v4 representation.
 */
export type UUID = string;

/**
 * ISO 8601 formatted date-time string.
 */
export type ISO8601Date = string;

/**
 * Supported Cart lifecycle states.
 */
export enum CartStatus {
  /** Initial state for guest users or brand new sessions. */
  ACTIVE = 'ACTIVE',
  /** Cart is transitioning to order completion. */
  PENDING_CHECKOUT = 'PENDING_CHECKOUT',
  /** Cart has been successfully converted to an order. */
  PURCHASED = 'PURCHASED',
  /** Cart has reached its expiry TTL without action. */
  ABANDONED = 'ABANDONED',
}

/**
 * Represents a line item in the shopping cart.
 */
export interface CartItem {
  readonly productId: UUID;
  readonly sku: string;
  quantity: number;
  /** Price in minor currency units (e.g., cents for USD). */
  readonly pricePerUnit: bigint;
  readonly currency: string;
  readonly addedAt: ISO8601Date;
  updatedAt: ISO8601Date;
}

/**
 * Summarized financial state of the cart.
 */
export interface CartSummary {
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly shippingTotal: bigint;
  readonly discountTotal: bigint;
  readonly grandTotal: bigint;
}

/**
 * Core Shopping Cart entity stored in Redis.
 */
export interface Cart {
  readonly cartId: UUID;
  readonly userId: UUID | null;
  items: CartItem[];
  summary: CartSummary;
  status: CartStatus;
  readonly createdAt: ISO8601Date;
  updatedAt: ISO8601Date;
  
  /** Distributed locking and consistency metadata. */
  readonly lockId: UUID;
  /** Optimistic concurrency version counter. */
  readonly version: number;
  
  /** Traceability metadata. */
  readonly correlationId: UUID;
  readonly requestId: UUID;
}

/**
 * Error thrown when a concurrency conflict (version mismatch) is detected.
 */
export class CartConcurrencyError extends Error {
  constructor(public readonly cartId: UUID, public readonly expectedVersion: number) {
    super(`Concurrency violation for cart ${cartId}: Expected version ${expectedVersion}`);
    this.name = 'CartConcurrencyError';
  }
}

/**
 * Request contract for merging a guest cart into a user's persistent cart.
 */
export interface MergeOperationRequest {
  readonly guestCartId: UUID;
  readonly userCartId: UUID;
  readonly correlationId: UUID;
}

/**
 * Response contract for the merge operation.
 */
export interface MergeOperationResponse {
  readonly success: boolean;
  readonly mergedCart: Cart | null;
  readonly error?: string;
}

/**
 * Type guard for Cart entity.
 */
export function isCart(obj: any): obj is Cart {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.cartId === 'string' &&
    Array.isArray(obj.items) &&
    typeof obj.summary === 'object' &&
    typeof obj.status === 'string' &&
    typeof obj.lockId === 'string' &&
    typeof obj.version === 'number'
  );
}

/**
 * Type guard for CartItem entity.
 */
export function isCartItem(obj: any): obj is CartItem {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.productId === 'string' &&
    typeof obj.sku === 'string' &&
    typeof obj.quantity === 'number' &&
    typeof obj.pricePerUnit === 'bigint'
  );
}
