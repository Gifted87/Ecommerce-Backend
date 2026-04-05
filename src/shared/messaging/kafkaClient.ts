import { Kafka, Producer, Consumer, ProducerConfig, ConsumerConfig, SASLMechanism } from 'kafkajs';
import CircuitBreaker from 'opossum';

/**
 * Interface for Kafka configuration settings.
 */
interface KafkaClientConfig {
  clientId: string;
  brokers: string[];
  ssl: boolean;
  sasl?: {
    mechanism: SASLMechanism;
    username: string;
    password: string;
  };
}

/**
 * KafkaMessagingClient provides a production-ready wrapper around kafkajs.
 * It manages connections, producers, consumers, and circuit breakers for robust event-driven communication.
 */
export class KafkaMessagingClient {
  private kafka: Kafka;
  private producer: Producer;
  private breaker: CircuitBreaker;

  /**
   * Initializes the Kafka Client.
   * @param config The Kafka connection configuration.
   */
  constructor(private config: KafkaClientConfig) {
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl,
      sasl: config.sasl,
    });

    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
    });

    this.breaker = new CircuitBreaker(async (action: () => Promise<any>) => await action(), {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  /**
   * Establishes connections to the broker and initializes the producer.
   */
  public async connect(): Promise<void> {
    await this.producer.connect();
  }

  /**
   * Publishes a message to a specific topic with partitioning based on key.
   * @param topic The target Kafka topic.
   * @param key The partition key for ordering.
   * @param message The payload object.
   */
  public async publish(topic: string, key: string, message: any): Promise<void> {
    const payload = {
      topic,
      messages: [{ key, value: JSON.stringify(message) }],
    };

    await this.breaker.fire(async () => {
      await this.producer.send(payload);
    });
  }

  /**
   * Creates a consumer group for processing events.
   * @param groupId The unique identifier for the consumer group.
   * @param topic The topic to subscribe to.
   * @param eachMessage The handler function for incoming messages.
   */
  public async createConsumer(
    groupId: string,
    topic: string,
    eachMessage: (payload: { topic: string; partition: number; message: any }) => Promise<void>
  ): Promise<Consumer> {
    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const val = message.value?.toString();
        if (!val) return;
        
        try {
          await eachMessage({ topic, partition, message: JSON.parse(val) });
        } catch (error) {
          // Log error and handle according to specific domain logic
          throw error;
        }
      },
    });

    return consumer;
  }

  /**
   * Performs a graceful shutdown of the Kafka client and producer.
   */
  public async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}
