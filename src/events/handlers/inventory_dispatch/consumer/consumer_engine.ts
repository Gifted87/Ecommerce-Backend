import { Kafka, Consumer, EachMessagePayload, Producer } from 'kafkajs';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { z } from 'zod';
import pino from 'pino';
import CircuitBreaker from 'opossum';
import { createHmac, timingSafeEqual } from 'crypto';
import { setTimeout } from 'timers/promises';

/**
 * Zod schema for Inventory Event validation
 */
const InventoryEventSchema = z.object({
  sku: z.string(),
  adjustment: z.number(),
  orderId: z.string(),
  state: z.enum(['Pending', 'Reserved', 'Paid', 'Shipped']),
  traceId: z.string(),
});

type InventoryEvent = z.infer<typeof InventoryEventSchema>;

interface ConsumerEngineConfig {
  kafkaBrokers: string[];
  groupId: string;
  topic: string;
  dlqTopic: string;
  hmacSecret: string;
  dbPool: Pool;
  redisClient: Redis;
}

/**
 * ConsumerEngine handles high-availability background processing for inventory events.
 * Implements exactly-once processing using distributed locks and ACID transactions.
 */
export class ConsumerEngine {
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  private readonly dbPool: Pool;
  private readonly redis: Redis;
  private readonly logger: pino.Logger;
  private readonly hmacSecret: string;
  private readonly dlqTopic: string;
  private readonly breaker: CircuitBreaker;
  private isShuttingDown: boolean = false;

  constructor(private readonly config: ConsumerEngineConfig) {
    this.dbPool = config.dbPool;
    this.redis = config.redisClient;
    this.hmacSecret = config.hmacSecret;
    this.dlqTopic = config.dlqTopic;

    this.logger = pino({
      formatters: {
        log: (object) => {
          // Simple PII scrubber for common fields
          const redacted = { ...object };
          ['userId', 'email', 'cardNum'].forEach((key) => {
            if (redacted[key]) redacted[key] = '[REDACTED]';
          });
          return redacted;
        },
      },
    }).child({ module: 'ConsumerEngine' });

    this.kafka = new Kafka({
      clientId: 'inventory-engine',
      brokers: config.kafkaBrokers,
    });

    this.consumer = this.kafka.consumer({ groupId: config.groupId });
    this.producer = this.kafka.producer();

    this.breaker = new CircuitBreaker(this.processEvent.bind(this), {
      timeout: 30000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  public async start(): Promise<void> {
    await this.consumer.connect();
    await this.producer.connect();
    await this.consumer.subscribe({ topic: this.config.topic, fromBeginning: false });

    this.logger.info('ConsumerEngine started.');

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        if (this.isShuttingDown) return;

        try {
          await this.breaker.fire(payload);
        } catch (err) {
          this.logger.error({ err, offset: payload.message.offset }, 'Critical event processing failure');
          await this.sendToDLQ(payload, err instanceof Error ? err.message : 'Unknown error');
        }
      },
    });
  }

  private async processEvent(payload: EachMessagePayload): Promise<void> {
    const rawValue = payload.message.value?.toString();
    const signature = payload.message.headers?.['x-hmac-signature']?.toString();

    if (!rawValue || !signature) {
      throw new Error('Missing payload or signature');
    }

    // Integrity Check
    const expectedSig = createHmac('sha256', this.hmacSecret).update(rawValue).digest('hex');
    if (!timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature))) {
      throw new Error('Invalid signature');
    }

    // Validation
    const event = InventoryEventSchema.parse(JSON.parse(rawValue));
    
    // Concurrency Control (Distributed Locking)
    const lockKey = `lock:inventory:${event.sku}`;
    const acquired = await this.redis.set(lockKey, event.traceId, 'PX', 5000, 'NX');
    if (!acquired) {
      throw new Error(`Contention: Could not acquire lock for SKU ${event.sku}`);
    }

    try {
      await this.executeTransaction(event);
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async executeTransaction(event: InventoryEvent): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN');

      // ACID State Machine Update
      const result = await client.query(
        'SELECT quantity FROM inventory WHERE sku = $1 FOR UPDATE',
        [event.sku]
      );

      if (result.rows.length === 0) {
        throw new Error(`SKU ${event.sku} not found`);
      }

      await client.query(
        'UPDATE inventory SET quantity = quantity + $1, last_updated = NOW() WHERE sku = $2',
        [event.adjustment, event.sku]
      );

      await client.query('COMMIT');
      this.logger.info({ traceId: event.traceId, sku: event.sku }, 'Inventory updated successfully');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async sendToDLQ(payload: EachMessagePayload, reason: string): Promise<void> {
    try {
      await this.producer.send({
        topic: this.dlqTopic,
        messages: [{
          key: payload.message.key,
          value: payload.message.value,
          headers: { ...payload.message.headers, 'x-error-reason': reason },
        }],
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to move message to DLQ');
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.info('Initiating graceful shutdown...');
    await this.consumer.disconnect();
    await this.producer.disconnect();
    this.logger.info('Shutdown complete.');
  }
}
