import { z } from 'zod';

/**
 * @fileoverview Exhaustive Zod schemas for the Inventory Reconciliation service.
 * Enforces strict data contracts for Kafka events, PostgreSQL snapshots, and audit records.
 * Maintains system integrity through rigorous validation and refinement logic.
 */

const SKU_REGEX = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;
const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9-]{36}$/;

/**
 * Common Header for Kafka Events
 */
const KafkaHeaderSchema = z.object({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_REGEX, 'Invalid idempotency key format'),
  timestamp: z.string().datetime(),
  version: z.string().default('1.0.0'),
});

/**
 * InventoryReserved Event Schema
 */
export const InventoryReservedSchema = z.object({
  header: KafkaHeaderSchema,
  payload: z.object({
    productId: z.string().uuid(),
    orderId: z.string().uuid(),
    quantity: z.number().int().positive(),
  }),
});

/**
 * StockAdjusted Event Schema
 */
export const StockAdjustedSchema = z.object({
  header: KafkaHeaderSchema,
  payload: z.object({
    productId: z.string().uuid(),
    adjustment: z.number().int(), // Can be positive or negative
    reason: z.string().min(3),
  }),
});

/**
 * StockReconciled Event Schema
 */
export const StockReconciledSchema = z.object({
  header: KafkaHeaderSchema,
  payload: z.object({
    productId: z.string().uuid(),
    previousTotal: z.number().int().nonnegative(),
    newTotal: z.number().int().nonnegative(),
    discrepancyDetected: z.boolean(),
  }),
});

/**
 * Database Snapshot Schema
 * Represents the PostgreSQL row structure for inventory state.
 */
export const InventorySnapshotSchema = z.object({
  product_id: z.string().uuid(),
  sku: z.string().regex(SKU_REGEX),
  total_stock: z.number().int().nonnegative(),
  reserved_stock: z.number().int().nonnegative(),
  updated_at: z.date(),
}).refine((data) => data.total_stock >= data.reserved_stock, {
  message: 'Database inconsistency: total_stock must be greater than or equal to reserved_stock',
  path: ['total_stock'],
});

/**
 * Reconciliation Record Schema
 * Output structure for audit logs and reconciliation outcomes.
 * Explicitly excludes sensitive information.
 */
export const ReconciliationRecordSchema = z.object({
  reconciliation_id: z.string().uuid(),
  product_id: z.string().uuid(),
  status: z.enum(['SUCCESS', 'DISCREPANCY_FOUND', 'FAILURE']),
  detected_at: z.date().default(() => new Date()),
  audit_details: z.object({
    expected_total: z.number().int().nonnegative(),
    actual_total: z.number().int().nonnegative(),
    drift_amount: z.number().int(),
  }),
});

/**
 * Type exports for downstream service logic
 */
export type InventoryReserved = z.infer<typeof InventoryReservedSchema>;
export type StockAdjusted = z.infer<typeof StockAdjustedSchema>;
export type StockReconciled = z.infer<typeof StockReconciledSchema>;
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>;
export type ReconciliationRecord = z.infer<typeof ReconciliationRecordSchema>;

/**
 * Validation utilities with structured error handling
 */
export const validateInventoryReserved = (data: unknown) => InventoryReservedSchema.safeParse(data);
export const validateStockAdjusted = (data: unknown) => StockAdjustedSchema.safeParse(data);
export const validateStockReconciled = (data: unknown) => StockReconciledSchema.safeParse(data);
export const validateInventorySnapshot = (data: unknown) => InventorySnapshotSchema.safeParse(data);
export const validateReconciliationRecord = (data: unknown) => ReconciliationRecordSchema.safeParse(data);
