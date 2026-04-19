"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CartLockManager = exports.ServiceUnavailableError = void 0;
const opossum_1 = __importDefault(require("opossum"));
const crypto_1 = require("crypto");
const cart_types_1 = require("./cart.types");
/**
 * Custom error class for service availability issues.
 */
class ServiceUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ServiceUnavailableError';
    }
}
exports.ServiceUnavailableError = ServiceUnavailableError;
/**
 * CartLockManager handles distributed locking for cart operations.
 * Implements SET NX EX pattern with atomic Lua-based release.
 */
class CartLockManager {
    constructor(redisClient, logger) {
        this.releaseScriptSha = '';
        this.RELEASE_LUA_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
        this.redis = redisClient;
        this.logger = logger.child({ module: 'CartLockManager' });
        const options = {
            timeout: 500,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        };
        this.breaker = new opossum_1.default(async (cmd, ...args) => {
            return this.redis[cmd](...args);
        }, options);
        this.breaker.fallback(() => {
            throw new ServiceUnavailableError('Cart locking service currently unavailable.');
        });
    }
    /**
     * Executes a callback within a distributed lock.
     */
    async withLock(userId, ttlSeconds, callback) {
        if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
            throw new Error('Invalid userId format');
        }
        const lockKey = `cart:lock:${userId}`;
        const requestId = (0, crypto_1.randomUUID)();
        await this.acquireLockWithRetry(lockKey, requestId, ttlSeconds);
        const startTime = Date.now();
        try {
            return await callback();
        }
        finally {
            const duration = Date.now() - startTime;
            await this.releaseLock(lockKey, requestId);
            this.logger.info({ userId, requestId, duration }, 'Lock released');
        }
    }
    async acquireLockWithRetry(key, requestId, ttl) {
        const maxRetries = 5;
        let attempt = 0;
        while (attempt < maxRetries) {
            const result = await this.breaker.fire('set', key, requestId, 'EX', ttl, 'NX');
            if (result === 'OK') {
                this.logger.info({ key, requestId }, 'Lock acquired');
                return;
            }
            attempt++;
            const delay = Math.pow(2, attempt) * 100 + Math.random() * 50;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        this.logger.warn({ key, requestId }, 'Failed to acquire lock after retries');
        throw new cart_types_1.CartConcurrencyError(requestId, key);
    }
    async releaseLock(key, requestId) {
        try {
            await this.breaker.fire('eval', this.RELEASE_LUA_SCRIPT, 1, key, requestId);
        }
        catch (error) {
            this.logger.error({ key, requestId, error }, 'Error releasing lock');
        }
    }
}
exports.CartLockManager = CartLockManager;
