import Redis, { RedisOptions } from 'ioredis';
import Opossum = require('opossum');
import { Logger } from 'pino';

/**
 * Custom error class for InventoryCacheManager operations.
 */
export class CacheOperationError extends Error {
  constructor(
    public readonly message: string,
    public readonly operation: string,
    public readonly key: string,
    public readonly originalError?: Error
  ) {
    super(`${operation} failed for key ${key}: ${message}`);
    this.name = 'CacheOperationError';
  }
}

/**
 * Context object for distributed tracing.
 */
export interface CacheContext {
  correlationId: string;
}

/**
 * Interface for health status response.
 */
export interface CacheHealthStatus {
  status: 'connected' | 'reconnecting' | 'disconnected' | 'ready';
  latencyMs: number;
}

/**
 * InventoryCacheManager provides fault-tolerant caching for inventory data.
 * It implements the singleton pattern, circuit breaking, and structured logging.
 */
export class InventoryCacheManager {
  private static instance: InventoryCacheManager;
  private readonly redis: Redis;
  // Use any to bypass TS namespace issue
  private readonly breaker: any;
  private readonly logger: Logger;

  private constructor(logger: Logger) {
    this.logger = logger.child({ module: 'InventoryCacheManager' });

    const redisOptions: RedisOptions = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_USE_TLS === 'true' ? {} : undefined,
      retryStrategy: (times: number) => {
        const delay = Math.min(Math.pow(2, times) * 100, 30000);
        this.logger.info({ times, delay }, 'Redis retry strategy triggered');
        return delay;
      },
    };

    this.redis = new Redis(redisOptions);

    this.redis.on('connect', () => this.logger.info('Redis client connecting...'));
    this.redis.on('ready', () => this.logger.info('Redis client ready.'));
    this.redis.on('error', (err) => this.logger.error({ err }, 'Redis connection error'));
    this.redis.on('close', () => this.logger.warn('Redis connection closed.'));

    // Circuit Breaker setup
    this.breaker = new Opossum(
      async (fn: () => Promise<any>) => await fn(),
      {
        timeout: 3000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );
  }

  public static initialize(logger: Logger): void {
    if (!InventoryCacheManager.instance) {
      InventoryCacheManager.instance = new InventoryCacheManager(logger);
    }
  }

  public static getInstance(): InventoryCacheManager {
    if (!InventoryCacheManager.instance) {
      throw new Error('InventoryCacheManager must be initialized before use.');
    }
    return InventoryCacheManager.instance;
  }

  private redact(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj;
    const sensitive = ['pii', 'customer_details', 'credit_card'];
    const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const key of Object.keys(redacted)) {
      if (sensitive.includes(key)) {
        redacted[key] = '[REDACTED]';
      } else if (typeof redacted[key] === 'object') {
        redacted[key] = this.redact(redacted[key]);
      }
    }
    return redacted;
  }

  public async get<T>(key: string, ctx: CacheContext): Promise<T | null> {
    try {
      const data = await this.breaker.fire(async () => await this.redis.get(key));
      return data ? (JSON.parse(data) as T) : null;
    } catch (err: any) {
      this.logger.error({ err, key, correlationId: ctx.correlationId }, 'Cache GET error');
      throw new CacheOperationError(err.message, 'GET', key, err);
    }
  }

  public async set(key: string, value: any, ctx: CacheContext, ttlSeconds: number = 3600): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.breaker.fire(async () => await this.redis.set(key, serialized, 'EX', ttlSeconds));
    } catch (err: any) {
      this.logger.error({ err: this.redact(err), key, correlationId: ctx.correlationId }, 'Cache SET error');
      throw new CacheOperationError(err.message, 'SET', key, err);
    }
  }

  public async del(key: string, ctx: CacheContext): Promise<void> {
    try {
      await this.breaker.fire(async () => await this.redis.del(key));
    } catch (err: any) {
      this.logger.error({ err, key, correlationId: ctx.correlationId }, 'Cache DEL error');
      throw new CacheOperationError(err.message, 'DEL', key, err);
    }
  }

  public async hset(key: string, field: string, value: any, ctx: CacheContext): Promise<void> {
    try {
      await this.breaker.fire(async () => await this.redis.hset(key, field, JSON.stringify(value)));
    } catch (err: any) {
      this.logger.error({ err: this.redact(err), key, field, correlationId: ctx.correlationId }, 'Cache HSET error');
      throw new CacheOperationError(err.message, 'HSET', `${key}:${field}`, err);
    }
  }

  public async hget<T>(key: string, field: string, ctx: CacheContext): Promise<T | null> {
    try {
      const data = await this.breaker.fire(async () => await this.redis.hget(key, field));
      return data ? (JSON.parse(data) as T) : null;
    } catch (err: any) {
      this.logger.error({ err, key, field, correlationId: ctx.correlationId }, 'Cache HGET error');
      throw new CacheOperationError(err.message, 'HGET', `${key}:${field}`, err);
    }
  }

  public async getHealthStatus(): Promise<CacheHealthStatus> {
    const start = Date.now();
    try {
      await this.redis.ping();
      return {
        status: 'ready',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: 'disconnected',
        latencyMs: Date.now() - start,
      };
    }
  }

  public async destroy(): Promise<void> {
    await this.redis.quit();
  }
}
