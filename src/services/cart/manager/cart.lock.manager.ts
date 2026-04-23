import Redis from 'ioredis';
import CircuitBreaker = require('opossum');
import { Logger } from 'pino';
import { randomUUID } from 'crypto';
import Redlock from 'redlock';
import { CartConcurrencyError } from './cart.errors';

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
 * CartLockManager handles locking for cart operations.
 * Implements SET NX EX pattern with atomic Lua-based release.
 * NOTE: This is a single-node lock algorithm. In a Redis Cluster failover, 
 * Redlock or a wait-consensus model is recommended to prevent split-brain locking.
 * This class isolates its lock keys within the "{cart-lock}" hashtag to avoid cluster slot issues.
 */
export class CartLockManager {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly redlock: Redlock;

  constructor(redisClient: Redis, logger: Logger, extraRedlockNodes?: Redis[]) {
    this.redis = redisClient;
    this.logger = logger.child({ module: 'CartLockManager' });
    const allNodes: Redis[] = [this.redis, ...(extraRedlockNodes ?? [])];

    if (allNodes.length < 3) {
      this.logger.warn(
        { nodeCount: allNodes.length },
        'CartLockManager: Redlock is operating with fewer than 3 independent Redis nodes. ' +
        'Split-brain safety is NOT guaranteed. Set REDIS_REDLOCK_NODES in production.'
      );
    }

    this.redlock = new Redlock(allNodes, {
      driftFactor: 0.01,
      retryCount: 5,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });
    
    this.redlock.on('error', (error: any) => {
      this.logger.error({ error }, 'Redlock encountered an error');
    });
  }

  /**
   * Executes a callback within a distributed lock.
   */
  public async withLock<T>(userId: string, ttlSeconds: number, callback: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
      throw new Error('Invalid userId format');
    }

    const lockKey = `{cart-lock}:${userId}`;
    let lock;

    try {
      lock = await this.redlock.acquire([lockKey], ttlSeconds * 1000);
      this.logger.info({ userId }, 'Cart Lock acquired via Redlock');
      
      const startTime = Date.now();
      const result = await callback();
      const duration = Date.now() - startTime;
      
      this.logger.info({ userId, duration }, 'Cart Lock released efficiently');
      return result;
    } catch (error) {
      if ((error as any).name === 'ExecutionError') {
        throw new CartConcurrencyError('Failed to acquire Cart Lock', { resourceId: lockKey });
      }
      throw error;
    } finally {
      if (lock) {
        await lock.release().catch(err => this.logger.error({ err }, 'Failed to release Cart Redlock'));
      }
    }
  }
}
