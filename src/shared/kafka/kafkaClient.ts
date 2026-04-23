
import { Kafka, Producer, Consumer, ProducerRecord, Message, EachMessagePayload } from 'kafkajs';
import Opossum = require('opossum');
import { z } from 'zod';
import { Logger } from 'pino';

const KafkaConfigSchema = z.object({
  clientId: z.string(),
  brokers: z.array(z.string()),
  sasl: z.object({
    mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
    username: z.string(),
    password: z.string(),
  }).optional(),
  ssl: z.boolean(),
});

export type KafkaClientConfig = z.infer<typeof KafkaConfigSchema>;

export class KafkaMessagingClient {
  private kafka: Kafka;
  private producer: Producer;
  // Use any to bypass TS namespace issue
  private producerBreaker: any;
  private logger: Logger;

  constructor(config: KafkaClientConfig, logger: Logger) {
    const validatedConfig = KafkaConfigSchema.parse(config);
    this.logger = logger;

    this.kafka = new Kafka({
      clientId: validatedConfig.clientId,
      brokers: validatedConfig.brokers,
      ssl: validatedConfig.ssl,
      sasl: validatedConfig.sasl ? {
        mechanism: validatedConfig.sasl.mechanism as any,
        username: validatedConfig.sasl.username,
        password: validatedConfig.sasl.password,
      } : undefined,
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

    this.producerBreaker.on('open', () => this.logger.error('Producer circuit breaker opened'));
    this.producerBreaker.on('halfOpen', () => this.logger.warn('Producer circuit breaker half-open'));
    this.producerBreaker.on('close', () => this.logger.info('Producer circuit breaker closed'));
  }

  public async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.logger.info('Kafka producer connected successfully');
    } catch (error) {
      this.logger.error('Failed to connect Kafka producer', { error });
      throw error;
    }
  }

  public async publish(topic: string, key: string, message: any, headers?: Record<string, any>): Promise<void> {
    const record: ProducerRecord = {
      topic,
      messages: [{
        key,
        value: JSON.stringify(message),
        headers,
      }],
    };

    try {
      await this.producerBreaker.fire(record);
    } catch (error) {
      this.logger.error('Failed to publish message via circuit breaker', { topic, key, error });
      throw error;
    }
  }

  public async createConsumer(
    groupId: string,
    topic: string,
    handler: (payload: EachMessagePayload) => Promise<void>,
    dlqTopic: string = 'error-events'
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic: pTopic, partition, message } = payload;
        const start = Date.now();

        try {
          await handler(payload);
          this.logger.debug('Message processed successfully', {
            topic: pTopic,
            partition,
            offset: message.offset,
            duration: Date.now() - start
          });
        } catch (error) {
          this.logger.error('Message processing failed, moving to DLQ', {
            topic: pTopic,
            partition,
            offset: message.offset,
            error
          });

          await this.producer.send({
            topic: dlqTopic,
            messages: [{
              key: message.key,
              value: message.value,
              headers: {
                ...message.headers,
                'x-error-original-topic': Buffer.from(pTopic),
                'x-error-message': Buffer.from((error as Error).message)
              }
            }]
          });
        }
      },
    });
  }

  public async disconnect(): Promise<void> {
    try {
      await this.producer.disconnect();
      this.logger.info('Kafka client disconnected');
    } catch (error) {
      this.logger.error('Error during Kafka client disconnection', { error });
    }
  }
}
