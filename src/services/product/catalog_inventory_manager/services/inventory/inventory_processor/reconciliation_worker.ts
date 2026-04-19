import { Logger } from 'pino';
import { Knex } from 'knex';
import Redis from 'ioredis';
import { Kafka, Producer, Consumer } from 'kafkajs';
import Opossum = require('opossum');
import { z } from 'zod';

/**
 * Zod schema for Inventory Event validation.
 */
const InventoryEventSchema = z.object({
  sku: z.string(),
  type: z.enum(['STOCK_ADDED', 'STOCK_REMOVED', 'STOCK_ADJUSTED']),
  quantityChange: z.number().int(),
  timestamp: z.string().datetime(),
});

type InventoryEvent = z.infer<typeof InventoryEventSchema>;

/**
 * ReconciliationWorker is responsible for maintaining eventual consistency
 * between PostgreSQL and Kafka event streams for inventory management.
 */
export class ReconciliationWorker {
  // Use any to bypass TS namespace issue
  private readonly dbBreaker: any;
  // Use any to bypass TS namespace issue
  private readonly kafkaBreaker: any;

  constructor(
    private readonly db: Knex,
    private readonly redis: Redis,
    private readonly kafka: Kafka,
    private readonly producer: Producer,
    private readonly logger: Logger
  ) {
    const breakerOptions = {
      timeout: 10000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.dbBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), breakerOptions);
    this.kafkaBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), breakerOptions);
  }

  /**
   * Executes the reconciliation process for a specific SKU range.
   */
  public async reconcile(skuRange: string): Promise<void> {
    const lockKey = `recon:lock:${skuRange}`;
    const acquired = await this.redis.set(lockKey, 'locked', 'EX', 300, 'NX');
    
    if (!acquired) {
      this.logger.debug({ skuRange }, 'Reconciliation already in progress for this range');
      return;
    }

    try {
      this.logger.info({ skuRange }, 'Starting inventory reconciliation');

      // 1. Snapshot DB state
      const snapshot = await this.dbBreaker.fire(() => this.captureSnapshot(skuRange));

      // 2. Audit against Kafka events
      for (const item of snapshot) {
        const eventQuantity = await this.calculateExpectedQuantity(item.sku);
        const variance = eventQuantity - item.quantity;

        if (variance !== 0) {
          await this.handleDiscrepancy(item.sku, item.quantity, eventQuantity, variance);
        }
      }
    } catch (err) {
      this.logger.error({ err, skuRange }, 'Reconciliation cycle failed');
      throw err;
    } finally {
      await this.redis.del(lockKey);
      this.logger.info({ skuRange }, 'Reconciliation cycle finished');
    }
  }

  private async captureSnapshot(skuRange: string): Promise<Array<{ sku: string; quantity: number }>> {
    return await this.db.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      return await trx('inventory')
        .select('sku', 'quantity')
        .where('sku', 'like', `${skuRange}%`)
        .forUpdate();
    });
  }

  private async calculateExpectedQuantity(sku: string): Promise<number> {
    // In production, this would query a compacted Kafka topic or materialized view.
    // Here we simulate the fold over history via Kafka consumer.
    const consumer = this.kafka.consumer({ groupId: `recon-group-${sku}` });
    await this.kafkaBreaker.fire(() => consumer.connect());
    await consumer.subscribe({ topic: 'inventory-events', fromBeginning: true });

    let quantity = 0;
    
    await new Promise<void>((resolve, reject) => {
      consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          const data = JSON.parse(message.value.toString());
          const event = InventoryEventSchema.parse(data);

          if (event.sku === sku) {
            if (event.type === 'STOCK_ADDED') quantity += event.quantityChange;
            if (event.type === 'STOCK_REMOVED') quantity -= event.quantityChange;
          }
        },
      }).catch(reject);
      
      // Assume a timeout to process historical events
      setTimeout(async () => {
        await consumer.disconnect();
        resolve();
      }, 5000);
    });

    return quantity;
  }

  private async handleDiscrepancy(sku: string, dbQuantity: number, eventQuantity: number, variance: number): Promise<void> {
    const THRESHOLD = 50;

    if (Math.abs(variance) > THRESHOLD) {
      this.logger.error({ sku, dbQuantity, eventQuantity, variance }, 'CRITICAL_INCONSISTENCY: Manual intervention required');
      return;
    }

    await this.dbBreaker.fire(async () => {
      await this.db('inventory')
        .where({ sku })
        .update({ quantity: eventQuantity, updated_at: this.db.fn.now() });
    });

    await this.kafkaBreaker.fire(() => 
      this.producer.send({
        topic: 'reconciliation-events',
        messages: [{
          key: sku,
          value: JSON.stringify({
            sku,
            oldQuantity: dbQuantity,
            newQuantity: eventQuantity,
            timestamp: new Date().toISOString()
          })
        }]
      })
    );

    this.logger.info({ sku, variance }, 'Discrepancy resolved automatically');
  }
}
