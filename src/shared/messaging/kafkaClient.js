"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KafkaMessagingClient = void 0;
const kafkajs_1 = require("kafkajs");
const opossum_1 = __importDefault(require("opossum"));
/**
 * KafkaMessagingClient provides a production-ready wrapper around kafkajs.
 * It manages connections, producers, consumers, and circuit breakers for robust event-driven communication.
 */
class KafkaMessagingClient {
    /**
     * Initializes the Kafka Client.
     * @param config The Kafka connection configuration.
     */
    constructor(config) {
        this.config = config;
        this.kafka = new kafkajs_1.Kafka({
            clientId: config.clientId,
            brokers: config.brokers,
            ssl: config.ssl,
            sasl: config.sasl,
        });
        this.producer = this.kafka.producer({
            idempotent: true,
            maxInFlightRequests: 1,
        });
        this.breaker = new opossum_1.default(async (action) => await action(), {
            timeout: 5000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        });
    }
    /**
     * Establishes connections to the broker and initializes the producer.
     */
    async connect() {
        await this.producer.connect();
    }
    /**
     * Publishes a message to a specific topic with partitioning based on key.
     * @param topic The target Kafka topic.
     * @param key The partition key for ordering.
     * @param message The payload object.
     */
    async publish(topic, key, message) {
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
    async createConsumer(groupId, topic, eachMessage) {
        const consumer = this.kafka.consumer({ groupId });
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: false });
        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                const val = message.value?.toString();
                if (!val)
                    return;
                try {
                    await eachMessage({ topic, partition, message: JSON.parse(val) });
                }
                catch (error) {
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
    async disconnect() {
        await this.producer.disconnect();
    }
}
exports.KafkaMessagingClient = KafkaMessagingClient;
