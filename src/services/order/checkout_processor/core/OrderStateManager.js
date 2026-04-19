"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderStateManager = exports.OrderStateError = void 0;
const opossum_1 = __importDefault(require("opossum"));
/**
 * Custom error class for order management failures.
 */
class OrderStateError extends Error {
    constructor(message, code) {
        super(message);
        this.message = message;
        this.code = code;
        this.name = 'OrderStateError';
    }
}
exports.OrderStateError = OrderStateError;
/**
 * OrderStateManager coordinates order lifecycle state transitions.
 * It ensures ACID compliance, atomicity via locking, and event consistency.
 */
class OrderStateManager {
    constructor(repository, lockService, eventProducer, transitionEngine, logger) {
        this.repository = repository;
        this.lockService = lockService;
        this.eventProducer = eventProducer;
        this.transitionEngine = transitionEngine;
        this.logger = logger;
        // Circuit breaker tuned for production: 3s timeout
        const options = {
            timeout: 3000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        };
        this.breaker = new opossum_1.default(this.executeTransition.bind(this), options);
    }
    /**
     * Retrieves an order by ID.
     */
    async getOrderById(orderId) {
        return await this.repository.findById(orderId);
    }
    /**
     * Lists orders for a specific user.
     */
    async listOrdersByUserId(userId) {
        // Cast repository to any if listByUserId is not in the interface but exists in the implementation
        // However, I updated the implementation, so I'll cast it here
        return await this.repository.listByUserId(userId);
    }
    /**
     * Primary entry point to transition an order status.
     */
    async transitionOrder(orderId, targetStatus, metadata) {
        this.logger.info({ orderId, targetStatus, metadata }, 'Attempting order state transition');
        try {
            return await this.breaker.fire(orderId, targetStatus, metadata);
        }
        catch (error) {
            this.logger.error({ orderId, targetStatus, error }, 'Order transition failed');
            throw error;
        }
    }
    /**
     * Internal logic executed within circuit breaker and distributed lock.
     */
    async executeTransition(orderId, targetStatus, metadata) {
        return await this.lockService.withLock(orderId, async () => {
            // 1. Fetch current order
            const order = await this.repository.findById(orderId);
            if (!order) {
                throw new OrderStateError(`Order not found: ${orderId}`, 'NOT_FOUND');
            }
            // 2. Validate transition
            await this.transitionEngine.processTransition(orderId, order.status, targetStatus, metadata);
            // Idempotency check: if current status already equals target, return order
            if (order.status === targetStatus) {
                this.logger.info({ orderId, status: targetStatus }, 'Order already at target status, skipping');
                return order;
            }
            // 3. Mutate DB and Publish Event in Transaction
            return await this.repository.runInTransaction(async () => {
                const updatedOrder = await this.repository.updateStatus(orderId, targetStatus, metadata?.tracking_number);
                try {
                    await this.eventProducer.publishOrderUpdated(updatedOrder);
                }
                catch (eventError) {
                    this.logger.error({ orderId, error: eventError }, 'Failed to publish event, rolling back transaction');
                    // Re-throw to trigger transaction rollback if critical
                    throw new OrderStateError('Event publication failed, rolling back', 'TRANSACTION_ROLLBACK');
                }
                this.logger.info({ orderId, prevStatus: order.status, newStatus: targetStatus }, 'Order status updated successfully');
                return updatedOrder;
            });
        });
    }
}
exports.OrderStateManager = OrderStateManager;
