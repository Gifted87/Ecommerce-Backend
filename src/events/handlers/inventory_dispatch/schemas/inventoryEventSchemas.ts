import { z } from 'zod';

/**
 * @fileoverview Inventory Event Schemas and Configuration Validation.
 * Defines authoritative domain models for the Inventory service.
 */

// --- Constants ---
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// --- Standard Header ---
export const EventHeaderSchema = z.object({
  idempotencyKey: z.string().uuid(),
  timestamp: z.string().datetime(),
  version: z.string().regex(SEMVER_REGEX, 'Version must follow semver format (major.minor.patch)'),
});

// --- Event Payloads ---

export const InventoryReservedSchema = z.object({
  header: EventHeaderSchema,
  payload: z.object({
    productId: z.string().uuid(),
    orderId: z.string().uuid(),
    quantity: z.number().int().positive(),
    reason: z.string().min(1),
  }),
});

export const InventoryReleasedSchema = z.object({
  header: EventHeaderSchema,
  payload: z.object({
    productId: z.string().uuid(),
    orderId: z.string().uuid(),
    quantity: z.number().int().positive(),
    reason: z.string().min(1),
  }),
});

export const InventoryAdjustedSchema = z.object({
  header: EventHeaderSchema,
  payload: z.object({
    productId: z.string().uuid(),
    adjustment: z.number().int(),
    reason: z.string().min(1),
  }),
});

export const InventorySnapshotSchema = z.object({
  header: EventHeaderSchema,
  payload: z.object({
    productId: z.string().uuid(),
    totalStock: z.number().int().nonnegative(),
    reservedStock: z.number().int().nonnegative(),
  }).refine((data) => data.totalStock >= data.reservedStock, {
    message: 'Domain Invariant Violation: totalStock must be >= reservedStock',
    path: ['totalStock'],
  }),
});

// --- Configuration Schema ---

export const AppConfigSchema = z.object({
  KAFKA_BROKER_URI: z.string().url(),
  HMAC_SECRET: z.string().min(32, 'HMAC secret must be at least 32 characters'),
  DB_CONNECTION_STRING: z.string().startsWith('postgresql://'),
  CIRCUIT_BREAKER_TIMEOUT_MS: z.preprocess((v) => parseInt(v as string, 10), z.number().positive()),
  CIRCUIT_BREAKER_ERROR_THRESHOLD: z.preprocess((v) => parseInt(v as string, 10), z.number().positive()),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.preprocess((v) => parseInt(v as string, 10), z.number().positive()),
});

// --- Types ---

export type InventoryReserved = z.infer<typeof InventoryReservedSchema>;
export type InventoryReleased = z.infer<typeof InventoryReleasedSchema>;
export type InventoryAdjusted = z.infer<typeof InventoryAdjustedSchema>;
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

// --- Error Handling ---

export class ValidationFailedError extends Error {
  constructor(public errors: z.ZodIssue[]) {
    super('Event validation failed');
    this.name = 'ValidationFailedError';
  }
}

// --- Redaction Utilities ---

export const redactSensitiveData = <T extends Record<string, any>>(data: T): T => {
  const redacted = { ...data };
  const sensitiveKeys = ['userId', 'internalToken', 'password', 'authToken', 'secret'];
  
  for (const key of sensitiveKeys) {
    if (key in redacted) {
      redacted[key] = '[REDACTED]';
    }
  }
  
  return redacted;
};
