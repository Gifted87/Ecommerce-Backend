import { z } from 'zod';

/**
 * @fileoverview Validation schemas for product catalog and inventory domain.
 * Provides strict request validation for high-throughput API endpoints.
 * Implemented with Zod for runtime type safety and performance.
 */

/**
 * SKU format: [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID]
 * Example: ELEC-LAP-001
 */
const SKU_REGEX = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;

/**
 * Catalog Query Schema
 * Validates pagination and filtering for the GET /products endpoint.
 * Enforces strict query parameter control to prevent injection.
 */
export const CatalogQuerySchema = z.object({
  limit: z.preprocess(
    (val) => (typeof val === 'string' ? parseInt(val, 10) : val),
    z.number().int().positive().max(100).default(20)
  ),
  offset: z.preprocess(
    (val) => (typeof val === 'string' ? parseInt(val, 10) : val),
    z.number().int().nonnegative().default(0)
  ),
  category: z.string().regex(/^[a-z0-9-_]+$/).optional(),
  price_min: z.preprocess(
    (val) => (typeof val === 'string' ? parseFloat(val) : val),
    z.number().nonnegative().optional()
  ),
  price_max: z.preprocess(
    (val) => (typeof val === 'string' ? parseFloat(val) : val),
    z.number().nonnegative().optional()
  ),
}).strict().refine(
  (data) => {
    if (data.price_min !== undefined && data.price_max !== undefined) {
      return data.price_min <= data.price_max;
    }
    return true;
  },
  {
    message: "price_min cannot be greater than price_max",
    path: ["price_min"],
  }
);

/**
 * Inventory Reservation Schema
 * Validates POST /inventory/:sku/reserve payload.
 * Ensures atomicity of requirements before hitting the repository layer.
 */
export const InventoryReservationSchema = z.object({
  sku: z.string().regex(SKU_REGEX, 'Invalid SKU format'),
  quantity: z.number().int().positive(),
  idempotency_token: z.string().uuid('Idempotency token must be a valid UUID'),
}).strict();

/**
 * Inferred Types
 */
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;
export type InventoryReservation = z.infer<typeof InventoryReservationSchema>;

/**
 * High-performance validation utility for Catalog Queries.
 * @param data Unknown input from Express query string.
 * @returns Result object with success/error metadata.
 */
export const validateCatalogQuery = (data: unknown) => {
  return CatalogQuerySchema.safeParse(data);
};

/**
 * High-performance validation utility for Inventory Reservations.
 * @param data Unknown input from Express request body.
 * @returns Result object with success/error metadata.
 */
export const validateInventoryReservation = (data: unknown) => {
  return InventoryReservationSchema.safeParse(data);
};

/**
 * Sanitizes data for logging by redacting PII or sensitive tokens.
 * @param data The object to sanitize.
 */
export const redactValidationLogs = (data: Record<string, any>): Record<string, any> => {
  const sanitized = { ...data };
  if (sanitized.idempotency_token) {
    sanitized.idempotency_token = '[REDACTED]';
  }
  return sanitized;
};
