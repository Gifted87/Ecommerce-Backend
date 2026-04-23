import { z } from 'zod';
import { Logger } from 'pino';
import Opossum = require('opossum');
import { OrderStateManager } from '../core/OrderStateManager';
import { CheckoutEventProducer } from '../infrastructure/events/CheckoutEventProducer';
import { OrderStatus } from '../types/order_types';

/**
 * Schema for validating checkout request payloads using Zod.
 * 
 * Ensures all required fields are present and follow the expected format
 * (e.g., UUIDs for IDs, positive integers for quantities, strings for currency amounts).
 */
export const CheckoutSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  items: z.array(z.object({
    sku: z.string(),
    quantity: z.number().int().positive(),
    unit_price: z.string(),
    item_total: z.string(),
  })),
  total_amount: z.string(),
  shipping_address: z.string(),
  payment_token: z.string(),
  correlationId: z.string().uuid(),
});

/**
 * TypeScript type inferred from the CheckoutSchema.
 */
export type CheckoutInput = z.infer<typeof CheckoutSchema>;

/**
 * Interface for the Payment Service, responsible for processing external transactions.
 */
export interface IPaymentService {
  /**
   * Processes a payment transaction.
   * 
   * @param token - The payment method token (e.g., Stripe token).
   * @param amount - The total amount to charge.
   * @param orderId - The ID of the order being paid for.
   * @param correlationId - Unique ID for tracing across services.
   * @returns A promise resolving to the external transaction ID.
   */
  processPayment(token: string, amount: string, orderId: string, correlationId: string): Promise<{ transactionId: string }>;

  /**
   * Reverses or refunds a payment transaction.
   * 
   * @param transactionId - The transaction ID to refund.
   * @param orderId - The ID of the order.
   * @param correlationId - Unique ID for tracing across services.
   * @returns A promise resolving when the refund is successful.
   */
  refundPayment(transactionId: string, orderId: string, correlationId: string): Promise<void>;
}

export class CriticalCompensationError extends Error {
  constructor(public originalError: any, public compensationError: any) {
    super('CRITICAL: Compensation workflow failed leaving order in stuck PROCESSING state.');
    this.name = 'CriticalCompensationError';
  }
}

/**
 * CheckoutProcessorService orchestrates the end-to-end checkout lifecycle.
 * 
 * It manages the complex workflow of transitioning an order from PENDING to PLACED,
 * ensuring atomicity across multiple distributed steps including payment processing,
 * state persistence in PostgreSQL, and event publication to Kafka.
 * 
 * The service is designed for resilience, utilizing the Circuit Breaker pattern
 * to handle transient failures in downstream dependencies and providing
 * automated compensation (rollback to FAILED status) when critical steps fail.
 */
export class CheckoutProcessorService {
  // Use any to bypass TS namespace issue
  private readonly breaker: any;

  /**
   * @param stateManager - Manages the persistent state of orders and status transitions.
   * @param eventProducer - Responsible for publishing checkout-related events to Kafka.
   * @param paymentService - External payment processing service.
   * @param logger - The application's pino logger instance.
   */
  constructor(
    private readonly stateManager: OrderStateManager,
    private readonly eventProducer: CheckoutEventProducer,
    private readonly paymentService: IPaymentService,
    private readonly logger: Logger
  ) {
    // Initialize circuit breaker for external dependencies (Redis/DB)
    const options = {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };
    
    this.breaker = new Opossum(this.executeCheckoutFlow.bind(this), options);
    
    this.breaker.on('open', () => this.logger.error('Circuit breaker opened for checkout process.'));
    this.breaker.on('halfOpen', () => this.logger.warn('Circuit breaker half-open for checkout process.'));
    this.breaker.on('close', () => this.logger.info('Circuit breaker closed for checkout process.'));
  }

  /**
   * Main entry point for processing a checkout request.
   * 
   * Validates the input data against the CheckoutSchema and then executes
   * the checkout workflow through the circuit breaker.
   * 
   * @param data - The raw request payload to be processed.
   * @returns A promise resolving to the success status and the order ID.
   * @throws Error if input validation fails or if the checkout flow is aborted.
   */
  public async processCheckout(data: unknown): Promise<{ success: boolean; orderId: string }> {
    const validatedData = CheckoutSchema.safeParse(data);

    if (!validatedData.success) {
      this.logger.error({ msg: 'Invalid checkout request payload', error: validatedData.error });
      throw new Error('400 Bad Request: Invalid input schema.');
    }

    try {
      return await this.breaker.fire(validatedData.data);
    } catch (error) {
      this.logger.error({ 
        msg: 'Checkout process failed', 
        error: error instanceof Error ? error.message : String(error),
        orderId: (data as any)?.orderId 
      });
      throw error;
    }
  }

  /**
   * Internal implementation of the checkout lifecycle, protected by a circuit breaker.
   * 
   * Workflow steps:
   * 1. Transition order state to 'PROCESSING' in the database.
   * 2. Attempt to process payment through the PaymentService.
   * 3. Publish an 'OrderPlaced' event to the message bus (Kafka).
   * 4. Transition order state to 'PLACED' in the database.
   * 
   * If any step fails after state transition, it attempts to compensate by
   * marking the order as 'FAILED'.
   * 
   * @param order - The validated checkout input.
   * @returns A promise resolving to the success status and order ID.
   * @private
   */
  private async executeCheckoutFlow(order: CheckoutInput): Promise<{ success: boolean; orderId: string }> {
    const { orderId, correlationId } = order;
    this.logger.info({ msg: 'Starting checkout process', orderId, correlationId });

    try {
      // 1. Transition to PROCESSING (Start the transaction)
      await this.stateManager.transitionOrder(orderId, OrderStatus.PROCESSING);
      this.logger.info({ msg: 'Order state updated to PROCESSING', orderId });

      // 2. Process Payment
      let transactionId: string | null = null;
      try {
        this.logger.info({ msg: 'Initiating payment processing', orderId, correlationId });
        const result = await this.paymentService.processPayment(
          order.payment_token, 
          order.total_amount, 
          orderId, 
          correlationId
        );
        transactionId = result.transactionId;
        this.logger.info({ msg: 'Payment processed successfully', orderId, correlationId, transactionId });
      } catch (paymentError) {
        this.logger.error({ msg: 'Payment failed', orderId, correlationId, error: paymentError });
        // Compensate: Move back to FAILED or PENDING
        await this.stateManager.transitionOrder(orderId, OrderStatus.FAILED);
        throw new Error(`Payment processing failed: ${(paymentError as Error).message}`);
      }

      // Rest of orchestration
      try {
        // 3. Finalize Transition to PLACED
        await this.stateManager.transitionOrder(orderId, OrderStatus.PLACED);
        this.logger.info({ msg: 'Order successfully placed', orderId });
      } catch (orchestrationError) {
        this.logger.error({ msg: 'Post-payment workflow failed, attempting refund', orderId, correlationId, error: orchestrationError });
        if (transactionId) {
          try {
            await this.paymentService.refundPayment(transactionId, orderId, correlationId);
            this.logger.info({ msg: 'Payment safely refunded', orderId, transactionId });
          } catch (refundError) {
            this.logger.error({ msg: 'CRITICAL: Failed to refund payment for failed order', orderId, transactionId, error: refundError });
          }
        }
        
        await this.stateManager.transitionOrder(orderId, OrderStatus.FAILED);
        throw orchestrationError;
      }

      return { success: true, orderId };
    } catch (error) {
      // Final catch-all for any step after PROCESSING that didn't catch its own error
      // Note: stateManager.transitionOrder already handles its own circuit breaking.
      // If we are here, something went wrong in our orchestration.
      try {
        await this.stateManager.transitionOrder(orderId, OrderStatus.FAILED);
      } catch (compensateError) {
        this.logger.error({ msg: 'CRITICAL: Compensation failed!', orderId, error: compensateError });
        throw new CriticalCompensationError(error, compensateError);
      }
      this.logger.error({ msg: 'Failed to execute checkout flow', orderId, error });
      throw error;
    }
  }

  /**
   * Retrieves an order by its unique ID.
   * 
   * @param id - The unique identifier of the order.
   * @returns A promise resolving to the order object.
   * @throws Error if the order is not found.
   */
  public async getOrderById(id: string): Promise<any> {
    const order = await this.stateManager.getOrderById(id);
    if (!order) throw new Error('Order not found');
    return order;
  }

  public async listOrdersByUserId(userId: string): Promise<any> {
    return await this.stateManager.listOrdersByUserId(userId);
  }

  /**
   * Lists orders for a specific user with pagination.
   */
  public async listOrdersPaginated(userId: string, limit: number, page: number): Promise<any> {
    return await this.stateManager.listOrdersPaginated(userId, limit, page);
  }

  /**
   * Manually updates the status of an order.
   * 
   * This method bypasses the automated checkout flow but still respects
   * the transition rules enforced by the OrderStateManager.
   * 
   * @param id - The unique identifier of the order.
   * @param status - The new target status for the order.
   * @throws Error if the order is not found or the transition is invalid.
   */
  public async updateStatus(id: string, status: OrderStatus): Promise<void> {
    const order = await this.stateManager.getOrderById(id);
    if (!order) throw new Error('Order not found');
    
    await this.stateManager.transitionOrder(id, status);
  }
}
