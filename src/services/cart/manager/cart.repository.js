"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CartRepository = void 0;
const opossum_1 = __importDefault(require("opossum"));
const zod_1 = require("zod");
const cart_types_1 = require("./cart.types");
/**
 * Schema for cart items with financial precision handled via BigInt strings for Redis.
 */
const CartItemSchema = zod_1.z.object({
    productId: zod_1.z.string(),
    sku: zod_1.z.string().optional(),
    quantity: zod_1.z.number().int().positive(),
    pricePerUnit: zod_1.z.string().refine((val) => /^\d+$/.test(val), { message: 'Price must be a string representation of a BigInt' }),
    currency: zod_1.z.string().optional(),
    addedAt: zod_1.z.string().optional(),
    updatedAt: zod_1.z.string().optional(),
    version: zod_1.z.number().int().nonnegative().optional(),
});
/**
 * CartRepository implementation for Redis-backed storage with strict atomic operations.
 */
class CartRepository {
    constructor(redis, logger) {
        this.CART_TTL = 86400; // 24 hours
        this.redis = redis;
        this.logger = logger.child({ module: 'CartRepository' });
        const breakerOptions = {
            timeout: 500,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        };
        this.breaker = new opossum_1.default(async (action) => await action(), breakerOptions);
    }
    static initialize(redis, logger) {
        if (!CartRepository.instance) {
            CartRepository.instance = new CartRepository(redis, logger);
        }
    }
    static getInstance() {
        if (!CartRepository.instance) {
            throw new Error('CartRepository must be initialized before use.');
        }
        return CartRepository.instance;
    }
    redactPII(obj) {
        if (typeof obj !== 'object' || obj === null)
            return obj;
        const sensitiveKeys = ['address', 'phone', 'email'];
        const redacted = { ...obj };
        for (const key of sensitiveKeys) {
            if (key in redacted)
                redacted[key] = '[REDACTED]';
        }
        for (const key in redacted) {
            if (typeof redacted[key] === 'object') {
                redacted[key] = this.redactPII(redacted[key]);
            }
        }
        return redacted;
    }
    async getCart(userId, correlationId) {
        const start = Date.now();
        try {
            const data = await this.breaker.fire(async () => await this.redis.hgetall(`cart:${userId}`));
            if (!data || Object.keys(data).length === 0)
                return {};
            const cart = {};
            for (const [productId, json] of Object.entries(data)) {
                const item = JSON.parse(json);
                // Cast bigints from strings
                item.pricePerUnit = BigInt(item.pricePerUnit);
                cart[productId] = item;
            }
            this.logger.info({ userId, duration: Date.now() - start, correlationId }, 'Cart fetched');
            return cart;
        }
        catch (err) {
            this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error fetching cart');
            throw new cart_types_1.CartServiceError('Failed to fetch cart', 'REDIS_ERROR', correlationId, err);
        }
    }
    async updateCart(userId, item, correlationId) {
        const start = Date.now();
        const key = `cart:${userId}`;
        // Convert BigInt to string for JSON serialization
        const serializedItem = {
            ...item,
            pricePerUnit: item.pricePerUnit.toString(),
            version: (item.version || 0) + 1
        };
        try {
            await this.breaker.fire(async () => {
                await this.redis.hset(key, item.productId, JSON.stringify(serializedItem));
                await this.redis.expire(key, this.CART_TTL);
            });
            this.logger.info({ userId, productId: item.productId, duration: Date.now() - start, correlationId }, 'Cart updated');
        }
        catch (err) {
            this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error updating cart');
            throw new cart_types_1.CartServiceError('Failed to update cart', 'REDIS_ERROR', correlationId, err);
        }
    }
    async removeItem(userId, productId, correlationId) {
        const start = Date.now();
        try {
            await this.breaker.fire(async () => {
                await this.redis.hdel(`cart:${userId}`, productId);
            });
            this.logger.info({ userId, productId, duration: Date.now() - start, correlationId }, 'Item removed from cart');
        }
        catch (err) {
            this.logger.error({ err: this.redactPII(err), userId, productId, correlationId }, 'Error removing item from cart');
            throw new cart_types_1.CartServiceError('Failed to remove item from cart', 'REDIS_ERROR', correlationId, err);
        }
    }
    async deleteCart(userId, correlationId) {
        const start = Date.now();
        try {
            await this.breaker.fire(async () => await this.redis.del(`cart:${userId}`));
            this.logger.info({ userId, duration: Date.now() - start, correlationId }, 'Cart deleted');
        }
        catch (err) {
            this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error deleting cart');
            throw new cart_types_1.CartServiceError('Failed to delete cart', 'REDIS_ERROR', correlationId, err);
        }
    }
    async checkHealth(correlationId) {
        try {
            await this.breaker.fire(async () => await this.redis.ping());
        }
        catch (err) {
            this.logger.error({ err: this.redactPII(err), correlationId }, 'Cart health check failed');
            throw new cart_types_1.CartServiceError('Service Unavailable', 'SERVICE_UNAVAILABLE', correlationId, err);
        }
    }
}
exports.CartRepository = CartRepository;
