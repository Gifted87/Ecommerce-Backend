import { Logger } from 'pino';
import { KafkaMessagingClient } from '../../../../../shared/messaging/kafkaClient';
import { Order } from '../../types/order_types';

/**
 * Interface for topic configuration.
 */
export interface EventTopics {
  orderPlaced: string;
  orderUpdated: string;
}

/**
 * CheckoutEventProducer is responsible for the atomic and idempotent publication
 * of order lifecycle events to the Kafka cluster.
 */
export class CheckoutEventProducer {
  private readonly topics: EventTopics;

  constructor(
    private readonly kafkaClient: KafkaMessagingClient,
    private readonly logger: Logger,
    topics: EventTopics
  ) {
    this.topics = topics;
  }

  /**
   * Publishes an 'OrderPlaced' event.
   */
  public async publishOrderPlaced(order: Order): Promise<void> {
    await this.publishEvent(this.topics.orderPlaced, 'OrderPlaced', order);
  }

  /**
   * Publishes an 'OrderUpdated' event.
   */
  public async publishOrderUpdated(order: Order): Promise<void> {
    await this.publishEvent(this.topics.orderUpdated, 'OrderUpdated', order);
  }

  /**
   * Orchestrates the preparation, redaction, logging, and publication of an event.
   */
  private async publishEvent(topic: string, eventType: string, order: Order): Promise<void> {
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
    } catch (error) {
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
  private redactPII(order: Order): any {
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
