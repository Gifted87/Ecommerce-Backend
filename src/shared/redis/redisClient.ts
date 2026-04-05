import Redis, { RedisOptions, ChainableCommander } from 'ioredis';
import Opossum from 'opossum';
import logger from '../logging/logger'; // Assuming logger is in ../logging/logger

/**
 * Custom error class for Redis operations to abstract implementation details.
 */
export class RedisCacheError extends Error {
  public readonly code: string;
  public readonly originalError?: Error;

  constructor(message: string, code: string, originalError?: Error) {
    super(message);
    this.name = 'RedisCacheError';
    this.code = code;
    this.originalError = originalError;
  }
}

/**
 * Interface for health status response.
 */
export interface RedisHealthStatus {
  status: 'connected' | 'reconnecting' | 'disconnected' | 'ready';
  latency: number;
}

/**
 * Production-ready Redis client wrapper.
 * Implements singleton pattern, circuit breaking with Opossum,
 * structured JSON logging, and connection management.
 */
export class RedisClient {
  private static instance: RedisClient;
  private client: Redis;
  private breaker: Opossum;
  private log = logger.child({ module: 'RedisClient' });

  private constructor() {
    const options: RedisOptions = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_USE_TLS === 'true' ? {} : undefined,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 1000, 30000);
        this.log.info({ times, delay }, 'Redis connection retry strategy initiated');
        return delay;
      },
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
    };

    this.client = new Redis(options);

    this.client.on('connect', () => this.log.info('Redis client connecting...'));
    this.client.on('ready', () => this.log.info('Redis client ready.'));
    this.client.on('error', (err) => this.log.error({ err }, 'Redis client connection error'));
    this.client.on('close', () => this.log.warn('Redis connection closed.'));

    // Circuit Breaker configuration
    this.breaker = new Opossum(
      async (command: string, ...args: any[]) => {
        return (this.client as any)[command](...args);
      },
      {
        timeout: 3000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.breaker.on('open', () => this.log.error('Redis circuit breaker opened.'));
    this.breaker.on('halfOpen', () => this.log.info('Redis circuit breaker half-open.'));
    this.breaker.on('close', () => this.log.info('Redis circuit breaker closed.'));
  }

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  public async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.breaker.fire('get', key);
      return data ? JSON.parse(data as string) : null;
    } catch (err) {
      this.log.error({ err, key }, 'Failed to execute GET');
      throw new RedisCacheError(`Failed to get key: ${key}`, 'GET_ERROR', err as Error);
    }
  }

  public async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.breaker.fire('set', key, serialized, 'EX', ttlSeconds);
      } else {
        await this.breaker.fire('set', key, serialized);
      }
    } catch (err) {
      this.log.error({ err, key }, 'Failed to execute SET');
      throw new RedisCacheError(`Failed to set key: ${key}`, 'SET_ERROR', err as Error);
    }
  }

  public async del(key: string): Promise<void> {
    try {
      await this.breaker.fire('del', key);
    } catch (err) {
      this.log.error({ err, key }, 'Failed to execute DEL');
      throw new RedisCacheError(`Failed to delete key: ${key}`, 'DEL_ERROR', err as Error);
    }
  }

  public async hset(key: string, field: string, value: any): Promise<void> {
    try {
      await this.breaker.fire('hset', key, field, JSON.stringify(value));
    } catch (err) {
      this.log.error({ err, key, field }, 'Failed to execute HSET');
      throw new RedisCacheError(`Failed to hset key: ${key}`, 'HSET_ERROR', err as Error);
    }
  }

  public async hget<T>(key: string, field: string): Promise<T | null> {
    try {
      const data = await this.breaker.fire('hget', key, field);
      return data ? JSON.parse(data as string) : null;
    } catch (err) {
      this.log.error({ err, key, field }, 'Failed to execute HGET');
      throw new RedisCacheError(`Failed to hget key: ${key}`, 'HGET_ERROR', err as Error);
    }
  }

  public pipeline(): ChainableCommander {
    return this.client.pipeline();
  }

  public async getHealth(): Promise<RedisHealthStatus> {
    const start = Date.now();
    try {
      await this.client.ping();
      return {
        status: this.client.status as any,
        latency: Date.now() - start,
      };
    } catch (err) {
      return {
        status: 'disconnected',
        latency: -1,
      };
    }
  }
}
