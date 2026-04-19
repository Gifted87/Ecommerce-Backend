import Redis, { RedisOptions } from 'ioredis';
import Opossum = require('opossum');
import { Logger } from 'pino';

/**
 * Custom error class for Redis operations to provide machine-readable error codes.
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
  status: 'ready' | 'connecting' | 'reconnecting' | 'disconnected';
  circuitStatus: 'closed' | 'opened' | 'half-open';
}

/**
 * Production-ready Redis client wrapper.
 * Implements Singleton pattern, circuit breaking with Opossum,
 * structured JSON logging, and connection management.
 */
export class RedisClient {
  private static instance: RedisClient;
  private client: Redis;
  // Use any to bypass TS namespace issue
  private breaker: any;
  private logger: Logger;

  private constructor(logger: Logger) {
    this.logger = logger.child({ module: 'RedisClient' });

    const options: RedisOptions = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_USE_TLS === 'true' ? {} : undefined,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 1000, 30000);
        this.logger.info({ times, delay }, 'Redis connection retry strategy initiated');
        return delay;
      },
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
    };

    this.client = new Redis(options);

    this.client.on('connect', () => this.logger.info('Redis client connecting...'));
    this.client.on('ready', () => this.logger.info('Redis client ready.'));
    this.client.on('error', (err) => this.logger.error({ err }, 'Redis client connection error'));
    this.client.on('close', () => this.logger.warn('Redis connection closed.'));

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

    this.breaker.on('open', () => this.logger.error('Redis circuit breaker opened.'));
    this.breaker.on('halfOpen', () => this.logger.info('Redis circuit breaker half-open.'));
    this.breaker.on('close', () => this.logger.info('Redis circuit breaker closed.'));
  }

  public static initialize(logger: Logger): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient(logger);
    }
    return RedisClient.instance;
  }

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      throw new Error('RedisClient must be initialized with a logger before use.');
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
    } catch (err: any) {
      const code = err.message === 'OpenCircuitError' ? 'CIRCUIT_OPEN' : 'GET_ERROR';
      this.logger.error({ err, key, code }, 'Failed to execute GET');
      throw new RedisCacheError(`Failed to get key: ${key}`, code, err as Error);
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
    } catch (err: any) {
      const code = err.message === 'OpenCircuitError' ? 'CIRCUIT_OPEN' : 'SET_ERROR';
      this.logger.error({ err, key, code }, 'Failed to execute SET');
      throw new RedisCacheError(`Failed to set key: ${key}`, code, err as Error);
    }
  }

  /**
   * Deletes a key from cache.
   */
  public async del(key: string): Promise<void> {
    try {
      await this.breaker.fire('del', key);
    } catch (err: any) {
      const code = err.message === 'OpenCircuitError' ? 'CIRCUIT_OPEN' : 'DEL_ERROR';
      this.logger.error({ err, key, code }, 'Failed to execute DEL');
      throw new RedisCacheError(`Failed to delete key: ${key}`, code, err as Error);
    }
  }

  /**
   * Hash set operation.
   */
  public async hset(key: string, field: string, value: any): Promise<void> {
    try {
      await this.breaker.fire('hset', key, field, JSON.stringify(value));
    } catch (err: any) {
      const code = err.message === 'OpenCircuitError' ? 'CIRCUIT_OPEN' : 'HSET_ERROR';
      this.logger.error({ err, key, field, code }, 'Failed to execute HSET');
      throw new RedisCacheError(`Failed to hset key: ${key}, field: ${field}`, code, err as Error);
    }
  }

  /**
   * Hash get operation.
   */
  public async hget<T>(key: string, field: string): Promise<T | null> {
    try {
      const data = await this.breaker.fire('hget', key, field);
      return data ? JSON.parse(data as string) : null;
    } catch (err: any) {
      const code = err.message === 'OpenCircuitError' ? 'CIRCUIT_OPEN' : 'HGET_ERROR';
      this.logger.error({ err, key, field, code }, 'Failed to execute HGET');
      throw new RedisCacheError(`Failed to hget key: ${key}, field: ${field}`, code, err as Error);
    }
  }

  /**
   * Returns current service health status.
   */
  public async getHealth(): Promise<RedisHealthStatus> {
    const circuitStatus = this.breaker.opened
      ? 'opened'
      : this.breaker.pendingClose
      ? 'half-open'
      : 'closed';

    return {
      status: this.client.status as 'ready' | 'connecting' | 'reconnecting' | 'disconnected',
      circuitStatus,
    };
  }
}
