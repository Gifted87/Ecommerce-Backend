import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import { InventoryRepository } from '../repository/InventoryRepository';
import { RedisClient } from '../cache/RedisClient';
import { KafkaProducerClient } from '../event/KafkaProducerClient';

/**
 * Schema for stock mutation requests.
 */
export const StockMutationSchema = z.object({
  productId: z.string().uuid(),
  amount: z.number().int().nonnegative(),
  correlationId: z.string().uuid(),
  userId: z.string().uuid(),
});

export type StockMutationRequest = z.infer<typeof StockMutationSchema>;

/**
 * Inventory Processor responsible for orchestrating stock lifecycle.
 * Implements Command pattern for atomic, durable, and cache-consistent updates.
 */
export class InventoryProcessor {
  private readonly dbBreaker: CircuitBreaker;
  private readonly cacheBreaker: CircuitBreaker;
  private readonly kafkaBreaker: CircuitBreaker;

  constructor(
    private readonly repository: InventoryRepository,
    private readonly cache: RedisClient,
    private readonly producer: KafkaProducerClient,
    private readonly logger: Logger
  ) {
    this.logger = logger.child({ module: 'service/inventory-processor' });

    // Circuit breakers with specific configurations per requirement
    this.dbBreaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 5000,
      errorThresholdPercentage: 30,
      resetTimeout: 10000,
    });

    this.cacheBreaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 1000,
      errorThresholdPercentage: 50,
      resetTimeout: 5000,
    });

    this.kafkaBreaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 2000,
      errorThresholdPercentage: 20,
      resetTimeout: 5000,
    });
  }

  /**
   * Reserves stock via repository update, cache invalidation, and event dispatch.
   */
  public async reserveStock(request: StockMutationRequest): Promise<void> {
    await this.processMutation(request, 'reserve');
  }

  /**
   * Releases stock via repository update, cache invalidation, and event dispatch.
   */
  public async releaseStock(request: StockMutationRequest): Promise<void> {
    await this.processMutation(request, 'release');
  }

  private async processMutation(
    request: StockMutationRequest,
    action: 'reserve' | 'release'
  ): Promise<void> {
    const start = process.hrtime();
    const { productId, amount, correlationId } = request;

    this.logger.info({ correlationId, productId, action, amount }, 'Processing stock mutation');

    try {
      // 1. Repository Transaction
      await this.dbBreaker.fire(async () => {
        if (action === 'reserve') {
          await this.repository.reserveStock(productId, amount);
        } else {
          await this.repository.releaseStock(productId, amount);
        }
      });

      // 2. Async Cache Invalidation
      // Fire and forget or handle error without failing transaction
      this.cacheBreaker.fire(async () => {
        await this.cache.del(`inventory:${productId}`);
      }).catch((err) => {
        this.logger.warn({ correlationId, productId, error: err }, 'Cache invalidation failed post-transaction');
      });

      // 3. Kafka Event Emission
      await this.kafkaBreaker.fire(async () => {
        await this.producer.send({
          topic: 'inventory.mutations',
          messages: [{
            key: productId,
            value: JSON.stringify({
              action,
              productId,
              amount,
              correlationId,
              timestamp: new Date().toISOString()
            }),
            headers: { correlationId }
          }],
        });
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
