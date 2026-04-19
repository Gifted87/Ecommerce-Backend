"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributedLockService = exports.DistributedLockError = void 0;
const opossum_1 = __importDefault(require("opossum"));
const crypto_1 = require("crypto");
/**
 * Custom error class for Distributed Lock Service operations.
 */
class DistributedLockError extends Error {
    constructor(message, code, originalError) {
        super(message);
        this.message = message;
        this.code = code;
        this.originalError = originalError;
        this.name = 'DistributedLockError';
    }
}
exports.DistributedLockError = DistributedLockError;
/**
 * DistributedLockService provides a mutex locking mechanism using Redis.
 * Ensures that only one worker node can process a specific OrderID at a time.
 */
class DistributedLockService {
    /**
     * @param redisClient An initialized ioredis instance.
     * @param logger A pino logger instance for structured logging.
     */
    constructor(redisClient, logger) {
        this.redisClient = redisClient;
        this.logger = logger;
        this.DEFAULT_TTL = 5; // seconds
        this.redis = redisClient;
        // Circuit breaker configuration
        const options = {
            timeout: 3000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        };
        this.breaker = new opossum_1.default(async (cmd, ...args) => {
            return this.redis[cmd](...args);
        }, options);
        this.breaker.on('open', () => this.logger.error('DistributedLockService: Circuit breaker opened.'));
        this.breaker.on('close', () => this.logger.info('DistributedLockService: Circuit breaker closed.'));
    }
    /**
     * Executes a provided callback function within a distributed lock.
     * Ensures atomicity of lock acquisition and release.
     *
     * @param orderId The ID of the order to lock.
     * @param callback The async function to execute.
     * @returns The result of the callback.
     */
    async withLock(orderId, callback) {
        const lockKey = `order:lock:${orderId}`;
        const requestId = (0, crypto_1.randomUUID)();
        const acquired = await this.acquireLock(lockKey, requestId);
        if (!acquired) {
            throw new DistributedLockError(`Could not acquire lock for order: ${orderId}`, 'LOCK_ACQUISITION_FAILED');
        }
        try {
            this.logger.info({ orderId, requestId }, 'Lock acquired');
            return await callback();
        }
        catch (error) {
            this.logger.error({ orderId, requestId, error }, 'Error during locked operation');
            throw error;
        }
        finally {
            await this.releaseLock(lockKey, requestId);
        }
    }
    /**
     * Attempts to acquire a Redis lock using SET NX EX.
     */
    async acquireLock(key, requestId) {
        try {
            const result = await this.breaker.fire('set', key, requestId, 'EX', this.DEFAULT_TTL, 'NX');
            return result === 'OK';
        }
        catch (error) {
            this.logger.error({ key, error }, 'Failed to acquire lock');
            throw new DistributedLockError('Redis error during lock acquisition', 'REDIS_ERROR', error);
        }
    }
    /**
     * Releases the lock only if the current requestId matches the one in Redis.
     * Uses a Lua script to ensure atomic check-and-delete.
     */
    async releaseLock(key, requestId) {
        const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
        try {
            await this.breaker.fire('eval', luaScript, 1, key, requestId);
            this.logger.info({ key, requestId }, 'Lock released');
        }
        catch (error) {
            this.logger.error({ key, requestId, error }, 'Failed to release lock');
            throw new DistributedLockError('Redis error during lock release', 'REDIS_ERROR', error);
        }
    }
    /**
     * Returns current service health status.
     */
    async getHealth() {
        const redisStatus = this.redis.status;
        const circuitStatus = this.breaker.opened ? 'open' : 'closed';
        return {
            status: redisStatus === 'ready' && circuitStatus === 'closed' ? 'healthy' : 'unhealthy',
            redis: redisStatus,
            circuit: circuitStatus,
        };
    }
}
exports.DistributedLockService = DistributedLockService;
