import { z } from 'zod';

/**
 * @fileoverview Inventory Mutation Validator
 * Implements high-performance, stateless validation for inventory mutations.
 * Enforces business invariants and structural integrity using Zod.
 */

/**
 * Custom error class for structured validation failures.
 */
export class InventoryValidationError extends Error {
  constructor(public details: { path: string[]; message: string; received?: unknown }[]) {
    super('Inventory validation failed');
    this.name = 'InventoryValidationError';
  }
}

/**
 * Schema for inventory mutation requests.
 */
export const InventoryMutationRequestSchema = z.object({
  productId: z.string().uuid('Invalid productId: Must be a valid UUID v4'),
  changeAmount: z.number().int('changeAmount must be an integer'),
  reservationId: z.string().uuid('Invalid reservationId: Must be a valid UUID v4'),
});

/**
 * Schema for existing inventory state snapshots from the database.
 */
export const InventoryStateSchema = z.object({
  productId: z.string().uuid(),
  totalStock: z.number().int().nonnegative(),
  reservedStock: z.number().int().nonnegative(),
});

export type InventoryMutationRequest = z.infer<typeof InventoryMutationRequestSchema>;
export type InventoryState = z.infer<typeof InventoryStateSchema>;

/**
 * InventoryValidator
 * Provides stateless validation logic for inventory operations.
 */
export class InventoryValidator {
  /**
   * Validates a mutation request against current inventory state.
   * 
   * @param request The mutation request payload.
   * @param currentState The current state of the inventory.
   * @returns The resulting state if valid, or throws InventoryValidationError.
   */
  public static validateMutation(
    request: unknown,
    currentState: unknown
  ): { nextTotalStock: number; nextReservedStock: number } {
    // 1. Validate Request Structure
    const mutationResult = InventoryMutationRequestSchema.safeParse(request);
    if (!mutationResult.success) {
      throw new InventoryValidationError(
        mutationResult.error.issues.map((issue) => ({
          path: issue.path.map((p) => String(p)),
          message: issue.message,
          received: (issue as any).received,
        }))
      );
    }

    // 2. Validate State Structure
    const stateResult = InventoryStateSchema.safeParse(currentState);
    if (!stateResult.success) {
      throw new InventoryValidationError(
        stateResult.error.issues.map((issue) => ({
          path: issue.path.map((p) => String(p)),
          message: `Internal State Error: ${issue.message}`,
        }))
      );
    }

    const mutation = mutationResult.data;
    const state = stateResult.data;

    // 3. Business Logic Validation
    const nextTotalStock = state.totalStock + mutation.changeAmount;
    
    // In this specific mutation model, changeAmount applies to total_stock.
    // Reserved stock typically remains constant unless a specific reservation release/create call is made.
    const nextReservedStock = state.reservedStock;

    const errors: { path: string[]; message: string }[] = [];

    // Constraint: total_stock >= 0
    if (nextTotalStock < 0) {
      errors.push({
        path: ['changeAmount'],
        message: `Insufficient total stock. Resulting total would be ${nextTotalStock}`,
      });
    }

    // Constraint: total_stock >= reserved_stock
    if (nextTotalStock < nextReservedStock) {
      errors.push({
        path: ['changeAmount'],
        message: `Mutation violates integrity: total_stock (${nextTotalStock}) must be >= reserved_stock (${nextReservedStock})`,
      });
    }

    if (errors.length > 0) {
      throw new InventoryValidationError(errors);
    }

    return { nextTotalStock, nextReservedStock };
  }

  /**
   * Redacts sensitive information for logging purposes.
   */
  public static redactPII(data: Record<string, any>): Record<string, any> {
    const sensitiveKeys = ['reservationId', 'customer_id', 'email'];
    const redacted = { ...data };
    
    for (const key of Object.keys(redacted)) {
      if (sensitiveKeys.includes(key)) {
        redacted[key] = '[REDACTED]';
      }
    }
    
    return redacted;
  }
}
