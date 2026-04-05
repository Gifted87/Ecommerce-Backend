import Redis from 'ioredis';
import Opossum from 'opossum';
import { Logger } from 'pino';
import { randomUUID } from 'crypto';

/**
 * Custom error class for Cart concurrency issues.
 */
export class CartConcurrencyError extends Error {
  constructor(public message: string, public userId: string) {
    super(message);
    this.name = 'CartConcurrencyError';
  }
}

/**
 * Custom error class for service availability issues.
 */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * CartLockManager handles distributed locking for cart operations.
 * Implements SET NX EX pattern with atomic Lua-based release.
 */
export class CartLockManager {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly breaker: Opossum;
  private readonly releaseScriptSha: string = '';

  private readonly RELEASE_LUA_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(redisClient: Redis, logger: Logger) {
    this.redis = redisClient;
    this.logger = logger.child({ module: 'CartLockManager' });

    const options = {
      timeout: 500,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breaker = new Opossum(async (cmd: string, ...args: any[]) => {
      return (this.redis as any)[cmd](...args);
    }, options);

    this.breaker.fallback(() => {
      throw new ServiceUnavailableError('Cart locking service currently unavailable.');
    });
  }

  /**
   * Executes a callback within a distributed lock.
   */
  public async withLock<T>(userId: string, ttlSeconds: number, callback: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
      throw new Error('Invalid userId format');
    }

    const lockKey = `cart:lock:${userId}`;
    const requestId = randomUUID();

    await this.acquireLockWithRetry(lockKey, requestId, ttlSeconds);

    const startTime = Date.now();
    try {
      return await callback();
    } finally {
      const duration = Date.now() - startTime;
      await this.releaseLock(lockKey, requestId);
      this.logger.info({ userId, requestId, duration }, 'Lock released');
    }
  }

  private async acquireLockWithRetry(key: string, requestId: string, ttl: number): Promise<void> {
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
    throw new CartConcurrencyError('Could not acquire cart lock', key);
  }

  private async releaseLock(key: string, requestId: string): Promise<void> {
    try {
      await this.breaker.fire('eval', this.RELEASE_LUA_SCRIPT, 1, key, requestId);
    } catch (error) {
      this.logger.error({ key, requestId, error }, 'Error releasing lock');
    }
  }
}
