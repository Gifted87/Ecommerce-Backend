import Redis, { Cluster, RedisOptions } from 'ioredis';
import Opossum from 'opossum';
import { z } from 'zod';
import { pino } from 'pino';

// Schema for environment configuration validation
const RedisConfigSchema = z.object({
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.string().transform(Number).default('6379'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_USE_TLS: z.string().transform((val) => val === 'true').default('false'),
  REDIS_NODES: z.string().optional(), // For cluster mode, comma-separated 'host:port'
});

const logger = pino({ level: 'info' });

/**
 * Domain-specific error class for Redis operations
 */
export class RedisCacheError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly correlationId?: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'RedisCacheError';
  }
}

/**
 * Production-ready Redis infrastructure client
 */
export class RedisClient {
  private static instance: RedisClient;
  private client: Redis | Cluster;
  private breaker: Opossum;
  private log = logger.child({ module: 'RedisClient' });

  private constructor() {
    const config = RedisConfigSchema.parse(process.env);
    
    const options: RedisOptions = {
      password: config.REDIS_PASSWORD,
      tls: config.REDIS_USE_TLS ? {} : undefined,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 1000, 30000);
        this.log.info({ times, delay }, 'Redis connection retry strategy initiated');
        return delay;
      },
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
    };

    if (config.REDIS_NODES) {
      const nodes = config.REDIS_NODES.split(',').map((node) => {
        const [host, port] = node.split(':');
        return { host, port: parseInt(port, 10) };
      });
      this.client = new Cluster(nodes, { redisOptions: options });
    } else {
      this.client = new Redis({
        ...options,
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
      });
    }

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

  public async get<T>(key: string, correlationId?: string): Promise<T | null> {
    try {
      const data = await this.breaker.fire('get', key);
      return data ? JSON.parse(data as string) : null;
    } catch (err: any) {
      this.log.error({ err, key, correlationId }, 'Failed to execute GET');
      throw new RedisCacheError(`Failed to get key: ${key}`, 'GET_ERROR', correlationId, err);
    }
  }

  public async set(key: string, value: any, ttlSeconds?: number, correlationId?: string): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.breaker.fire('set', key, serialized, 'EX', ttlSeconds);
      } else {
        await this.breaker.fire('set', key, serialized);
      }
    } catch (err: any) {
      this.log.error({ err, key, correlationId }, 'Failed to execute SET');
      throw new RedisCacheError(`Failed to set key: ${key}`, 'SET_ERROR', correlationId, err);
    }
  }

  public async del(key: string, correlationId?: string): Promise<void> {
    try {
      await this.breaker.fire('del', key);
    } catch (err: any) {
      this.log.error({ err, key, correlationId }, 'Failed to execute DEL');
      throw new RedisCacheError(`Failed to delete key: ${key}`, 'DEL_ERROR', correlationId, err);
    }
  }

  public async hset(key: string, field: string, value: any, correlationId?: string): Promise<void> {
    try {
      await this.breaker.fire('hset', key, field, JSON.stringify(value));
    } catch (err: any) {
      this.log.error({ err, key, correlationId }, 'Failed to execute HSET');
      throw new RedisCacheError(`Failed to hset key: ${key}`, 'HSET_ERROR', correlationId, err);
    }
  }

  public async hget<T>(key: string, field: string, correlationId?: string): Promise<T | null> {
    try {
      const data = await this.breaker.fire('hget', key, field);
      return data ? JSON.parse(data as string) : null;
    } catch (err: any) {
      this.log.error({ err, key, correlationId }, 'Failed to execute HGET');
      throw new RedisCacheError(`Failed to hget key: ${key}`, 'HGET_ERROR', correlationId, err);
    }
  }

  public async evalScript<T>(script: string, keys: string[], args: any[], correlationId?: string): Promise<T> {
    try {
      return await this.breaker.fire('eval', script, keys.length, ...keys, ...args);
    } catch (err: any) {
      this.log.error({ err, correlationId }, 'Failed to execute LUA script');
      throw new RedisCacheError('Failed to execute atomic script', 'EVAL_ERROR', correlationId, err);
    }
  }

  public async getHealth(): Promise<{ status: string; latency: number }> {
    const start = Date.now();
    try {
      await this.client.ping();
      return { status: 'ready', latency: Date.now() - start };
    } catch {
      return { status: 'disconnected', latency: -1 };
    }
  }
}
