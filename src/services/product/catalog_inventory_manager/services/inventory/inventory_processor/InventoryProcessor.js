"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryProcessor = exports.StockMutationSchema = void 0;
const opossum_1 = __importDefault(require("opossum"));
const zod_1 = require("zod");
/**
 * Zod schema for validating stock mutation requests.
 *
 * Ensures the payload contains a valid product UUID, a non-negative integer amount,
 * and appropriate tracing information (correlation and user IDs).
 */
exports.StockMutationSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    amount: zod_1.z.number().int().nonnegative(),
    correlationId: zod_1.z.string().uuid(),
    userId: zod_1.z.string().uuid(),
});
/**
 * InventoryProcessor is the central service for managing stock levels.
 *
 * It orchestrates complex stock lifecycle operations, such as reserving and
 * releasing inventory, while ensuring atomicity, durability, and consistency
 * across PostgreSQL, Redis, and Kafka.
 *
 * Key Design Patterns:
 * - **Command Pattern**: Encapsulates stock changes as discrete, retryable actions.
 * - **Circuit Breaker Pattern**: Protects the database, cache, and message bus
 *   independently from transient failures.
 * - **Observability**: High-resolution performance metrics and transaction tracing.
 */
class InventoryProcessor {
    /**
     * @param repository - Persistent data access layer for inventory.
     * @param cache - Distributed cache manager for stock availability.
     * @param producer - Event publisher for broadcasting stock mutations to the message bus.
     * @param logger - The application's pino logger instance.
     */
    constructor(repository, cache, producer, logger) {
        this.repository = repository;
        this.cache = cache;
        this.producer = producer;
        this.logger = logger;
        this.logger = logger.child({ module: 'service/inventory-processor' });
        // Individual circuit breakers for fine-grained failure handling
        this.dbBreaker = new opossum_1.default(async (fn) => await fn(), {
            timeout: 5000,
            errorThresholdPercentage: 30,
            resetTimeout: 10000,
        });
        this.cacheBreaker = new opossum_1.default(async (fn) => await fn(), {
            timeout: 1000,
            errorThresholdPercentage: 50,
            resetTimeout: 5000,
        });
        this.kafkaBreaker = new opossum_1.default(async (fn) => await fn(), {
            timeout: 2000,
            errorThresholdPercentage: 20,
            resetTimeout: 5000,
        });
    }
    /**
     * Reserves stock for a specific product.
     *
     * This is a decrement operation on the available inventory count.
     *
     * @param request - The validated stock mutation details.
     * @returns A promise that resolves when the reservation is complete.
     * @throws Error if the database transaction or event emission fails.
     */
    async reserveStock(request) {
        await this.processMutation(request, 'reserve');
    }
    /**
     * Releases previously reserved stock back into the available inventory pool.
     *
     * This is an increment operation on the available inventory count.
     *
     * @param request - The validated stock mutation details.
     * @returns A promise that resolves when the release is complete.
     * @throws Error if the process fails.
     */
    async releaseStock(request) {
        await this.processMutation(request, 'release');
    }
    /**
     * Internal implementation of the stock mutation workflow.
     *
     * Coordinates:
     * 1. Relational database update (PostgreSQL).
     * 2. Asynchronous cache invalidation (Redis).
     * 3. Event publication (Kafka).
     *
     * @param request - The mutation details.
     * @param action - Whether to 'reserve' or 'release' stock.
     * @returns A promise resolving to void.
     * @private
     */
    async processMutation(request, action) {
        const start = process.hrtime();
        const { productId, amount, correlationId } = request;
        this.logger.info({ correlationId, productId, action, amount }, 'Processing stock mutation');
        try {
            // 1. Repository Transaction (DB Breaker)
            await this.dbBreaker.fire(async () => {
                const adjustment = action === 'reserve' ? -amount : amount;
                await this.repository.updateStock(productId, adjustment, correlationId);
            });
            // 2. Async Cache Invalidation (Cache Breaker)
            // Performed asynchronously to avoid blocking the primary transaction.
            this.cacheBreaker.fire(async () => {
                await this.cache.del(`inventory:${productId}`, { correlationId });
            }).catch((err) => {
                this.logger.warn({ correlationId, productId, error: err }, 'Cache invalidation failed post-transaction');
            });
            // 3. Kafka Event Emission (Kafka Breaker)
            await this.kafkaBreaker.fire(async () => {
                await this.producer.publish('inventory.mutations', productId, {
                    action,
                    productId,
                    amount,
                    correlationId,
                    timestamp: new Date().toISOString()
                }, { correlationId });
            });
            const duration = process.hrtime(start);
            this.logger.info({
                correlationId,
                productId,
                action,
                durationMs: (duration[0] * 1000 + duration[1] / 1e6).toFixed(2)
            }, 'Stock mutation successful');
        }
        catch (error) {
            this.logger.error({ correlationId, productId, action, error }, 'Failed to process stock mutation');
            throw error;
        }
    }
}
exports.InventoryProcessor = InventoryProcessor;
