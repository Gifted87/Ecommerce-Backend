import { Knex } from 'knex';
import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { OrderModel, OrderModelSchema, OrderStatus } from '../types/orderTypes';

/**
 * Custom Error for Repository-level domain exceptions.
 */
export class OrderRepositoryError extends Error {
  constructor(public message: string, public code: string, public originalError?: any) {
    super(message);
    this.name = 'OrderRepositoryError';
  }
}

/**
 * Interface for redaction to prevent PII logging.
 */
interface RedactableOrder {
  order_id: string;
  user_id: string;
  status: OrderStatus;
  total_amount: string;
}

/**
 * Implementation of the OrderRepository.
 * Handles persistent storage for the Checkout State Machine.
 */
export class OrderRepository {
  private readonly tableName = 'orders';
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly db: Knex,
    private readonly logger: Logger
  ) {
    this.breaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  /**
   * Redacts sensitive information from the order model before logging.
   */
  private redact(order: OrderModel): RedactableOrder {
    return {
      order_id: order.order_id,
      user_id: order.user_id,
      status: order.status,
      total_amount: order.total_amount,
    };
  }

  /**
   * Persists a new order within a transaction.
   */
  public async create(orderData: Omit<OrderModel, 'created_at' | 'updated_at'>): Promise<OrderModel> {
    return await this.breaker.fire(async () => {
      const start = performance.now();
      try {
        const validated = OrderModelSchema.parse(orderData);
        
        return await this.db.transaction(async (trx) => {
          const [result] = await trx(this.tableName)
            .insert({
              ...validated,
              items: JSON.stringify(validated.items),
              shipping_address: JSON.stringify(validated.shipping_address),
              created_at: new Date(),
              updated_at: new Date(),
            })
            .returning('*');

          this.logger.info(
            { operation: 'CREATE_ORDER', duration: performance.now() - start, ...this.redact(result) },
            'Order created successfully'
          );
          
          return result;
        });
      } catch (error: any) {
        this.logger.error({ operation: 'CREATE_ORDER', error: error.message }, 'Failed to create order');
        throw new OrderRepositoryError('Persistence failed', 'DB_CREATE_ERROR', error);
      }
    });
  }

  /**
   * Updates an existing order status within a transaction.
   */
  public async updateStatus(orderId: string, status: OrderStatus): Promise<OrderModel> {
    return await this.breaker.fire(async () => {
      const start = performance.now();
      try {
        return await this.db.transaction(async (trx) => {
          const [result] = await trx(this.tableName)
            .where({ order_id: orderId })
            .update({ status, updated_at: new Date() })
            .returning('*');

          if (!result) {
            throw new OrderRepositoryError('Order not found', 'NOT_FOUND');
          }

          this.logger.info(
            { operation: 'UPDATE_ORDER_STATUS', duration: performance.now() - start, ...this.redact(result) },
            'Order status updated'
          );

          return result;
        });
      } catch (error: any) {
        this.logger.error({ operation: 'UPDATE_ORDER_STATUS', orderId, error: error.message }, 'Failed to update order status');
        throw new OrderRepositoryError('Update failed', 'DB_UPDATE_ERROR', error);
      }
    });
  }

  /**
   * Retrieves an order by ID.
   */
  public async findById(orderId: string): Promise<OrderModel | null> {
    return await this.breaker.fire(async () => {
      const start = performance.now();
      try {
        const result = await this.db(this.tableName).where({ order_id: orderId }).first();
        
        if (!result) return null;

        const parsed = OrderModelSchema.parse({
          ...result,
          items: typeof result.items === 'string' ? JSON.parse(result.items) : result.items,
          shipping_address: typeof result.shipping_address === 'string' ? JSON.parse(result.shipping_address) : result.shipping_address,
        });

        this.logger.debug(
          { operation: 'FIND_ORDER', duration: performance.now() - start, ...this.redact(parsed) },
          'Order retrieved'
        );

        return parsed;
      } catch (error: any) {
        this.logger.error({ operation: 'FIND_ORDER', orderId, error: error.message }, 'Query failed');
        throw new OrderRepositoryError('Query execution failed', 'DB_FIND_ERROR', error);
      }
    });
  }
}
