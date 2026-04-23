import { Knex } from 'knex';
import { Logger } from 'pino';
import Opossum = require('opossum');
import { OrderModel, OrderModelSchema, OrderStatus } from '../types/order_types';

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
  // Use any to bypass TS namespace issue
  private readonly breaker: any;

  constructor(
    private readonly db: Knex,
    private readonly logger: Logger
  ) {
    this.breaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
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
          
          return this.parseResult(result);
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
  public async updateStatus(orderId: string, status: OrderStatus, trackingNumber?: string, trx?: Knex.Transaction): Promise<OrderModel> {
    return await this.breaker.fire(async () => {
      const start = performance.now();
      try {
        const updateData: any = { status, updated_at: new Date() };
        if (trackingNumber) {
          updateData.tracking_number = trackingNumber;
        }

        const query = this.db(this.tableName)
          .where({ order_id: orderId })
          .update(updateData)
          .returning('*');

        const [result] = await (trx ? query.transacting(trx) : query);

        if (!result) {
          throw new OrderRepositoryError('Order not found', 'NOT_FOUND');
        }

        this.logger.info(
          { operation: 'UPDATE_ORDER_STATUS', duration: performance.now() - start, ...this.redact(result) },
          'Order status updated'
        );

        return this.parseResult(result);
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

        const parsed = this.parseResult(result);

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

  /**
   * Retrieves all orders for a specific user.
   */
  public async listByUserId(userId: string): Promise<OrderModel[]> {
    return await this.breaker.fire(async () => {
      const start = performance.now();
      try {
        const results = await this.db(this.tableName)
          .where({ user_id: userId })
          .orderBy('created_at', 'desc');
        
        const parsedResults = results.map((result) => this.parseResult(result));

        this.logger.debug(
          { operation: 'LIST_ORDERS', duration: performance.now() - start, count: parsedResults.length, userId },
          'Orders listed'
        );

        return parsedResults;
      } catch (error: any) {
        this.logger.error({ operation: 'LIST_ORDERS', userId, error: error.message }, 'Query failed');
        throw new OrderRepositoryError('Query execution failed', 'DB_LIST_ERROR', error);
      }
    });
  }

  /**
   * Retrieves paginated orders for a specific user.
   */
  public async listPaginated(userId: string, limit: number, offset: number): Promise<OrderModel[]> {
    return await this.breaker.fire(async () => {
      const start = performance.now();
      try {
        const results = await this.db(this.tableName)
          .where({ user_id: userId })
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset);
        
        const parsedResults = results.map((result) => this.parseResult(result));

        this.logger.debug(
          { operation: 'LIST_PAGINATED_ORDERS', duration: performance.now() - start, count: parsedResults.length, userId },
          'Orders listed paginated'
        );

        return parsedResults;
      } catch (error: any) {
        this.logger.error({ operation: 'LIST_PAGINATED_ORDERS', userId, error: error.message }, 'Query failed');
        throw new OrderRepositoryError('Query execution failed', 'DB_LIST_ERROR', error);
      }
    });
  }

  /**
   * Executes a callback within a transaction.
   */
  public async runInTransaction<T>(callback: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.db.transaction(callback);
  }

  private parseResult(result: any): OrderModel {
    return OrderModelSchema.parse({
      ...result,
      items: typeof result.items === 'string' ? JSON.parse(result.items) : result.items,
      shipping_address: typeof result.shipping_address === 'string' ? JSON.parse(result.shipping_address) : result.shipping_address,
    });
  }
}
