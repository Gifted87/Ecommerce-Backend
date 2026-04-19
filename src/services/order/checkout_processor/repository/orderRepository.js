"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderRepository = exports.OrderRepositoryError = void 0;
const opossum_1 = __importDefault(require("opossum"));
const order_types_1 = require("../types/order_types");
/**
 * Custom Error for Repository-level domain exceptions.
 */
class OrderRepositoryError extends Error {
    constructor(message, code, originalError) {
        super(message);
        this.message = message;
        this.code = code;
        this.originalError = originalError;
        this.name = 'OrderRepositoryError';
    }
}
exports.OrderRepositoryError = OrderRepositoryError;
/**
 * Implementation of the OrderRepository.
 * Handles persistent storage for the Checkout State Machine.
 */
class OrderRepository {
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
        this.tableName = 'orders';
        this.breaker = new opossum_1.default(async (fn) => await fn(), {
            timeout: 5000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        });
    }
    /**
     * Redacts sensitive information from the order model before logging.
     */
    redact(order) {
        return {
            order_id: order.order_id,
            user_id: order.user_id,
            status: order.status,
            total_amount: order.total_amount,
        };
    }
    /**
     * Persists a new order within a transaction.
     */
    async create(orderData) {
        return await this.breaker.fire(async () => {
            const start = performance.now();
            try {
                const validated = order_types_1.OrderModelSchema.parse(orderData);
                return await this.db.transaction(async (trx) => {
                    const [result] = await trx(this.tableName)
                        .insert({
                        ...validated,
                        items: JSON.stringify(validated.items),
                        shipping_address: JSON.stringify(validated.shipping_address),
                        created_at: new Date(),
                        updated_at: new Date(),
                    })
                        .returning('*');
                    this.logger.info({ operation: 'CREATE_ORDER', duration: performance.now() - start, ...this.redact(result) }, 'Order created successfully');
                    return this.parseResult(result);
                });
            }
            catch (error) {
                this.logger.error({ operation: 'CREATE_ORDER', error: error.message }, 'Failed to create order');
                throw new OrderRepositoryError('Persistence failed', 'DB_CREATE_ERROR', error);
            }
        });
    }
    /**
     * Updates an existing order status within a transaction.
     */
    async updateStatus(orderId, status, trackingNumber) {
        return await this.breaker.fire(async () => {
            const start = performance.now();
            try {
                const updateData = { status, updated_at: new Date() };
                if (trackingNumber) {
                    updateData.tracking_number = trackingNumber;
                }
                const [result] = await this.db(this.tableName)
                    .where({ order_id: orderId })
                    .update(updateData)
                    .returning('*');
                if (!result) {
                    throw new OrderRepositoryError('Order not found', 'NOT_FOUND');
                }
                this.logger.info({ operation: 'UPDATE_ORDER_STATUS', duration: performance.now() - start, ...this.redact(result) }, 'Order status updated');
                return this.parseResult(result);
            }
            catch (error) {
                this.logger.error({ operation: 'UPDATE_ORDER_STATUS', orderId, error: error.message }, 'Failed to update order status');
                throw new OrderRepositoryError('Update failed', 'DB_UPDATE_ERROR', error);
            }
        });
    }
    /**
     * Retrieves an order by ID.
     */
    async findById(orderId) {
        return await this.breaker.fire(async () => {
            const start = performance.now();
            try {
                const result = await this.db(this.tableName).where({ order_id: orderId }).first();
                if (!result)
                    return null;
                const parsed = this.parseResult(result);
                this.logger.debug({ operation: 'FIND_ORDER', duration: performance.now() - start, ...this.redact(parsed) }, 'Order retrieved');
                return parsed;
            }
            catch (error) {
                this.logger.error({ operation: 'FIND_ORDER', orderId, error: error.message }, 'Query failed');
                throw new OrderRepositoryError('Query execution failed', 'DB_FIND_ERROR', error);
            }
        });
    }
    /**
     * Retrieves all orders for a specific user.
     */
    async listByUserId(userId) {
        return await this.breaker.fire(async () => {
            const start = performance.now();
            try {
                const results = await this.db(this.tableName)
                    .where({ user_id: userId })
                    .orderBy('created_at', 'desc');
                const parsedResults = results.map((result) => this.parseResult(result));
                this.logger.debug({ operation: 'LIST_ORDERS', duration: performance.now() - start, count: parsedResults.length, userId }, 'Orders listed');
                return parsedResults;
            }
            catch (error) {
                this.logger.error({ operation: 'LIST_ORDERS', userId, error: error.message }, 'Query failed');
                throw new OrderRepositoryError('Query execution failed', 'DB_LIST_ERROR', error);
            }
        });
    }
    /**
     * Executes a callback within a transaction.
     */
    async runInTransaction(callback) {
        return await this.db.transaction(callback);
    }
    parseResult(result) {
        return order_types_1.OrderModelSchema.parse({
            ...result,
            items: typeof result.items === 'string' ? JSON.parse(result.items) : result.items,
            shipping_address: typeof result.shipping_address === 'string' ? JSON.parse(result.shipping_address) : result.shipping_address,
        });
    }
}
exports.OrderRepository = OrderRepository;
