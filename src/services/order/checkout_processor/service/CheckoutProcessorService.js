"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckoutProcessorService = exports.CheckoutSchema = void 0;
const zod_1 = require("zod");
const opossum_1 = __importDefault(require("opossum"));
const order_types_1 = require("../types/order_types");
/**
 * Schema for validating checkout request payloads using Zod.
 *
 * Ensures all required fields are present and follow the expected format
 * (e.g., UUIDs for IDs, positive integers for quantities, strings for currency amounts).
 */
exports.CheckoutSchema = zod_1.z.object({
    orderId: zod_1.z.string().uuid(),
    userId: zod_1.z.string().uuid(),
    items: zod_1.z.array(zod_1.z.object({
        sku: zod_1.z.string(),
        quantity: zod_1.z.number().int().positive(),
        unit_price: zod_1.z.string(),
        item_total: zod_1.z.string(),
    })),
    total_amount: zod_1.z.string(),
    shipping_address: zod_1.z.string(),
    payment_token: zod_1.z.string(),
    correlationId: zod_1.z.string().uuid(),
});
/**
 * CheckoutProcessorService orchestrates the end-to-end checkout lifecycle.
 *
 * It manages the complex workflow of transitioning an order from PENDING to PLACED,
 * ensuring atomicity across multiple distributed steps including payment processing,
 * state persistence in PostgreSQL, and event publication to Kafka.
 *
 * The service is designed for resilience, utilizing the Circuit Breaker pattern
 * to handle transient failures in downstream dependencies and providing
 * automated compensation (rollback to FAILED status) when critical steps fail.
 */
class CheckoutProcessorService {
    /**
     * @param stateManager - Manages the persistent state of orders and status transitions.
     * @param eventProducer - Responsible for publishing checkout-related events to Kafka.
     * @param logger - The application's pino logger instance.
     */
    constructor(stateManager, eventProducer, logger) {
        this.stateManager = stateManager;
        this.eventProducer = eventProducer;
        this.logger = logger;
        this.paymentService = {
            // Mock payment service for demonstration of the flow
            processPayment: async () => ({ transactionId: 'TXN_' + Math.random().toString(36).substr(2, 9) })
        };
        // Initialize circuit breaker for external dependencies (Redis/DB)
        const options = {
            timeout: 5000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        };
        this.breaker = new opossum_1.default(this.executeCheckoutFlow.bind(this), options);
        this.breaker.on('open', () => this.logger.error('Circuit breaker opened for checkout process.'));
        this.breaker.on('halfOpen', () => this.logger.warn('Circuit breaker half-open for checkout process.'));
        this.breaker.on('close', () => this.logger.info('Circuit breaker closed for checkout process.'));
    }
    /**
     * Main entry point for processing a checkout request.
     *
     * Validates the input data against the CheckoutSchema and then executes
     * the checkout workflow through the circuit breaker.
     *
     * @param data - The raw request payload to be processed.
     * @returns A promise resolving to the success status and the order ID.
     * @throws Error if input validation fails or if the checkout flow is aborted.
     */
    async processCheckout(data) {
        const validatedData = exports.CheckoutSchema.safeParse(data);
        if (!validatedData.success) {
            this.logger.error({ msg: 'Invalid checkout request payload', error: validatedData.error });
            throw new Error('400 Bad Request: Invalid input schema.');
        }
        try {
            return await this.breaker.fire(validatedData.data);
        }
        catch (error) {
            this.logger.error({
                msg: 'Checkout process failed',
                error: error instanceof Error ? error.message : String(error),
                orderId: data?.orderId
            });
            throw error;
        }
    }
    /**
     * Internal implementation of the checkout lifecycle, protected by a circuit breaker.
     *
     * Workflow steps:
     * 1. Transition order state to 'PROCESSING' in the database.
     * 2. Attempt to process payment through the PaymentService.
     * 3. Publish an 'OrderPlaced' event to the message bus (Kafka).
     * 4. Transition order state to 'PLACED' in the database.
     *
     * If any step fails after state transition, it attempts to compensate by
     * marking the order as 'FAILED'.
     *
     * @param order - The validated checkout input.
     * @returns A promise resolving to the success status and order ID.
     * @private
     */
    async executeCheckoutFlow(order) {
        const { orderId, correlationId } = order;
        this.logger.info({ msg: 'Starting checkout process', orderId, correlationId });
        try {
            // 1. Transition to PROCESSING (Start the transaction)
            await this.stateManager.transitionOrder(orderId, order_types_1.OrderStatus.PROCESSING);
            this.logger.info({ msg: 'Order state updated to PROCESSING', orderId });
            // 2. Process Payment
            try {
                this.logger.info({ msg: 'Initiating payment processing', orderId, correlationId });
                await this.paymentService.processPayment(order.payment_token, order.total_amount, orderId, correlationId);
                this.logger.info({ msg: 'Payment processed successfully', orderId, correlationId });
            }
            catch (paymentError) {
                this.logger.error({ msg: 'Payment failed', orderId, correlationId, error: paymentError });
                // Compensate: Move back to FAILED or PENDING
                await this.stateManager.transitionOrder(orderId, order_types_1.OrderStatus.FAILED);
                throw new Error(`Payment processing failed: ${paymentError.message}`);
            }
            // 3. Publish Event
            await this.eventProducer.publishOrderPlaced(order);
            this.logger.info({ msg: 'Order placed event published', orderId });
            // 4. Finalize Transition to PLACED
            await this.stateManager.transitionOrder(orderId, order_types_1.OrderStatus.PLACED);
            this.logger.info({ msg: 'Order successfully placed', orderId });
            return { success: true, orderId };
        }
        catch (error) {
            // Final catch-all for any step after PROCESSING that didn't catch its own error
            // Note: stateManager.transitionOrder already handles its own circuit breaking.
            // If we are here, something went wrong in our orchestration.
            try {
                await this.stateManager.transitionOrder(orderId, order_types_1.OrderStatus.FAILED);
            }
            catch (compensateError) { /* ignore compensation errors to keep original error */ }
            this.logger.error({ msg: 'Failed to execute checkout flow', orderId, error });
            throw error;
        }
    }
    /**
     * Retrieves an order by its unique ID.
     *
     * @param id - The unique identifier of the order.
     * @returns A promise resolving to the order object.
     * @throws Error if the order is not found.
     */
    async getOrderById(id) {
        const order = await this.stateManager.getOrderById(id);
        if (!order)
            throw new Error('Order not found');
        return order;
    }
    /**
     * Lists all orders associated with a specific user.
     *
     * @param userId - The unique identifier of the user.
     * @returns A promise resolving to an array of orders.
     */
    async listOrdersByUserId(userId) {
        return await this.stateManager.listOrdersByUserId(userId);
    }
    /**
     * Manually updates the status of an order.
     *
     * This method bypasses the automated checkout flow but still respects
     * the transition rules enforced by the OrderStateManager.
     *
     * @param id - The unique identifier of the order.
     * @param status - The new target status for the order.
     * @throws Error if the order is not found or the transition is invalid.
     */
    async updateStatus(id, status) {
        const order = await this.stateManager.getOrderById(id);
        if (!order)
            throw new Error('Order not found');
        await this.stateManager.transitionOrder(id, status);
    }
}
exports.CheckoutProcessorService = CheckoutProcessorService;
