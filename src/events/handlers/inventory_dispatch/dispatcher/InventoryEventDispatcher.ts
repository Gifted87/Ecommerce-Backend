import { Kafka, Producer, ProducerRecord, SASLMechanism } from 'kafkajs';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import { Logger } from 'pino';
import { createHmac } from 'crypto';

/**
 * Zod schema for Inventory Event validation to ensure data integrity
 * before entering the Kafka stream.
 */
export const InventoryEventSchema = z.object({
  type: z.enum(['InventoryReserved', 'InventoryReleased', 'InventoryUpdated']),
  sku: z.string().min(1),
  quantity: z.number().int(),
  correlationId: z.string().uuid(),
  timestamp: z.string().datetime(),
  metadata: z.record(z.any()).optional(),
});

export type InventoryEvent = z.infer<typeof InventoryEventSchema>;

/**
 * Zod schema for Kafka configuration validation.
 */
export const KafkaDispatcherConfigSchema = z.object({
  clientId: z.string().min(1),
  brokers: z.array(z.string().min(1)),
  ssl: z.boolean(),
  sasl: z.object({
    mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
    username: z.string().min(1),
    password: z.string().min(1),
  }).optional(),
  hmacSecret: z.string().min(32),
});

export type KafkaDispatcherConfig = z.infer<typeof KafkaDispatcherConfigSchema>;

/**
 * InventoryEventDispatcher handles reliable, secure, and idempotent
 * publication of inventory events to Kafka.
 */
export class InventoryEventDispatcher {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly producerBreaker: CircuitBreaker;
  private readonly logger: Logger;
  private readonly hmacSecret: string;
  private isInitialized: boolean = false;

  constructor(config: KafkaDispatcherConfig, logger: Logger) {
    const validatedConfig = KafkaDispatcherConfigSchema.parse(config);
    this.hmacSecret = validatedConfig.hmacSecret;
    this.logger = logger.child({ module: 'InventoryEventDispatcher' });

    this.kafka = new Kafka({
      clientId: validatedConfig.clientId,
      brokers: validatedConfig.brokers,
      ssl: validatedConfig.ssl,
      sasl: validatedConfig.sasl ? {
        mechanism: validatedConfig.sasl.mechanism as SASLMechanism,
        username: validatedConfig.sasl.username,
        password: validatedConfig.sasl.password,
      } : undefined,
    });

    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
    });

    this.producerBreaker = new CircuitBreaker(
      async (record: ProducerRecord) => await this.producer.send(record),
      {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.setupBreakerListeners();
  }

  private setupBreakerListeners(): void {
    this.producerBreaker.on('open', () => this.logger.error('InventoryEventDispatcher: Circuit breaker is OPEN'));
    this.producerBreaker.on('halfOpen', () => this.logger.warn('InventoryEventDispatcher: Circuit breaker is HALF-OPEN'));
    this.producerBreaker.on('close', () => this.logger.info('InventoryEventDispatcher: Circuit breaker is CLOSED'));
  }

  private signPayload(payload: InventoryEvent): string {
    return createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  private sanitizeLog(data: Record<string, any>): Record<string, any> {
    const piiKeys = ['user_id', 'email', 'phone', 'ip_address', 'full_name'];
    const sanitized = { ...data };
    for (const key of Object.keys(sanitized)) {
      if (piiKeys.includes(key)) {
        sanitized[key] = '[REDACTED]';
      }
    }
    return sanitized;
  }

  public async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.isInitialized = true;
      this.logger.info('InventoryEventDispatcher: Kafka producer connected');
    } catch (error) {
      this.logger.error({ error }, 'InventoryEventDispatcher: Connection failed');
      throw error;
    }
  }

  public async publish(topic: string, event: InventoryEvent): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('InventoryEventDispatcher: Not initialized. Call connect() first.');
    }

    const validation = InventoryEventSchema.safeParse(event);
    if (!validation.success) {
      this.logger.error({ errors: validation.error.format(), event: this.sanitizeLog(event) }, 'InventoryEventDispatcher: Schema validation failed');
      throw new Error('InventoryEventDispatcher: Schema violation');
    }

    const signature = this.signPayload(event);
    const timestamp = Date.now().toString();

    const record: ProducerRecord = {
      topic,
      messages: [{
        key: event.sku,
        value: JSON.stringify(event),
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
        },
      }],
    };

    try {
      await this.producerBreaker.fire(record);
      this.logger.info(
        { 
          topic, 
          sku: event.sku, 
          correlationId: event.correlationId,
          msg: 'Event published' 
        }, 
        'InventoryEventDispatcher: Event published successfully'
      );
    } catch (error) {
      this.logger.error(
        { 
          topic, 
          sku: event.sku, 
          correlationId: event.correlationId, 
          error: error instanceof Error ? error.message : String(error) 
        }, 
        'InventoryEventDispatcher: Failed to publish event'
      );
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    this.logger.info('InventoryEventDispatcher: Shutting down producer');
    await this.producer.disconnect();
  }
}
