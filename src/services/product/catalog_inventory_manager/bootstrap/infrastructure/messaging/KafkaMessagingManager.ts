import { Kafka, Producer, Consumer, ProducerRecord, EachMessagePayload, SASLOptions, ProducerConfig } from 'kafkajs';
import Opossum = require('opossum');
import { z } from 'zod';
import { Logger } from 'pino';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Zod schema for validated Kafka configuration.
 */
export const KafkaConfigSchema = z.object({
  clientId: z.string(),
  brokers: z.array(z.string()),
  ssl: z.boolean(),
  sasl: z.object({
    mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
    username: z.string(),
    password: z.string(),
  }).optional(),
  hmacSecret: z.string(),
  dlqTopic: z.string().default('error-events'),
});

export type KafkaClientConfig = z.infer<typeof KafkaConfigSchema>;

/**
 * KafkaMessagingManager orchestrates high-throughput, event-driven communication.
 * Provides robust producer/consumer lifecycle management with circuit breakers,
 * cryptographic integrity checks, and centralized error handling (DLQ).
 */
export class KafkaMessagingManager {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  // Use any to bypass TS namespace issue
  private readonly producerBreaker: any;
  private readonly logger: Logger;
  private readonly hmacSecret: string;
  private readonly dlqTopic: string;
  private isShuttingDown: boolean = false;

  constructor(config: KafkaClientConfig, logger: Logger) {
    const validatedConfig = KafkaConfigSchema.parse(config);
    this.logger = logger.child({ module: 'KafkaMessagingManager' });
    this.hmacSecret = validatedConfig.hmacSecret;
    this.dlqTopic = validatedConfig.dlqTopic;

    this.kafka = new Kafka({
      clientId: validatedConfig.clientId,
      brokers: validatedConfig.brokers,
      ssl: validatedConfig.ssl,
      sasl: validatedConfig.sasl ? {
        mechanism: validatedConfig.sasl.mechanism as 'plain' | 'scram-sha-256' | 'scram-sha-512',
        username: validatedConfig.sasl.username,
        password: validatedConfig.sasl.password,
      } as SASLOptions : undefined,
    });

    const producerConfig: ProducerConfig = {
      idempotent: true,
      maxInFlightRequests: 5,
    };

    this.producer = this.kafka.producer(producerConfig);

    this.producerBreaker = new Opossum(
      async (record: ProducerRecord) => await this.producer.send(record),
      {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.setupLifecycleSignals();
    this.setupCircuitBreakerListeners();
  }

  private setupLifecycleSignals(): void {
    const shutdown = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      this.logger.info('Graceful shutdown initiated');
      await this.disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  private setupCircuitBreakerListeners(): void {
    this.producerBreaker.on('open', () => this.logger.error('Circuit breaker: OPEN'));
    this.producerBreaker.on('halfOpen', () => this.logger.warn('Circuit breaker: HALF-OPEN'));
    this.producerBreaker.on('close', () => this.logger.info('Circuit breaker: CLOSED'));
  }

  private signPayload(payload: any): string {
    return createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  private verifySignature(payload: any, signature: string): boolean {
    const expected = this.signPayload(payload);
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  public async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.logger.info('Kafka producer connected');
    } catch (error) {
      this.logger.error({ error }, 'Failed to connect Kafka producer');
      throw error;
    }
  }

  public async publish(topic: string, key: string, message: any, correlationId: string): Promise<void> {
    if (this.isShuttingDown) throw new Error('Manager is shutting down');
    
    const signature = this.signPayload(message);
    const record: ProducerRecord = {
      topic,
      acks: -1, // Wait for all ISRs
      messages: [{
        key,
        value: JSON.stringify(message),
        headers: {
          'x-signature': signature,
          'x-correlation-id': correlationId,
          'x-timestamp': Date.now().toString(),
        },
      }],
    };

    try {
      await this.producerBreaker.fire(record);
    } catch (error) {
      this.logger.error({ topic, key, correlationId, error }, 'Failed to publish message');
      throw error;
    }
  }

  public async createConsumer(
    groupId: string,
    topic: string,
    handler: (payload: any, headers: Record<string, any>) => Promise<void>
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic: pTopic, message } = payload;
        const signature = message.headers?.['x-signature']?.toString();
        const correlationId = message.headers?.['x-correlation-id']?.toString() || 'unknown';

        if (!signature || !this.verifySignature(JSON.parse(message.value?.toString() || '{}'), signature)) {
          this.logger.warn({ pTopic, correlationId }, 'Invalid message signature, rejecting');
          return;
        }

        try {
          const data = JSON.parse(message.value?.toString() || '{}');
          await handler(data, message.headers || {});
        } catch (error) {
          this.logger.error({ pTopic, correlationId, error }, 'Handler failed, routing to DLQ');
          await this.producer.send({
            topic: this.dlqTopic,
            messages: [{
              key: message.key,
              value: message.value,
              headers: {
                ...message.headers,
                'x-error-original-topic': Buffer.from(pTopic),
                'x-error-stack': Buffer.from((error as Error).stack || 'unknown'),
              }
            }]
          });
        }
      }
    });
  }

  public async disconnect(): Promise<void> {
    try {
      await this.producer.disconnect();
      this.logger.info('Kafka producer disconnected');
    } catch (error) {
      this.logger.error({ error }, 'Error disconnecting Kafka producer');
    }
  }
}
