import { Logger } from 'pino';
import Opossum = require('opossum');
import { 
  OrderStatus, 
  OrderModel 
} from '../types/order_types';
import { DistributedLockService } from '../infrastructure/lock/DistributedLockService';
import { CheckoutEventProducer } from '../infrastructure/events/CheckoutEventProducer';
import { OrderTransitionEngine } from '../logic/OrderTransitionEngine';

/**
 * Interface for the Order repository dependency.
 */
export interface IOrderRepository {
  findById(orderId: string): Promise<OrderModel | null>;
  updateStatus(orderId: string, status: OrderStatus, trackingNumber?: string): Promise<OrderModel>;
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}

/**
 * Custom error class for order management failures.
 */
export class OrderStateError extends Error {
  constructor(public message: string, public code: string) {
    super(message);
    this.name = 'OrderStateError';
  }
}

/**
 * OrderStateManager coordinates order lifecycle state transitions.
 * It ensures ACID compliance, atomicity via locking, and event consistency.
 */
export class OrderStateManager {
  // Use any to bypass TS namespace issue
  private readonly breaker: any;

  constructor(
    private readonly repository: IOrderRepository,
    private readonly lockService: DistributedLockService,
    private readonly eventProducer: CheckoutEventProducer,
    private readonly transitionEngine: OrderTransitionEngine,
    private readonly logger: Logger
  ) {
    // Circuit breaker tuned for production: 3s timeout
    const options = {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breaker = new Opossum(this.executeTransition.bind(this), options);
  }

  /**
   * Retrieves an order by ID.
   */
  public async getOrderById(orderId: string): Promise<OrderModel | null> {
    return await this.repository.findById(orderId);
  }

  /**
   * Lists orders for a specific user.
   */
  public async listOrdersByUserId(userId: string): Promise<OrderModel[]> {
    // Cast repository to any if listByUserId is not in the interface but exists in the implementation
    // However, I updated the implementation, so I'll cast it here
    return await (this.repository as any).listByUserId(userId);
  }

  /**
   * Primary entry point to transition an order status.
   */
  public async transitionOrder(
    orderId: string,
    targetStatus: OrderStatus,
    metadata?: { tracking_number?: string }
  ): Promise<OrderModel> {
    this.logger.info({ orderId, targetStatus, metadata }, 'Attempting order state transition');

    try {
      return await this.breaker.fire(orderId, targetStatus, metadata);
    } catch (error) {
      this.logger.error({ orderId, targetStatus, error }, 'Order transition failed');
      throw error;
    }
  }

  /**
   * Internal logic executed within circuit breaker and distributed lock.
   */
  private async executeTransition(
    orderId: string,
    targetStatus: OrderStatus,
    metadata?: { tracking_number?: string }
  ): Promise<OrderModel> {
    return await this.lockService.withLock(orderId, async () => {
      // 1. Fetch current order
      const order = await this.repository.findById(orderId);
      if (!order) {
        throw new OrderStateError(`Order not found: ${orderId}`, 'NOT_FOUND');
      }

      // 2. Validate transition
      await this.transitionEngine.processTransition(orderId, order.status, targetStatus, metadata);

      // Idempotency check: if current status already equals target, return order
      if (order.status === targetStatus) {
        this.logger.info({ orderId, status: targetStatus }, 'Order already at target status, skipping');
        return order;
      }

      // 3. Mutate DB and Publish Event in Transaction
      return await this.repository.runInTransaction(async () => {
        const updatedOrder = await this.repository.updateStatus(
          orderId,
          targetStatus,
          metadata?.tracking_number
        );

        try {
          await this.eventProducer.publishOrderUpdated(updatedOrder);
        } catch (eventError) {
          this.logger.error({ orderId, error: eventError }, 'Failed to publish event, rolling back transaction');
          // Re-throw to trigger transaction rollback if critical
          throw new OrderStateError('Event publication failed, rolling back', 'TRANSACTION_ROLLBACK');
        }

        this.logger.info({ orderId, prevStatus: order.status, newStatus: targetStatus }, 'Order status updated successfully');
        return updatedOrder;
      });
    });
  }
}
