import { Kafka, Producer, ProducerRecord, SASLMechanism } from 'kafkajs';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import { Logger } from 'pino';
import { createHmac } from 'crypto';

/**
 * Custom error types for specific failure scenarios.
 */
export class PublishTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishTimeoutError';
  }
}

export class IntegrityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityValidationError';
  }
}

/**
 * Zod schema for validated Kafka configuration.
 */
export const KafkaConfigSchema = z.object({
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

export type KafkaClientConfig = z.infer<typeof KafkaConfigSchema>;

/**
 * InventoryEventPublisher provides a production-grade interface for broadcasting
 * inventory state changes to Kafka with built-in security, fault tolerance,
 * and observability.
 */
export class InventoryEventPublisher {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly producerBreaker: CircuitBreaker;
  private readonly logger: Logger;
  private readonly hmacSecret: string;
  private isInitialized: boolean = false;

  constructor(config: KafkaClientConfig, logger: Logger) {
    const validatedConfig = KafkaConfigSchema.parse(config);
    this.hmacSecret = validatedConfig.hmacSecret;
    this.logger = logger.child({ module: 'InventoryEventPublisher' });

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
    this.producerBreaker.on('open', () => this.logger.error('InventoryEventPublisher: Circuit breaker is OPEN'));
    this.producerBreaker.on('halfOpen', () => this.logger.warn('InventoryEventPublisher: Circuit breaker is HALF-OPEN'));
    this.producerBreaker.on('close', () => this.logger.info('InventoryEventPublisher: Circuit breaker is CLOSED'));
  }

  private signMessage(payload: Record<string, any>): string {
    return createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  private scrubPiI(data: Record<string, any>): Record<string, any> {
    const scrubbed = { ...data };
    const piiKeys = ['userId', 'user_id', 'email', 'phoneNumber', 'user_email'];
    for (const key of piiKeys) {
      if (key in scrubbed) {
        scrubbed[key] = '***REDACTED***';
      }
    }
    return scrubbed;
  }

  public async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.isInitialized = true;
      this.logger.info('InventoryEventPublisher: Kafka producer connected');
    } catch (error) {
      this.logger.error({ error }, 'InventoryEventPublisher: Connection failed');
      throw error;
    }
  }

  public async publish(
    topic: string, 
    key: string, 
    payload: Record<string, any>, 
    context: Record<string, any> = {}
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Publisher not initialized. Call connect() first.');
    }

    const signature = this.signMessage(payload);
    const timestamp = Date.now().toString();

    const record: ProducerRecord = {
      topic,
      acks: -1,
      messages: [{
        key,
        value: JSON.stringify(payload),
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'x-correlation-id': context.correlationId || 'unknown',
        },
      }],
    };

    try {
      await this.producerBreaker.fire(record);
      this.logger.info(
        { 
          topic, 
          key, 
          context: this.scrubPiI(context), 
          msg: 'Inventory event published successfully' 
        }
      );
    } catch (error) {
      this.logger.error(
        { 
          topic, 
          key, 
          context: this.scrubPiI(context), 
          error, 
          msg: 'Failed to publish inventory event' 
        }
      );
      
      if (error instanceof Error && error.message.includes('timeout')) {
        throw new PublishTimeoutError(error.message);
      }
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    this.logger.info('InventoryEventPublisher: Shutting down producer...');
    await this.producer.disconnect();
    this.logger.info('InventoryEventPublisher: Shutdown complete');
  }
}
