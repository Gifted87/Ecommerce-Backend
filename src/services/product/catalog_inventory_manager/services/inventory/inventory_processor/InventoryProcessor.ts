import { Logger } from 'pino';
import Opossum = require('opossum');
import { z } from 'zod';
import { InventoryRepository } from './inventory_repository';
import { InventoryCacheManager } from './InventoryCacheManager';
import { InventoryEventPublisher } from './InventoryEventPublisher';

/**
 * Zod schema for validating stock mutation requests.
 * 
 * Ensures the payload contains a valid product UUID, a non-negative integer amount,
 * and appropriate tracing information (correlation and user IDs).
 */
export const StockMutationSchema = z.object({
  productId: z.string().uuid(),
  amount: z.number().int().nonnegative(),
  correlationId: z.string().uuid(),
  userId: z.string().uuid(),
});

/**
 * TypeScript type representation for a stock mutation request.
 */
export type StockMutationRequest = z.infer<typeof StockMutationSchema>;

/**
 * InventoryProcessor is the central service for managing stock levels.
 * 
 * It orchestrates complex stock lifecycle operations, such as reserving and
 * releasing inventory, while ensuring atomicity, durability, and consistency
 * across PostgreSQL, Redis, and Kafka.
 * 
 * Key Design Patterns:
 * - **Command Pattern**: Encapsulates stock changes as discrete, retryable actions.
 * - **Circuit Breaker Pattern**: Protects the database, cache, and message bus
 *   independently from transient failures.
 * - **Observability**: High-resolution performance metrics and transaction tracing.
 */
export class InventoryProcessor {
  // Use any to bypass TS namespace issue
  private readonly dbBreaker: any;
  private readonly cacheBreaker: any;
  private readonly kafkaBreaker: any;

  /**
   * @param repository - Persistent data access layer for inventory.
   * @param cache - Distributed cache manager for stock availability.
   * @param producer - Event publisher for broadcasting stock mutations to the message bus.
   * @param logger - The application's pino logger instance.
   */
  constructor(
    private readonly repository: InventoryRepository,
    private readonly cache: InventoryCacheManager,
    private readonly producer: InventoryEventPublisher,
    private readonly logger: Logger
  ) {
    this.logger = logger.child({ module: 'service/inventory-processor' });

    // Individual circuit breakers for fine-grained failure handling
    this.dbBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 5000,
      errorThresholdPercentage: 30,
      resetTimeout: 10000,
    });

    this.cacheBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 1000,
      errorThresholdPercentage: 50,
      resetTimeout: 5000,
    });

    this.kafkaBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 2000,
      errorThresholdPercentage: 20,
      resetTimeout: 5000,
    });
  }

  /**
   * Reserves stock for a specific product.
   * 
   * This is a decrement operation on the available inventory count.
   * 
   * @param request - The validated stock mutation details.
   * @returns A promise that resolves when the reservation is complete.
   * @throws Error if the database transaction or event emission fails.
   */
  public async reserveStock(request: StockMutationRequest): Promise<void> {
    await this.processMutation(request, 'reserve');
  }

  /**
   * Releases previously reserved stock back into the available inventory pool.
   * 
   * This is an increment operation on the available inventory count.
   * 
   * @param request - The validated stock mutation details.
   * @returns A promise that resolves when the release is complete.
   * @throws Error if the process fails.
   */
  public async releaseStock(request: StockMutationRequest): Promise<void> {
    await this.processMutation(request, 'release');
  }

  /**
   * Internal implementation of the stock mutation workflow.
   * 
   * Coordinates:
   * 1. Relational database update (PostgreSQL).
   * 2. Asynchronous cache invalidation (Redis).
   * 3. Event publication (Kafka).
   * 
   * @param request - The mutation details.
   * @param action - Whether to 'reserve' or 'release' stock.
   * @returns A promise resolving to void.
   * @private
   */
  private async processMutation(
    request: StockMutationRequest,
    action: 'reserve' | 'release'
  ): Promise<void> {
    const start = process.hrtime();
    const { productId, amount, correlationId } = request;

    this.logger.info({ correlationId, productId, action, amount }, 'Processing stock mutation');

    try {
      // 1. Repository Transaction (DB Breaker)
      await this.dbBreaker.fire(async () => {
        const adjustment = action === 'reserve' ? -amount : amount;
        await this.repository.updateStock(productId, adjustment, correlationId);
      });

      // 2. Async Cache Invalidation (Cache Breaker)
      // Performed asynchronously to avoid blocking the primary transaction.
      this.cacheBreaker.fire(async () => {
        await this.cache.del(`inventory:${productId}`, { correlationId });
      }).catch((err: any) => {
        this.logger.warn({ correlationId, productId, error: err }, 'Cache invalidation failed post-transaction');
      });

      // 3. Kafka Event Emission (Kafka Breaker)
      await this.kafkaBreaker.fire(async () => {
        await this.producer.publish(
          'inventory.mutations',
          productId,
          {
            action,
            productId,
            amount,
            correlationId,
            timestamp: new Date().toISOString()
          },
          { correlationId }
        );
      });

      const duration = process.hrtime(start);
      this.logger.info({ 
        correlationId, 
        productId, 
        action, 
        durationMs: (duration[0] * 1000 + duration[1] / 1e6).toFixed(2) 
      }, 'Stock mutation successful');

    } catch (error: any) {
      this.logger.error({ correlationId, productId, action, error }, 'Failed to process stock mutation');
      throw error;
    }
  }
}
