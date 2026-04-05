import { z } from 'zod';
import { Decimal } from 'decimal.js';

/**
 * Machine-readable error codes for validation failures.
 */
export enum ValidationErrorCode {
  INVALID_SKU_FORMAT = 'INVALID_SKU_FORMAT',
  EXCEEDS_MAX_ITEMS = 'EXCEEDS_MAX_ITEMS',
  INVALID_PAGINATION_RANGE = 'INVALID_PAGINATION_RANGE',
  INVALID_DATE_RANGE = 'INVALID_DATE_RANGE',
  CALCULATION_MISMATCH = 'CALCULATION_MISMATCH',
  INVALID_SCHEMA = 'INVALID_SCHEMA',
}

/**
 * Unified application-specific validation error.
 */
export class ValidationError extends Error {
  constructor(
    public readonly details: { path: string[]; message: string; code: ValidationErrorCode }[],
    public readonly correlationId?: string
  ) {
    super('Validation failed');
    this.name = 'ValidationError';
  }
}

const SKU_REGEX = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;

/**
 * Zod schema for individual order items.
 */
const OrderItemSchema = z.object({
  sku: z.string().regex(SKU_REGEX, { message: 'Invalid SKU format' }),
  unit_price: z.string().refine((val) => {
    try {
      const d = new Decimal(val);
      return d.isPositive() || d.isZero();
    } catch {
      return false;
    }
  }, { message: 'Unit price must be a non-negative decimal' }),
  quantity: z.number().int().positive({ message: 'Quantity must be a positive integer' }),
  item_total: z.string(),
});

/**
 * Zod schema for the checkout request body.
 */
export const CheckoutRequestSchema = z.object({
  items: z.array(OrderItemSchema).min(1).max(50, { message: 'Order exceeds maximum item limit of 50' }),
  total_amount: z.string(),
  shipping_address: z.string(),
  payment_token: z.string(),
});

/**
 * Zod schema for paginated queries.
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1),
  limit: z.coerce.number().int().min(1).max(100),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).refine((data) => {
  if (data.from && data.to) {
    return new Date(data.from) < new Date(data.to);
  }
  return true;
}, { message: 'From date must be before to date', path: ['from'] });

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * Validator class providing static methods for domain-level validation.
 */
export class OrderValidator {
  /**
   * Validates checkout request payload, enforcing schema and business invariants.
   */
  public static validateCheckout(
    payload: unknown,
    correlationId?: string
  ): CheckoutRequest {
    const result = CheckoutRequestSchema.safeParse(payload);

    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((issue) => ({
          path: issue.path.map((p) => String(p)),
          message: issue.message,
          code: ValidationErrorCode.INVALID_SCHEMA,
        })),
        correlationId
      );
    }

    const data = result.data;
    const errors: { path: string[]; message: string; code: ValidationErrorCode }[] = [];

    let runningTotal = new Decimal(0);

    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const itemPath = ['items', i.toString()];

      const unitPrice = new Decimal(item.unit_price);
      const quantity = new Decimal(item.quantity);
      const itemTotal = new Decimal(item.item_total);

      if (!unitPrice.mul(quantity).equals(itemTotal)) {
        errors.push({
          path: [...itemPath, 'item_total'],
          message: 'Calculation mismatch: unit_price * quantity != item_total',
          code: ValidationErrorCode.CALCULATION_MISMATCH,
        });
      }
      runningTotal = runningTotal.add(itemTotal);
    }

    if (!runningTotal.equals(new Decimal(data.total_amount))) {
      errors.push({
        path: ['total_amount'],
        message: 'Order total mismatch',
        code: ValidationErrorCode.CALCULATION_MISMATCH,
      });
    }

    if (errors.length > 0) {
      throw new ValidationError(errors, correlationId);
    }

    return data;
  }

  /**
   * Validates pagination parameters.
   */
  public static validatePagination(
    query: unknown,
    correlationId?: string
  ): PaginationQuery {
    const result = PaginationQuerySchema.safeParse(query);

    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((issue) => ({
          path: issue.path.map((p) => String(p)),
          message: issue.message,
          code: ValidationErrorCode.INVALID_PAGINATION_RANGE,
        })),
        correlationId
      );
    }

    return result.data;
  }

  /**
   * Redacts sensitive data from PII-containing objects for logs.
   */
  public static redactPII(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const redacted = { ...data };
    if ('shipping_address' in redacted) redacted.shipping_address = '[REDACTED]';
    if ('payment_token' in redacted) redacted.payment_token = '[REDACTED]';
    return redacted;
  }
}
