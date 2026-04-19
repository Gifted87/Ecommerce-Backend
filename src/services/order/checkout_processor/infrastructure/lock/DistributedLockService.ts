import Redis from 'ioredis';
import Opossum = require('opossum');
import { randomUUID } from 'crypto';
import { Logger } from 'pino';

/**
 * Custom error class for Distributed Lock Service operations.
 */
export class DistributedLockError extends Error {
  constructor(public message: string, public code: string, public originalError?: Error) {
    super(message);
    this.name = 'DistributedLockError';
  }
}

/**
 * DistributedLockService provides a mutex locking mechanism using Redis.
 * Ensures that only one worker node can process a specific OrderID at a time.
 */
export class DistributedLockService {
  private redis: Redis;
  // Use any to bypass TS namespace issue
  private breaker: any;
  private readonly DEFAULT_TTL = 5; // seconds

  /**
   * @param redisClient An initialized ioredis instance.
   * @param logger A pino logger instance for structured logging.
   */
  constructor(
    private redisClient: Redis,
    private logger: Logger
  ) {
    this.redis = redisClient;

    // Circuit breaker configuration
    const options = {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breaker = new Opossum(async (cmd: string, ...args: any[]) => {
      return (this.redis as any)[cmd](...args);
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
  public async withLock<T>(orderId: string, callback: () => Promise<T>): Promise<T> {
    const lockKey = `order:lock:${orderId}`;
    const requestId = randomUUID();

    const acquired = await this.acquireLock(lockKey, requestId);

    if (!acquired) {
      throw new DistributedLockError(
        `Could not acquire lock for order: ${orderId}`,
        'LOCK_ACQUISITION_FAILED'
      );
    }

    try {
      this.logger.info({ orderId, requestId }, 'Lock acquired');
      return await callback();
    } catch (error) {
      this.logger.error({ orderId, requestId, error }, 'Error during locked operation');
      throw error;
    } finally {
      await this.releaseLock(lockKey, requestId);
    }
  }

  /**
   * Attempts to acquire a Redis lock using SET NX EX.
   */
  private async acquireLock(key: string, requestId: string): Promise<boolean> {
    try {
      const result = await this.breaker.fire('set', key, requestId, 'EX', this.DEFAULT_TTL, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.error({ key, error }, 'Failed to acquire lock');
      throw new DistributedLockError('Redis error during lock acquisition', 'REDIS_ERROR', error as Error);
    }
  }

  /**
   * Releases the lock only if the current requestId matches the one in Redis.
   * Uses a Lua script to ensure atomic check-and-delete.
   */
  private async releaseLock(key: string, requestId: string): Promise<void> {
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
    } catch (error) {
      this.logger.error({ key, requestId, error }, 'Failed to release lock');
      throw new DistributedLockError('Redis error during lock release', 'REDIS_ERROR', error as Error);
    }
  }

  /**
   * Returns current service health status.
   */
  public async getHealth(): Promise<{ status: 'healthy' | 'unhealthy'; redis: string; circuit: string }> {
    const redisStatus = this.redis.status;
    const circuitStatus = this.breaker.opened ? 'open' : 'closed';

    return {
      status: redisStatus === 'ready' && circuitStatus === 'closed' ? 'healthy' : 'unhealthy',
      redis: redisStatus,
      circuit: circuitStatus,
    };
  }
}
