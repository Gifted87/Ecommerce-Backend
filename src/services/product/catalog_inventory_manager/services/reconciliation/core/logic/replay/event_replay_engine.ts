import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import { z } from 'zod';
import { Logger } from 'pino';
import Opossum = require('opossum');
import Redlock from 'redlock';

/**
 * Event validation schemas.
 */
const InventoryEventSchema = z.object({
  sku: z.string(),
  adjustment: z.number(),
  timestamp: z.string(),
  orderId: z.string().optional(),
});

type InventoryEvent = z.infer<typeof InventoryEventSchema>;

/**
 * Replay engine configuration interface.
 */
export interface ReplayEngineConfig {
  kafkaBrokers: string[];
  groupId: string;
  topic: string;
  dbPool: Pool;
  redisClient: Redis;
  logger: Logger;
}

/**
 * EventReplayEngine handles the asynchronous reconciliation of inventory state
 * by aggregating historical events and reconciling them against DB state.
 */
export class EventReplayEngine {
  private readonly kafka: Kafka;
  private readonly consumer: import('kafkajs').Consumer;
  private readonly producer: import('kafkajs').Producer;
  private readonly dbPool: Pool;
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly redlock: Redlock;
  // Use any to bypass TS namespace issue
  private readonly breaker: any;

  constructor(private readonly config: ReplayEngineConfig) {
    this.dbPool = config.dbPool;
    this.redis = config.redisClient;
    this.logger = config.logger.child({ module: 'EventReplayEngine' });

    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });

    this.kafka = new Kafka({
      clientId: 'inventory-replay-engine',
      brokers: config.kafkaBrokers,
    });

    this.consumer = this.kafka.consumer({ groupId: config.groupId });
    this.producer = this.kafka.producer();

    this.breaker = new Opossum(this.processEvent.bind(this), {
      timeout: 10000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  /**
   * Starts the consumption loop for the replay process.
   */
  public async start(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.config.topic, fromBeginning: true });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        try {
          await this.breaker.fire(payload);
        } catch (error) {
          this.logger.error({ error, offset: payload.message.offset }, 'Failed to process event through breaker. Moving to DLQ.');
          
          // Publish to Dead Letter Queue
          try {
            await this.producer.send({
              topic: 'error-events',
              messages: [{
                key: payload.message.key,
                value: payload.message.value,
                headers: {
                  ...payload.message.headers,
                  'X-Error-Reason': Buffer.from((error as Error).message || 'Unknown breaker failure'),
                  'X-Original-Topic': Buffer.from(payload.topic)
                }
              }]
            });
          } catch (dlqError) {
            this.logger.error({ error: dlqError, offset: payload.message.offset }, 'CRITICAL: Failed to publish to DLQ!');
          }
        }
      },
    });
  }

  /**
   * Processes an individual event, updates local aggregate state,
   * and performs reconciliation in PostgreSQL.
   */
  private async processEvent(payload: EachMessagePayload): Promise<void> {
    const messageValue = payload.message.value?.toString();
    if (!messageValue) return;

    const event = InventoryEventSchema.parse(JSON.parse(messageValue));
    const lockKey = `reconciliation:lock:${event.sku}`;

    let lock;
    try {
      lock = await this.redlock.acquire([lockKey], 60000);
    } catch (err) {
      this.logger.warn({ sku: event.sku }, 'Reconciliation already in progress for SKU');
      return;
    }

    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN');

      // ACID compliant row-level locking
      const res = await client.query(
        'SELECT quantity FROM inventory WHERE sku = $1 FOR UPDATE',
        [event.sku]
      );

      if (res.rows.length === 0) {
        throw new Error(`SKU ${event.sku} not found in inventory`);
      }

      const currentQuantity = res.rows[0].quantity;
      const expectedQuantity = currentQuantity + event.adjustment;

      await client.query(
        'UPDATE inventory SET quantity = $1, last_updated = NOW() WHERE sku = $2',
        [expectedQuantity, event.sku]
      );

      await client.query('COMMIT');
      this.logger.info({ sku: event.sku, adjustment: event.adjustment, newQuantity: expectedQuantity }, 'Reconciliation applied');
    } catch (error) {
      await client.query('ROLLBACK');
      this.logger.error({ error, sku: event.sku }, 'Critical reconciliation failure');
      throw error;
    } finally {
      client.release();
      if (lock) {
        await lock.release().catch((e) => this.logger.error({ error: e }, 'Failed to release Redlock'));
      }
    }
  }

  public async stop(): Promise<void> {
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }
}
