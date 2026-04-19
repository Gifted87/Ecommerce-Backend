"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryEventPublisher = exports.KafkaConfigSchema = exports.IntegrityValidationError = exports.PublishTimeoutError = void 0;
const kafkajs_1 = require("kafkajs");
const opossum_1 = __importDefault(require("opossum"));
const zod_1 = require("zod");
const crypto_1 = require("crypto");
/**
 * Custom error types for specific failure scenarios.
 */
class PublishTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PublishTimeoutError';
    }
}
exports.PublishTimeoutError = PublishTimeoutError;
class IntegrityValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'IntegrityValidationError';
    }
}
exports.IntegrityValidationError = IntegrityValidationError;
/**
 * Zod schema for validated Kafka configuration.
 */
exports.KafkaConfigSchema = zod_1.z.object({
    clientId: zod_1.z.string().min(1),
    brokers: zod_1.z.array(zod_1.z.string().min(1)),
    ssl: zod_1.z.boolean(),
    sasl: zod_1.z.object({
        mechanism: zod_1.z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
        username: zod_1.z.string().min(1),
        password: zod_1.z.string().min(1),
    }).optional(),
    hmacSecret: zod_1.z.string().min(32),
});
/**
 * InventoryEventPublisher provides a production-grade interface for broadcasting
 * inventory state changes to Kafka with built-in security, fault tolerance,
 * and observability.
 */
class InventoryEventPublisher {
    constructor(config, logger) {
        this.isInitialized = false;
        const validatedConfig = exports.KafkaConfigSchema.parse(config);
        this.hmacSecret = validatedConfig.hmacSecret;
        this.logger = logger.child({ module: 'InventoryEventPublisher' });
        this.kafka = new kafkajs_1.Kafka({
            clientId: validatedConfig.clientId,
            brokers: validatedConfig.brokers,
            ssl: validatedConfig.ssl,
            sasl: validatedConfig.sasl ? {
                mechanism: validatedConfig.sasl.mechanism,
                username: validatedConfig.sasl.username,
                password: validatedConfig.sasl.password,
            } : undefined,
        });
        this.producer = this.kafka.producer({
            idempotent: true,
            maxInFlightRequests: 5,
        });
        this.producerBreaker = new opossum_1.default(async (record) => await this.producer.send(record), {
            timeout: 5000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        });
        this.setupBreakerListeners();
    }
    setupBreakerListeners() {
        this.producerBreaker.on('open', () => this.logger.error('InventoryEventPublisher: Circuit breaker is OPEN'));
        this.producerBreaker.on('halfOpen', () => this.logger.warn('InventoryEventPublisher: Circuit breaker is HALF-OPEN'));
        this.producerBreaker.on('close', () => this.logger.info('InventoryEventPublisher: Circuit breaker is CLOSED'));
    }
    signMessage(payload) {
        return (0, crypto_1.createHmac)('sha256', this.hmacSecret)
            .update(JSON.stringify(payload))
            .digest('hex');
    }
    scrubPiI(data) {
        const scrubbed = { ...data };
        const piiKeys = ['userId', 'user_id', 'email', 'phoneNumber', 'user_email'];
        for (const key of piiKeys) {
            if (key in scrubbed) {
                scrubbed[key] = '***REDACTED***';
            }
        }
        return scrubbed;
    }
    async connect() {
        try {
            await this.producer.connect();
            this.isInitialized = true;
            this.logger.info('InventoryEventPublisher: Kafka producer connected');
        }
        catch (error) {
            this.logger.error({ error }, 'InventoryEventPublisher: Connection failed');
            throw error;
        }
    }
    async publish(topic, key, payload, context = {}) {
        if (!this.isInitialized) {
            throw new Error('Publisher not initialized. Call connect() first.');
        }
        const signature = this.signMessage(payload);
        const timestamp = Date.now().toString();
        const record = {
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
            this.logger.info({
                topic,
                key,
                context: this.scrubPiI(context),
                msg: 'Inventory event published successfully'
            });
        }
        catch (error) {
            this.logger.error({
                topic,
                key,
                context: this.scrubPiI(context),
                error,
                msg: 'Failed to publish inventory event'
            });
            if (error instanceof Error && error.message.includes('timeout')) {
                throw new PublishTimeoutError(error.message);
            }
            throw error;
        }
    }
    async shutdown() {
        this.logger.info('InventoryEventPublisher: Shutting down producer...');
        await this.producer.disconnect();
        this.logger.info('InventoryEventPublisher: Shutdown complete');
    }
}
exports.InventoryEventPublisher = InventoryEventPublisher;
