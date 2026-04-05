import { z } from 'zod';

/**
 * @fileoverview Order API DTOs and Validation Schemas.
 * Provides the contract between the HTTP transport layer and the Domain Services.
 */

// --- Reusable Constants & Schemas ---

export const UUID_SCHEMA = z.string().uuid();
export const DECIMAL_STRING_SCHEMA = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Must be a valid decimal string');
export const ISO_DATE_SCHEMA = z.string().datetime();

// --- Order Envelopes ---

export interface SuccessEnvelope<T> {
  data: T;
  meta: {
    trace_id: string;
    timestamp: string;
  };
}

export interface ErrorEnvelope {
  error_code: string;
  message: string;
  trace_id: string;
  details?: unknown;
}

// --- DTO Interfaces ---

export interface CreateOrderRequest {
  items: Array<{
    sku: string;
    quantity: number;
  }>;
  shipping_address: {
    street: string;
    city: string;
    postal_code: string;
    country: string;
  };
  correlation_id: string;
}

export interface UpdateOrderStatusRequest {
  order_id: string;
  status: 'PENDING' | 'PAID' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';
  version: number;
  correlation_id: string;
}

export interface OrderResponse {
  order_id: string;
  user_id: string;
  status: string;
  items: Array<{
    sku: string;
    quantity: number;
    unit_price: string;
    item_total: string;
  }>;
  shipping_address: {
    street: string;
    city: string;
    postal_code: string;
    country: string;
  };
  total_amount: string;
  version: number;
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

// --- Zod Validation Schemas ---

export const CreateOrderSchema = z.object({
  items: z.array(z.object({
    sku: z.string().min(1),
    quantity: z.number().int().positive(),
  })).min(1),
  shipping_address: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    postal_code: z.string().min(3),
    country: z.string().length(2),
  }),
  correlation_id: UUID_SCHEMA,
});

export const UpdateOrderStatusSchema = z.object({
  order_id: UUID_SCHEMA,
  status: z.enum(['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']),
  version: z.number().int().nonnegative(),
  correlation_id: UUID_SCHEMA,
});

/**
 * Utility to redact PII from OrderResponse for logging purposes.
 */
export function redactOrderPII(order: OrderResponse): Omit<OrderResponse, 'shipping_address'> {
  const { shipping_address, ...safeOrder } = order;
  return safeOrder;
}
