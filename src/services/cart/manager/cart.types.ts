/**
 * @fileoverview Domain-driven TypeScript interface suite for the Shopping Cart and Session Management service.
 * These interfaces define the contract for high-concurrency state persistence in Redis, 
 * ensuring type safety, financial precision, and auditability.
 */

/**
 * UUID representation type.
 */
export type UUID = string;

/**
 * ISO 8601 Date string.
 */
export type ISO8601Date = string;

/**
 * Represents an individual item in the shopping cart.
 * Uses bigint for currency to prevent floating-point rounding errors.
 */
export interface CartItem {
  readonly productId: UUID;
  readonly sku: string;
  quantity: number;
  readonly pricePerUnit: bigint; // Stored in minor currency units (e.g., cents)
  readonly currency: string; // ISO 4217 code (e.g., 'USD')
  readonly addedAt: ISO8601Date;
  updatedAt: ISO8601Date;
}

/**
 * Represents the summarized financial state of a cart.
 */
export interface CartSummary {
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly shippingTotal: bigint;
  readonly discountTotal: bigint;
  readonly grandTotal: bigint;
}

/**
 * Defines the state of the shopping cart.
 */
export enum CartStatus {
  ACTIVE = 'ACTIVE',
  PENDING_CHECKOUT = 'PENDING_CHECKOUT',
  ABANDONED = 'ABANDONED',
  PURCHASED = 'PURCHASED',
}

/**
 * Core Shopping Cart entity.
 */
export interface Cart {
  readonly cartId: UUID;
  readonly userId: UUID | null;
  items: CartItem[];
  summary: CartSummary;
  status: CartStatus;
  readonly createdAt: ISO8601Date;
  updatedAt: ISO8601Date;
  
  // Distributed locking and consistency metadata
  readonly lockId: UUID; // Identifier for Redis lock acquisition
  readonly version: number; // Optimistic locking version counter
  
  // Traceability metadata
  readonly correlationId: UUID;
  readonly requestId: UUID;
}

/**
 * Metadata for user session, containing ephemeral authentication state.
 */
export interface SessionMetadata {
  readonly sessionId: UUID;
  readonly userId: UUID;
  readonly createdAt: ISO8601Date;
  expiresAt: ISO8601Date;
  
  /** 
   * Cryptographic fingerprinting for session hijacking prevention.
   * Marked for redaction in logs.
   */
  readonly sessionFingerprint: string; 
  
  // Traceability metadata
  readonly correlationId: UUID;
  
  // Additional context
  readonly userAgent: string;
  readonly ipAddress: string;
}

/**
 * Type Guard to validate if an object conforms to the Cart structure.
 */
export function isCart(obj: any): obj is Cart {
  return (
    typeof obj.cartId === 'string' &&
    Array.isArray(obj.items) &&
    typeof obj.summary === 'object' &&
    typeof obj.status === 'string' &&
    typeof obj.lockId === 'string' &&
    typeof obj.version === 'number'
  );
}

/**
 * Type Guard to validate if an object conforms to the SessionMetadata structure.
 */
export function isSessionMetadata(obj: any): obj is SessionMetadata {
  return (
    typeof obj.sessionId === 'string' &&
    typeof obj.userId === 'string' &&
    typeof obj.sessionFingerprint === 'string'
  );
}
