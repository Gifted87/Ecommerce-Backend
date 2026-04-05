import { Kafka, Producer, ProducerRecord } from 'kafkajs';
import { z } from 'zod';
import { Logger } from 'pino';
import * as crypto from 'crypto';
import CircuitBreaker from 'opossum';

/**
 * Interface for components that support graceful shutdown.
 */
export interface GracefulShutdownComponent {
  name: string;
  shutdown: () => Promise<void>;
}

/**
 * Inventory Event Types
 */
export enum InventoryEventType {
  Reserved = 'RESERVED',
  Released = 'RELEASED',
  StockAdjusted = 'STOCK_ADJUSTED',
}

/**
 * Zod schema for Inventory events.
 */
export const InventoryEventSchema = z.object({
  type: z.nativeEnum(InventoryEventType),
  productId: z.string().uuid(),
  quantity: z.number().int(),
  timestamp: z.string().datetime(),
  correlationId: z.string().uuid(),
});

export type InventoryEvent = z.infer<typeof InventoryEventSchema>;

/**
 * InventoryEventDispatcher orchestrates the reliable, secure, and resilient dispatch
 * of inventory events to Kafka.
 */
export class InventoryEventDispatcher implements GracefulShutdownComponent {
  public readonly name = 'InventoryEventDispatcher';
  private readonly producer: Producer;
  private readonly breaker: CircuitBreaker;
  private readonly hmacSecret: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly logger: Logger,
    hmacSecret?: string
  ) {
    this.hmacSecret = hmacSecret || process.env.HMAC_SECRET || 'fallback-secret-for-dev-only';
    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      retry: {
        initialRetryTime: 100,
        retries: 5,
      },
    });

    // Circuit Breaker configuration per requirement
    const breakerOptions = {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breaker = new CircuitBreaker(this.sendToKafka.bind(this), breakerOptions);

    this.breaker.on('open', () => this.logger.error({ module: this.name }, 'Circuit breaker opened'));
    this.breaker.on('halfOpen', () => this.logger.warn({ module: this.name }, 'Circuit breaker half-open'));
    this.breaker.on('close', () => this.logger.info({ module: this.name }, 'Circuit breaker closed'));
  }

  /**
   * Initializes the Kafka producer connection.
   */
  public async connect(): Promise<void> {
    await this.producer.connect();
    this.logger.info({ module: this.name }, 'Kafka producer connected');
  }

  /**
   * Dispatches an inventory event after validation and signing.
   */
  public async dispatch(event: InventoryEvent): Promise<void> {
    const validation = InventoryEventSchema.safeParse(event);
    if (!validation.success) {
      this.logger.error({ module: this.name, error: validation.error }, 'Invalid event schema');
      throw new Error('Schema validation failed');
    }

    try {
      await this.breaker.fire(validation.data);
    } catch (error) {
      this.logger.error({ module: this.name, error, correlationId: event.correlationId }, 'Failed to dispatch event');
      throw error;
    }
  }

  /**
   * Performs the actual Kafka production logic.
   */
  private async sendToKafka(event: InventoryEvent): Promise<void> {
    const payload = JSON.stringify(event);
    const signature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(payload)
      .digest('hex');

    const record: ProducerRecord = {
      topic: 'inventory-events',
      messages: [
        {
          value: payload,
          headers: {
            'x-signature': signature,
            'x-correlation-id': event.correlationId,
          },
        },
      ],
      acks: -1, // Wait for all replicas
    };

    await this.producer.send(record);
    this.logger.info({ 
      module: this.name, 
      correlationId: event.correlationId,
      eventType: event.type 
    }, 'Event dispatched successfully');
  }

  /**
   * Graceful shutdown of the dispatcher.
   */
  public async shutdown(): Promise<void> {
    this.logger.info({ module: this.name }, 'Shutting down producer...');
    await this.producer.disconnect();
    this.logger.info({ module: this.name }, 'Producer disconnected successfully');
  }
}
