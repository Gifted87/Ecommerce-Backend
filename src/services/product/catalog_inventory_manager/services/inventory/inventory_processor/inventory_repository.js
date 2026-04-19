"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryRepository = exports.InventorySchema = exports.RepositorySystemError = exports.RepositoryConcurrencyError = exports.InsufficientStockError = exports.InventoryNotFoundError = void 0;
const opossum_1 = __importDefault(require("opossum"));
const zod_1 = require("zod");
/**
 * Domain-specific exceptions for Inventory business logic.
 */
class InventoryNotFoundError extends Error {
    constructor(productId) {
        super(`Inventory record not found for product: ${productId}`);
        this.productId = productId;
        this.name = 'InventoryNotFoundError';
    }
}
exports.InventoryNotFoundError = InventoryNotFoundError;
class InsufficientStockError extends Error {
    constructor(productId, available, requested) {
        super(`Insufficient stock for product ${productId}. Available: ${available}, Requested: ${requested}`);
        this.productId = productId;
        this.available = available;
        this.requested = requested;
        this.name = 'InsufficientStockError';
    }
}
exports.InsufficientStockError = InsufficientStockError;
class RepositoryConcurrencyError extends Error {
    constructor(message, originalError) {
        super(message);
        this.originalError = originalError;
        this.name = 'RepositoryConcurrencyError';
    }
}
exports.RepositoryConcurrencyError = RepositoryConcurrencyError;
class RepositorySystemError extends Error {
    constructor(message, originalError) {
        super(message);
        this.originalError = originalError;
        this.name = 'RepositorySystemError';
    }
}
exports.RepositorySystemError = RepositorySystemError;
/**
 * Inventory schema for data validation.
 */
exports.InventorySchema = zod_1.z.object({
    product_id: zod_1.z.string().uuid(),
    total_stock: zod_1.z.number().int().min(0),
    reserved_stock: zod_1.z.number().int().min(0),
    updated_at: zod_1.z.date(),
});
/**
 * Production-ready repository for atomic inventory management.
 */
class InventoryRepository {
    constructor(knex, logger) {
        this.knex = knex;
        this.logger = logger;
        this.tableName = 'inventory';
        this.logger = this.logger.child({ module: 'repository/inventory' });
        this.breaker = new opossum_1.default(async (fn) => await fn(), {
            timeout: 5000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        });
        this.setupCircuitBreakerMonitoring();
    }
    setupCircuitBreakerMonitoring() {
        this.breaker.on('open', () => this.logger.error('InventoryRepository: Circuit breaker opened.'));
        this.breaker.on('halfOpen', () => this.logger.warn('InventoryRepository: Circuit breaker half-open.'));
        this.breaker.on('close', () => this.logger.info('InventoryRepository: Circuit breaker closed.'));
    }
    /**
     * Retrieves inventory for a given product with circuit breaker protection.
     */
    async getInventory(productId) {
        return await this.breaker.fire(async () => {
            const row = await this.knex(this.tableName).where({ product_id: productId }).first();
            if (!row)
                throw new InventoryNotFoundError(productId);
            return exports.InventorySchema.parse(row);
        });
    }
    /**
     * Performs an atomic stock mutation using SELECT FOR UPDATE row locking.
     * Includes exponential backoff for deadlock handling.
     */
    async updateStock(productId, adjustment, correlationId) {
        const start = performance.now();
        let attempt = 0;
        const maxRetries = 3;
        while (attempt < maxRetries) {
            try {
                return await this.breaker.fire(async () => {
                    return await this.knex.transaction(async (trx) => {
                        const row = await trx(this.tableName)
                            .select('*')
                            .where({ product_id: productId })
                            .forUpdate()
                            .first();
                        if (!row)
                            throw new InventoryNotFoundError(productId);
                        const current = exports.InventorySchema.parse(row);
                        const nextTotal = current.total_stock + adjustment;
                        if (nextTotal < 0) {
                            throw new InsufficientStockError(productId, current.total_stock, Math.abs(adjustment));
                        }
                        const [updated] = await trx(this.tableName)
                            .where({ product_id: productId })
                            .update({
                            total_stock: nextTotal,
                            updated_at: new Date(),
                        })
                            .returning('*');
                        const result = exports.InventorySchema.parse(updated);
                        this.logger.info({
                            operation: 'UPDATE_STOCK',
                            productId,
                            adjustment,
                            correlationId,
                            duration: performance.now() - start,
                            finalStock: result.total_stock
                        }, 'Stock updated successfully');
                        return result;
                    });
                });
            }
            catch (error) {
                attempt++;
                // Handle PostgreSQL deadlock (40P01)
                if (error?.code === '40P01') {
                    if (attempt < maxRetries) {
                        const delay = Math.pow(2, attempt) * 100;
                        this.logger.warn({ attempt, productId, error: error.message }, 'Deadlock detected, retrying');
                        await new Promise((resolve) => setTimeout(resolve, delay));
                        continue;
                    }
                    throw new RepositoryConcurrencyError('Deadlock limit exceeded', error);
                }
                if (error instanceof InventoryNotFoundError || error instanceof InsufficientStockError) {
                    throw error;
                }
                this.logger.error({ error, productId, correlationId }, 'Unexpected repository failure');
                throw new RepositorySystemError('Internal database error', error);
            }
        }
        throw new RepositorySystemError('Transaction failed after retries');
    }
    /**
     * Performs a system health check.
     */
    async healthCheck() {
        try {
            await this.knex.raw('SELECT 1');
            return true;
        }
        catch (error) {
            this.logger.error({ error }, 'Database health check failed');
            return false;
        }
    }
}
exports.InventoryRepository = InventoryRepository;
