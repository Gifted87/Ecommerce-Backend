import { 
  Kafka, 
  Producer, 
  Consumer, 
  ProducerRecord, 
  EachMessagePayload, 
  SASLMechanism, 
  ProducerConfig 
} from 'kafkajs';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import { Logger } from 'pino';
import { createHmac, timingSafeEqual } from 'crypto';

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
  dlqTopic: z.string().default('error-events'),
});

export type KafkaClientConfig = z.infer<typeof KafkaConfigSchema>;

/**
 * KafkaInfrastructure provides a production-grade interface for robust,
 * event-driven communication via Kafka, featuring circuit breaking,
 * cryptographic integrity checks, and PII scrubbing.
 */
export class KafkaInfrastructure {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly producerBreaker: CircuitBreaker<[ProducerRecord], any>;
  private readonly logger: Logger;
  private readonly hmacSecret: string;
  private readonly dlqTopic: string;
  private isShuttingDown: boolean = false;

  constructor(config: KafkaClientConfig, logger: Logger) {
    const validatedConfig = KafkaConfigSchema.parse(config);
    this.logger = logger.child({ module: 'KafkaInfrastructure' });
    this.hmacSecret = validatedConfig.hmacSecret;
    this.dlqTopic = validatedConfig.dlqTopic;

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

    const producerConfig: ProducerConfig = {
      idempotent: true,
      maxInFlightRequests: 5,
    };

    this.producer = this.kafka.producer(producerConfig);

    this.producerBreaker = new CircuitBreaker(
      async (record: ProducerRecord) => await this.producer.send(record),
      {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.setupCircuitBreakerListeners();
    this.setupGracefulShutdown();
  }

  private setupCircuitBreakerListeners(): void {
    this.producerBreaker.on('open', () => this.logger.error('Circuit breaker: OPEN'));
    this.producerBreaker.on('halfOpen', () => this.logger.warn('Circuit breaker: HALF-OPEN'));
    this.producerBreaker.on('close', () => this.logger.info('Circuit breaker: CLOSED'));
  }

  private setupGracefulShutdown(): void {
    const shutdown = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      this.logger.info('KafkaInfrastructure: Shutdown initiated');
      try {
        await this.producer.disconnect();
        this.logger.info('KafkaInfrastructure: Shutdown complete');
      } catch (err) {
        this.logger.error({ err }, 'KafkaInfrastructure: Shutdown error');
      }
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  public signPayload(payload: any): string {
    return createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  public verifySignature(payload: any, signature: string): boolean {
    const expected = this.signPayload(payload);
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  public scrubPiI(data: Record<string, any>): Record<string, any> {
    const scrubbed = { ...data };
    const piiKeys = ['userId', 'user_id', 'email', 'phoneNumber', 'user_email', 'password', 'token'];
    for (const key of piiKeys) {
      if (Object.prototype.hasOwnProperty.call(scrubbed, key)) {
        scrubbed[key] = '***REDACTED***';
      }
    }
    return scrubbed;
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

  public async publish(topic: string, key: string, message: any, headers?: Record<string, any>): Promise<void> {
    if (this.isShuttingDown) throw new Error('System is shutting down');

    const signature = this.signPayload(message);
    const record: ProducerRecord = {
      topic,
      acks: -1,
      messages: [{
        key,
        value: JSON.stringify(message),
        headers: {
          ...headers,
          'x-signature': signature,
          'x-correlation-id': headers?.['x-correlation-id'] || 'n/a'
        }
      }],
    };

    try {
      await this.producerBreaker.fire(record);
      this.logger.debug({ topic, key }, 'Message published successfully');
    } catch (error) {
      this.logger.error({ topic, key, error }, 'Failed to publish message');
      throw error;
    }
  }

  public async createConsumer(
    groupId: string,
    topic: string,
    handler: (payload: EachMessagePayload) => Promise<void>
  ): Promise<Consumer> {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const start = Date.now();
        try {
          await handler(payload);
          this.logger.debug({
            topic: payload.topic,
            offset: payload.message.offset,
            duration: Date.now() - start
          }, 'Message processed');
        } catch (error) {
          this.logger.error({
            topic: payload.topic,
            offset: payload.message.offset,
            error
          }, 'Processing error, routing to DLQ');

          await this.producer.send({
            topic: this.dlqTopic,
            messages: [{
              key: payload.message.key,
              value: payload.message.value,
              headers: {
                ...payload.message.headers,
                'x-error-original-topic': Buffer.from(payload.topic),
                'x-error-message': Buffer.from((error as Error).message)
              }
            }]
          });
        }
      },
    });

    return consumer;
  }
}
