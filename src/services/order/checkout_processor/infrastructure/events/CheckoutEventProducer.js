"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckoutEventProducer = void 0;
/**
 * CheckoutEventProducer is responsible for the atomic and idempotent publication
 * of order lifecycle events to the Kafka cluster.
 */
class CheckoutEventProducer {
    constructor(kafkaClient, logger, topics) {
        this.kafkaClient = kafkaClient;
        this.logger = logger;
        this.topics = topics;
    }
    /**
     * Publishes an 'OrderPlaced' event.
     */
    async publishOrderPlaced(order) {
        await this.publishEvent(this.topics.orderPlaced, 'OrderPlaced', order);
    }
    /**
     * Publishes an 'OrderUpdated' event.
     */
    async publishOrderUpdated(order) {
        await this.publishEvent(this.topics.orderUpdated, 'OrderUpdated', order);
    }
    /**
     * Orchestrates the preparation, redaction, logging, and publication of an event.
     */
    async publishEvent(topic, eventType, order) {
        const correlationId = order.correlation_id;
        this.logger.info({
            msg: `Preparing to publish ${eventType}`,
            orderId: order.order_id,
            userId: order.user_id,
            correlationId
        });
        try {
            const redactedPayload = this.redactPII(order);
            const payload = {
                eventType,
                timestamp: new Date().toISOString(),
                correlationId,
                data: redactedPayload,
            };
            this.logger.debug({
                msg: `Pre-publish validation complete for ${eventType}`,
                orderId: order.order_id,
                correlationId
            });
            await this.kafkaClient.publish(topic, order.order_id, payload);
            this.logger.info({
                msg: `Successfully published ${eventType}`,
                orderId: order.order_id,
                topic,
                correlationId
            });
        }
        catch (error) {
            this.logger.error({
                msg: `Failed to publish ${eventType}`,
                orderId: order.order_id,
                correlationId,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    /**
     * Redacts PII (Personally Identifiable Information) from the order entity
     * according to security policy.
     */
    redactPII(order) {
        // Create a shallow copy to avoid mutating the original entity
        const sanitized = { ...order };
        // Mask the street address
        if (sanitized.shipping_address) {
            sanitized.shipping_address = {
                ...sanitized.shipping_address,
                street: '***REDACTED***'
            };
        }
        // Ensure no other unexpected sensitive fields exist if added in future domain updates
        // In this specific domain entity, PII is primarily in shipping_address.
        return sanitized;
    }
}
exports.CheckoutEventProducer = CheckoutEventProducer;
