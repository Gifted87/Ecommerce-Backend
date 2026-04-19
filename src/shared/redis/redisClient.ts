import Redis, { RedisOptions, ChainableCommander } from 'ioredis';
import Opossum = require('opossum');

/**
 * Custom error class for Redis operations
 */
export class RedisCacheError extends Error {
  constructor(public message: string, public code: string, public originalError?: Error) {
    super(message);
    this.name = 'RedisCacheError';
  }
}

/**
 * Interface for health status
 */
export interface RedisHealthStatus {
  status: 'connected' | 'reconnecting' | 'disconnected' | 'open';
  latency: number;
}

/**
 * Production-ready Redis client wrapper providing abstraction for caching operations.
 * Implements singleton pattern for connection efficiency and Opossum for fault tolerance.
 */
export class RedisClient {
  private static instance: RedisClient;
  private client: Redis;
  // Use any to bypass TS namespace issue
  private breaker: any;

  private constructor() {
    const options: RedisOptions = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_USE_TLS === 'true' ? {} : undefined,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    };

    this.client = new Redis(options);

    this.client.on('connect', () => console.info('Redis client connecting...'));
    this.client.on('ready', () => console.info('Redis client ready.'));
    this.client.on('error', (err) => console.error('Redis client error:', err));
    this.client.on('close', () => console.warn('Redis connection closed.'));

    // Circuit Breaker configuration
    this.breaker = new Opossum(async (command: string, ...args: any[]) => {
      return (this.client as any)[command](...args);
    }, {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  /**
   * Retrieves a value from cache and parses JSON.
   */
  public async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.breaker.fire('get', key);
      return data ? JSON.parse(data as string) : null;
    } catch (err) {
      throw new RedisCacheError(`Failed to get key: ${key}`, 'GET_ERROR', err as Error);
    }
  }

  /**
   * Sets a value in cache with optional TTL (in seconds).
   */
  public async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.breaker.fire('set', key, serialized, 'EX', ttlSeconds);
      } else {
        await this.breaker.fire('set', key, serialized);
      }
    } catch (err) {
      throw new RedisCacheError(`Failed to set key: ${key}`, 'SET_ERROR', err as Error);
    }
  }

  /**
   * Deletes a key from cache.
   */
  public async del(key: string): Promise<void> {
    try {
      await this.breaker.fire('del', key);
    } catch (err) {
      throw new RedisCacheError(`Failed to delete key: ${key}`, 'DEL_ERROR', err as Error);
    }
  }

  /**
   * Hash set operation.
   */
  public async hset(key: string, field: string, value: any): Promise<void> {
    try {
      await this.breaker.fire('hset', key, field, JSON.stringify(value));
    } catch (err) {
      throw new RedisCacheError(`Failed to hset key: ${key}`, 'HSET_ERROR', err as Error);
    }
  }

  /**
   * Hash get operation.
   */
  public async hget<T>(key: string, field: string): Promise<T | null> {
    try {
      const data = await this.breaker.fire('hget', key, field);
      return data ? JSON.parse(data as string) : null;
    } catch (err) {
      throw new RedisCacheError(`Failed to hget key: ${key}`, 'HGET_ERROR', err as Error);
    }
  }

  /**
   * Returns a pipeline instance for batching commands.
   */
  public pipeline(): ChainableCommander {
    return this.client.pipeline();
  }

  /**
   * Provides health status for observability.
   */
  public async getHealth(): Promise<RedisHealthStatus> {
    const start = Date.now();
    try {
      await this.client.ping();
      return {
        status: this.breaker.opened ? 'open' : 'connected',
        latency: Date.now() - start,
      };
    } catch {
      return {
        status: 'disconnected',
        latency: -1,
      };
    }
  }
}
