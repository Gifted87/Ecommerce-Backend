"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryCacheManager = exports.CacheOperationError = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const opossum_1 = __importDefault(require("opossum"));
/**
 * Custom error class for InventoryCacheManager operations.
 */
class CacheOperationError extends Error {
    constructor(message, operation, key, originalError) {
        super(`${operation} failed for key ${key}: ${message}`);
        this.message = message;
        this.operation = operation;
        this.key = key;
        this.originalError = originalError;
        this.name = 'CacheOperationError';
    }
}
exports.CacheOperationError = CacheOperationError;
/**
 * InventoryCacheManager provides fault-tolerant caching for inventory data.
 * It implements the singleton pattern, circuit breaking, and structured logging.
 */
class InventoryCacheManager {
    constructor(logger) {
        this.logger = logger.child({ module: 'InventoryCacheManager' });
        const redisOptions = {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD,
            tls: process.env.REDIS_USE_TLS === 'true' ? {} : undefined,
            retryStrategy: (times) => {
                const delay = Math.min(Math.pow(2, times) * 100, 30000);
                this.logger.info({ times, delay }, 'Redis retry strategy triggered');
                return delay;
            },
        };
        this.redis = new ioredis_1.default(redisOptions);
        this.redis.on('connect', () => this.logger.info('Redis client connecting...'));
        this.redis.on('ready', () => this.logger.info('Redis client ready.'));
        this.redis.on('error', (err) => this.logger.error({ err }, 'Redis connection error'));
        this.redis.on('close', () => this.logger.warn('Redis connection closed.'));
        // Circuit Breaker setup
        this.breaker = new opossum_1.default(async (fn) => await fn(), {
            timeout: 3000,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        });
    }
    static initialize(logger) {
        if (!InventoryCacheManager.instance) {
            InventoryCacheManager.instance = new InventoryCacheManager(logger);
        }
    }
    static getInstance() {
        if (!InventoryCacheManager.instance) {
            throw new Error('InventoryCacheManager must be initialized before use.');
        }
        return InventoryCacheManager.instance;
    }
    redact(obj) {
        if (typeof obj !== 'object' || obj === null)
            return obj;
        const sensitive = ['pii', 'customer_details', 'credit_card'];
        const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
        for (const key of Object.keys(redacted)) {
            if (sensitive.includes(key)) {
                redacted[key] = '[REDACTED]';
            }
            else if (typeof redacted[key] === 'object') {
                redacted[key] = this.redact(redacted[key]);
            }
        }
        return redacted;
    }
    async get(key, ctx) {
        try {
            const data = await this.breaker.fire(async () => await this.redis.get(key));
            return data ? JSON.parse(data) : null;
        }
        catch (err) {
            this.logger.error({ err, key, correlationId: ctx.correlationId }, 'Cache GET error');
            throw new CacheOperationError(err.message, 'GET', key, err);
        }
    }
    async set(key, value, ctx, ttlSeconds = 3600) {
        try {
            const serialized = JSON.stringify(value);
            await this.breaker.fire(async () => await this.redis.set(key, serialized, 'EX', ttlSeconds));
        }
        catch (err) {
            this.logger.error({ err: this.redact(err), key, correlationId: ctx.correlationId }, 'Cache SET error');
            throw new CacheOperationError(err.message, 'SET', key, err);
        }
    }
    async del(key, ctx) {
        try {
            await this.breaker.fire(async () => await this.redis.del(key));
        }
        catch (err) {
            this.logger.error({ err, key, correlationId: ctx.correlationId }, 'Cache DEL error');
            throw new CacheOperationError(err.message, 'DEL', key, err);
        }
    }
    async hset(key, field, value, ctx) {
        try {
            await this.breaker.fire(async () => await this.redis.hset(key, field, JSON.stringify(value)));
        }
        catch (err) {
            this.logger.error({ err: this.redact(err), key, field, correlationId: ctx.correlationId }, 'Cache HSET error');
            throw new CacheOperationError(err.message, 'HSET', `${key}:${field}`, err);
        }
    }
    async hget(key, field, ctx) {
        try {
            const data = await this.breaker.fire(async () => await this.redis.hget(key, field));
            return data ? JSON.parse(data) : null;
        }
        catch (err) {
            this.logger.error({ err, key, field, correlationId: ctx.correlationId }, 'Cache HGET error');
            throw new CacheOperationError(err.message, 'HGET', `${key}:${field}`, err);
        }
    }
    async getHealthStatus() {
        const start = Date.now();
        try {
            await this.redis.ping();
            return {
                status: 'ready',
                latencyMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                status: 'disconnected',
                latencyMs: Date.now() - start,
            };
        }
    }
    async destroy() {
        await this.redis.quit();
    }
}
exports.InventoryCacheManager = InventoryCacheManager;
