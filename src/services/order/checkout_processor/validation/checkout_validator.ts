import { z } from 'zod';
import Decimal from 'decimal.js';
import { 
  OrderRequestSchema, 
  OrderRequest, 
  OrderItem 
} from '../domain/order_schemas';

/**
 * Custom error class for validation failures.
 * Provides structured error reporting for downstream controllers.
 */
export class ValidationError extends Error {
  constructor(public details: { path: string[]; message: string }[]) {
    super('Validation failed');
    this.name = 'ValidationError';
  }
}

/**
 * CheckoutValidator handles the two-pass validation process for checkout requests.
 * Pass 1: Schema enforcement via Zod.
 * Pass 2: Business logic integrity (price calculations, SKU format, quantity limits).
 * 
 * Stateless design ensures thread-safety and horizontal scalability.
 */
export class CheckoutValidator {
  private static readonly SKU_REGEX = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;
  private static readonly MAX_ITEMS_PER_ORDER = 50;
  private static readonly MAX_QUANTITY_PER_ITEM = 99;

  /**
   * Performs high-fidelity validation of the checkout request.
   * @param rawRequest Unknown object received from the controller.
   * @param totalAmount The total amount claimed by the client for the order.
   * @returns A validated OrderRequest object or throws a ValidationError.
   */
  public async validate(rawRequest: unknown, totalAmount: string): Promise<OrderRequest> {
    // 1. Schema Validation
    const parsed = OrderRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.map((p) => String(p)),
          message: issue.message,
        }))
      );
    }

    const order = parsed.data;

    // 2. Business Logic Validation
    const errors: { path: string[]; message: string }[] = [];

    // Capacity checks
    if (order.items.length > CheckoutValidator.MAX_ITEMS_PER_ORDER) {
      errors.push({ path: ['items'], message: `Order exceeds maximum item limit of ${CheckoutValidator.MAX_ITEMS_PER_ORDER}` });
    }

    const runningTotal = new Decimal(0);

    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i];
      const itemPath = ['items', i.toString()];

      // SKU Format Validation
      if (!CheckoutValidator.SKU_REGEX.test(item.sku)) {
        errors.push({ path: [...itemPath, 'sku'], message: 'Invalid SKU format' });
      }

      // Quantity Limits
      if (item.quantity <= 0 || item.quantity > CheckoutValidator.MAX_QUANTITY_PER_ITEM) {
        errors.push({ path: [...itemPath, 'quantity'], message: `Quantity must be between 1 and ${CheckoutValidator.MAX_QUANTITY_PER_ITEM}` });
      }

      // Unit Price * Quantity = Item Total Validation
      const unitPrice = new Decimal(item.unit_price);
      const quantity = new Decimal(item.quantity);
      const itemTotal = new Decimal(item.item_total);

      if (!unitPrice.mul(quantity).equals(itemTotal)) {
        errors.push({ path: [...itemPath, 'item_total'], message: 'Calculation mismatch: unit_price * quantity != item_total' });
      }

      runningTotal.add(itemTotal);
    }

    // Global Order Total Validation
    if (!runningTotal.equals(new Decimal(totalAmount))) {
      errors.push({ path: ['total_amount'], message: 'Order total mismatch' });
    }

    if (errors.length > 0) {
      throw new ValidationError(errors);
    }

    // Object is returned as is, which is already immutable by virtue of being a plain object
    // processed strictly through Zod parsing.
    return Object.freeze(order);
  }

  /**
   * Redacts sensitive data from objects for secure logging.
   */
  public redactPII(data: any): any {
    if (!data || typeof data !== 'object') return data;
    
    const redacted = { ...data };
    if (redacted.shipping_address) {
      redacted.shipping_address = '[REDACTED]';
    }
    if (redacted.payment_token) {
      redacted.payment_token = '[REDACTED]';
    }
    return redacted;
  }
}
