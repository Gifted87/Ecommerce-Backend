import { z } from 'zod';
import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { StateManager } from '../state/StateManager';
import { CheckoutEventProducer } from '../events/CheckoutEventProducer';

/**
 * Schema for checkout input validation.
 */
export const CheckoutSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
    price: z.number().positive(),
  })),
  totalAmount: z.number().positive(),
  correlationId: z.string().uuid(),
});

export type CheckoutInput = z.infer<typeof CheckoutSchema>;

/**
 * Service orchestrating the checkout process lifecycle.
 * Manages state transition atomicity, concurrency control, and event publication.
 */
export class CheckoutProcessorService {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly stateManager: StateManager,
    private readonly eventProducer: CheckoutEventProducer,
    private readonly logger: Logger
  ) {
    // Initialize circuit breaker for external dependencies (Redis/DB)
    const options = {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };
    
    this.breaker = new CircuitBreaker(this.executeCheckoutFlow.bind(this), options);
    
    this.breaker.on('open', () => this.logger.error('Circuit breaker opened for checkout process.'));
    this.breaker.on('halfOpen', () => this.logger.warn('Circuit breaker half-open for checkout process.'));
    this.breaker.on('close', () => this.logger.info('Circuit breaker closed for checkout process.'));
  }

  /**
   * Main entry point for processing a checkout request.
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
   * Internal implementation of the checkout lifecycle.
   */
  private async executeCheckoutFlow(order: CheckoutInput): Promise<{ success: boolean; orderId: string }> {
    const { orderId, correlationId } = order;
    this.logger.info({ msg: 'Starting checkout process', orderId, correlationId });

    // 1. Acquire Distributed Lock
    const lockKey = `lock:order:${orderId}`;
    const acquired = await this.stateManager.acquireLock(lockKey, 10000);
    
    if (!acquired) {
      throw new Error('Conflict: Could not acquire lock for order processing.');
    }

    try {
      // 2. Validate State Transition
      const canTransition = await this.stateManager.canTransition(orderId, 'PENDING', 'PROCESSING');
      if (!canTransition) {
        throw new Error('Invalid state transition requested.');
      }

      // 3. Persist State
      await this.stateManager.updateOrderState(orderId, 'PROCESSING');
      this.logger.info({ msg: 'Order state updated to PROCESSING', orderId });

      // 4. Publish Event
      // Cast is safe as per domain structure alignment
      await this.eventProducer.publishOrderPlaced(order as any);
      this.logger.info({ msg: 'Order placed event published', orderId });

      // 5. Finalize Transition
      await this.stateManager.updateOrderState(orderId, 'PLACED');
      this.logger.info({ msg: 'Order successfully placed', orderId });

      return { success: true, orderId };
    } finally {
      // 6. Always Release Lock
      await this.stateManager.releaseLock(lockKey);
    }
  }
}
