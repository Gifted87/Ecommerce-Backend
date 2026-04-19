import { Kafka, Producer, Consumer, ProducerRecord, EachMessagePayload } from 'kafkajs';
import Opossum = require('opossum');
import { z } from 'zod';
import { Logger } from 'pino';
import { createHmac } from 'crypto';

/**
 * Zod schema for Kafka configuration validation.
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
});

export type KafkaClientConfig = z.infer<typeof KafkaConfigSchema>;

/**
 * KafkaMessagingService provides a production-ready, fault-tolerant interface
 * for event-driven inventory reconciliation, integrating circuit breakers,
 * digital signatures for integrity, and automatic DLQ handling.
 */
export class KafkaMessagingService {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  // Use any to bypass TS namespace issue
  private readonly producerBreaker: any;
  private readonly logger: Logger;
  private readonly hmacSecret: string;
  private readonly dlqTopic = 'inventory-reconciliation-dlq';

  constructor(config: KafkaClientConfig, logger: Logger) {
    const validatedConfig = KafkaConfigSchema.parse(config);
    this.logger = logger.child({ module: 'KafkaMessagingService' });
    this.hmacSecret = validatedConfig.hmacSecret;

    this.kafka = new Kafka({
      clientId: validatedConfig.clientId,
      brokers: validatedConfig.brokers,
      ssl: validatedConfig.ssl,
      sasl: validatedConfig.sasl ? {
        mechanism: validatedConfig.sasl.mechanism as any,
        username: validatedConfig.sasl.username,
        password: validatedConfig.sasl.password,
      } as any : undefined,
    });

    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
    });

    this.producerBreaker = new Opossum(
      async (record: ProducerRecord) => await this.producer.send(record),
      {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.setupCircuitBreakerListeners();
  }

  private setupCircuitBreakerListeners(): void {
    this.producerBreaker.on('open', () => this.logger.error('Kafka producer circuit breaker: OPEN'));
    this.producerBreaker.on('halfOpen', () => this.logger.warn('Kafka producer circuit breaker: HALF-OPEN'));
    this.producerBreaker.on('close', () => this.logger.info('Kafka producer circuit breaker: CLOSED'));
  }

  private signMessage(payload: any): string {
    return createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  public async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.logger.info('Kafka producer connected successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to connect Kafka producer');
      throw error;
    }
  }

  public async publish(topic: string, key: string, message: any): Promise<void> {
    const signature = this.signMessage(message);
    const record: ProducerRecord = {
      topic,
      acks: -1,
      messages: [{
        key,
        value: JSON.stringify(message),
        headers: {
          'x-signature': signature,
          'x-timestamp': Date.now().toString(),
        },
      }],
    };

    try {
      await this.producerBreaker.fire(record);
      this.logger.debug({ topic, key }, 'Message published successfully');
    } catch (error) {
      this.logger.error({ topic, key, error }, 'Failed to publish message via circuit breaker');
      throw error;
    }
  }

  public async createConsumer(
    groupId: string,
    topic: string,
    handler: (payload: any) => Promise<void>
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic: pTopic, partition, message } = payload;
        
        try {
          const rawValue = message.value?.toString();
          if (!rawValue) return;

          const data = JSON.parse(rawValue);
          const signature = message.headers?.['x-signature']?.toString();

          if (signature !== this.signMessage(data)) {
            throw new Error('Message integrity check failed: Invalid signature');
          }

          await handler(data);
        } catch (error) {
          this.logger.error({
            topic: pTopic,
            partition,
            offset: message.offset,
            error: (error as Error).message
          }, 'Message processing failed, routing to DLQ');

          await this.producer.send({
            topic: this.dlqTopic,
            messages: [{
              key: message.key,
              value: message.value,
              headers: {
                ...message.headers,
                'x-error-original-topic': Buffer.from(pTopic),
                'x-error-message': Buffer.from((error as Error).message),
              }
            }]
          });
        }
      },
    });
  }

  public async disconnect(): Promise<void> {
    await this.producer.disconnect();
    this.logger.info('Kafka producer disconnected');
  }
}
