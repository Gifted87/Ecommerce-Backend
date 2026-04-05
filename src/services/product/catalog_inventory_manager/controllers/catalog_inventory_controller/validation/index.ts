import { z } from 'zod';

/**
 * @fileoverview Validation interface suite for Catalog and Inventory microservice.
 * Provides strict structural and domain invariant validation for product and inventory operations.
 */

/**
 * SKU format: [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID]
 * Example: ELEC-LAP-001
 * Strict regex ensures no invalid characters or malformed identifiers.
 */
export const SKU_REGEX = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;

/**
 * Price format: Valid decimal string representation (e.g., "19.99")
 */
export const PRICE_REGEX = /^\d+(\.\d{1,2})?$/;

/**
 * Structured error format for API consistency.
 */
export interface ValidationErrorDetail {
  path: string[];
  message: string;
  code: string;
}

/**
 * Standardized validation result type.
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: ValidationErrorDetail[] };

/**
 * Product Creation Schema.
 * Enforces strict structural typing and basic domain constraints.
 */
export const ProductCreationSchema = z.object({
  id: z.string().uuid('Invalid UUID format for product ID'),
  sku: z.string().regex(SKU_REGEX, 'SKU must follow format [CATEGORY]-[PRODUCT_CODE]-[VARIANT_ID]'),
  name: z.string().min(3, 'Product name must be at least 3 characters long'),
  price: z.string().regex(PRICE_REGEX, 'Price must be a valid decimal string with up to 2 decimal places'),
  metadata: z.record(z.unknown()).refine(
    (obj) => Object.keys(obj).length <= 50,
    { message: 'Metadata cannot exceed 50 top-level keys' }
  ).optional(),
});

/**
 * Inventory Adjustment Schema.
 */
export const InventoryAdjustmentSchema = z.object({
  product_id: z.string().uuid('Invalid UUID format for product ID'),
  adjustment: z.number().int('Adjustment must be an integer'),
  reason: z.string().min(3, 'Reason must be at least 3 characters long'),
});

/**
 * Validates product creation input.
 * 
 * @param data - The raw request body to be validated.
 * @returns ValidationResult containing either the sanitized data or an array of error details.
 */
export const validateProductCreation = (data: unknown): ValidationResult<z.infer<typeof ProductCreationSchema>> => {
  const result = ProductCreationSchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.map((p) => String(p)),
        message: issue.message,
        code: issue.code,
      })),
    };
  }
  return { success: true, data: result.data };
};

/**
 * Validates inventory adjustment input.
 * 
 * @param data - The raw request body to be validated.
 * @returns ValidationResult containing either the sanitized data or an array of error details.
 */
export const validateInventoryAdjustment = (data: unknown): ValidationResult<z.infer<typeof InventoryAdjustmentSchema>> => {
  const result = InventoryAdjustmentSchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.map((p) => String(p)),
        message: issue.message,
        code: issue.code,
      })),
    };
  }
  return { success: true, data: result.data };
};

/**
 * Redacts sensitive fields from objects before logging.
 * 
 * @param obj - The object to redact.
 * @returns A new object with sensitive information replaced by [REDACTED].
 */
export const redactSensitiveData = (obj: Record<string, unknown>): Record<string, unknown> => {
  const sensitiveKeys = ['auth_token', 'password', 'user_id', 'ssn', 'credit_card'];
  const redacted = { ...obj };
  
  for (const key of sensitiveKeys) {
    if (Object.prototype.hasOwnProperty.call(redacted, key)) {
      redacted[key] = '[REDACTED]';
    }
  }
  
  return redacted;
};
