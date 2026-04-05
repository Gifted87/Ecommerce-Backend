import { Decimal } from 'decimal.js';
import { Logger } from 'pino';
import { 
  OrderStatus, 
  OrderTransitions, 
  OrderItem 
} from '../../../domain/order_schemas';

/**
 * Custom error thrown when a requested state transition is not permitted.
 */
export class InvalidTransitionError extends Error {
  constructor(public current: OrderStatus, public next: OrderStatus) {
    super(`Invalid transition from ${current} to ${next}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Custom error thrown when financial calculations do not match the expected totals.
 */
export class CalculationMismatchError extends Error {
  constructor(public message: string) {
    super(message);
    this.name = 'CalculationMismatchError';
  }
}

/**
 * The OrderTransitionEngine is a stateless service responsible for:
 * 1. Validating state machine transitions.
 * 2. High-precision financial arithmetic.
 * 3. Ensuring contextual integrity for state changes.
 */
export class OrderTransitionEngine {
  constructor(private readonly logger: Logger) {}

  /**
   * Validates if the transition from currentStatus to nextStatus is allowed
   * and verifies required context.
   */
  public validateTransition(
    currentStatus: OrderStatus,
    nextStatus: OrderStatus,
    context?: { tracking_number?: string }
  ): void {
    const allowed = OrderTransitions[currentStatus];

    if (!allowed.includes(nextStatus)) {
      this.logger.error({
        msg: 'Illegal state transition attempt',
        current: currentStatus,
        next: nextStatus,
      });
      throw new InvalidTransitionError(currentStatus, nextStatus);
    }

    if (nextStatus === OrderStatus.SHIPPED) {
      if (!context?.tracking_number || context.tracking_number.trim().length === 0) {
        this.logger.error({
          msg: 'Transition to SHIPPED missing tracking number',
          current: currentStatus,
        });
        throw new Error('MISSING_FULFILLMENT_INFO: Tracking number is required for SHIPPED status');
      }
    }
  }

  /**
   * Calculates the total order amount from items and compares it with the expected total.
   * Utilizes decimal.js for financial precision.
   * 
   * @throws CalculationMismatchError if internal calculations do not align.
   */
  public verifyOrderFinancials(items: OrderItem[], totalAmount: string): void {
    let calculatedTotal = new Decimal(0);

    for (const item of items) {
      const unitPrice = new Decimal(item.unit_price);
      const quantity = new Decimal(item.quantity);
      const expectedItemTotal = unitPrice.mul(quantity);
      const actualItemTotal = new Decimal(item.item_total);

      if (!expectedItemTotal.equals(actualItemTotal)) {
        this.logger.error({
          msg: 'Item total calculation mismatch',
          sku: item.sku,
          expected: expectedItemTotal.toString(),
          actual: actualItemTotal.toString(),
        });
        throw new CalculationMismatchError(
          `Mismatch for SKU ${item.sku}: expected ${expectedItemTotal} but got ${actualItemTotal}`
        );
      }

      calculatedTotal = calculatedTotal.add(actualItemTotal);
    }

    const expectedTotal = new Decimal(totalAmount);
    if (!calculatedTotal.equals(expectedTotal)) {
      this.logger.error({
        msg: 'Order total mismatch',
        calculated: calculatedTotal.toString(),
        provided: expectedTotal.toString(),
      });
      throw new CalculationMismatchError('Calculated order total does not match provided total');
    }
  }

  /**
   * Orchestrates the transition validation and log emission.
   * This is the entry point for the order state manager.
   */
  public async processTransition(
    orderId: string,
    currentStatus: OrderStatus,
    nextStatus: OrderStatus,
    context?: { tracking_number?: string }
  ): Promise<void> {
    this.logger.info({
      msg: 'Processing order state transition',
      orderId,
      from: currentStatus,
      to: nextStatus,
    });

    this.validateTransition(currentStatus, nextStatus, context);

    this.logger.info({
      msg: 'Transition validated successfully',
      orderId,
      to: nextStatus,
    });
  }
}
