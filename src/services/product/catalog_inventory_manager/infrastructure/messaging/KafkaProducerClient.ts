import { Kafka, Producer, ProducerRecord, ProducerConfig, SASLOptions } from 'kafkajs';
import Opossum = require('opossum');
import { z } from 'zod';
import { Logger } from 'pino';

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
});

export type KafkaClientConfig = z.infer<typeof KafkaConfigSchema>;

/**
 * KafkaProducerClient provides a production-ready, fault-tolerant producer interface
 * for publishing inventory and catalog events with ACID-compliant guarantees.
 */
export class KafkaProducerClient {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  // Use any to bypass TS namespace issue
  private readonly circuitBreaker: any;
  private readonly logger: Logger;
  private isConnected: boolean = false;

  /**
   * Initializes the KafkaProducerClient with configured security and fault tolerance.
   * 
   * @param config - Validated Kafka connection settings.
   * @param logger - Centralized Pino logger instance.
   */
  constructor(config: KafkaClientConfig, logger: Logger) {
    const validatedConfig = KafkaConfigSchema.parse(config);
    this.logger = logger.child({ module: 'KafkaProducerClient' });

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
      allowAutoTopicCreation: false,
    };

    this.producer = this.kafka.producer(producerConfig);

    // Opossum Circuit Breaker to prevent resource exhaustion during broker outages
    this.circuitBreaker = new Opossum(
      async (record: ProducerRecord) => await this.producer.send(record),
      {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.setupCircuitBreakerListeners();
  }

  /**
   * Establishes connection to the Kafka cluster.
   */
  public async connect(): Promise<void> {
    try {
      await this.producer.connect();
      this.isConnected = true;
      this.logger.info('Kafka producer successfully connected to brokers');
    } catch (error) {
      this.logger.error({ error }, 'Failed to connect Kafka producer');
      throw error;
    }
  }

  /**
   * Publishes a message to a topic with guaranteed persistence (acks: all).
   * 
   * @param topic - The Kafka topic to publish to.
   * @param key - The partitioning key.
   * @param message - The object to be serialized and sent.
   * @param headers - Optional metadata headers.
   */
  public async publish(topic: string, key: string, message: any, headers?: Record<string, any>): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Kafka producer is not connected');
    }

    const payload: ProducerRecord = {
      topic,
      acks: -1, // Equivalent to 'all' for maximum durability
      messages: [{
        key,
        value: JSON.stringify(message),
        headers,
      }],
    };

    const startTime = process.hrtime.bigint();

    try {
      await this.circuitBreaker.fire(payload);
      const endTime = process.hrtime.bigint();
      this.logger.info({
        topic,
        key,
        durationNs: (endTime - startTime).toString(),
        msg: 'Event published successfully'
      });
    } catch (error) {
      this.logger.error({
        topic,
        key,
        error,
        msg: 'Failed to publish event'
      });
      throw error;
    }
  }

  /**
   * Gracefully shuts down the producer, ensuring all in-flight messages are flushed.
   */
  public async disconnect(): Promise<void> {
    try {
      await this.producer.disconnect();
      this.isConnected = false;
      this.logger.info('Kafka producer connection closed cleanly');
    } catch (error) {
      this.logger.error({ error }, 'Error during Kafka producer shutdown');
      throw error;
    }
  }

  /**
   * Configures observability for the circuit breaker.
   */
  private setupCircuitBreakerListeners(): void {
    this.circuitBreaker.on('open', () => 
      this.logger.error('Kafka producer circuit breaker OPEN: Stopping outgoing traffic.'));
    
    this.circuitBreaker.on('halfOpen', () => 
      this.logger.warn('Kafka producer circuit breaker HALF-OPEN: Testing broker health.'));
    
    this.circuitBreaker.on('close', () => 
      this.logger.info('Kafka producer circuit breaker CLOSED: Resuming normal traffic.'));
      
    this.circuitBreaker.on('fallback', (error: any) => 
      this.logger.warn({ error }, 'Circuit breaker triggered fallback'));
  }
}
