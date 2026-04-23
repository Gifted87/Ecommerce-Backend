import Redis from 'ioredis';
import CircuitBreaker = require('opossum');
import { randomUUID } from 'crypto';
import { Logger } from 'pino';
import Redlock from 'redlock';

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
 * DistributedLockService provides a mutex locking mechanism using Redlock.
 *
 * For true split-brain safety in a Redis Cluster, supply REDIS_REDLOCK_NODES as a
 * comma-separated list of ≥3 independent Redis primary URLs. When only one node is
 * provided a prominent startup warning is logged — the lock will still work, but
 * cannot survive a Redis primary failover without a window of unsafe locking.
 *
 * @example
 *   REDIS_REDLOCK_NODES=redis1:6379,redis2:6379,redis3:6379
 */
export class DistributedLockService {
  private redis: Redis;
  private redlock: Redlock;
  private readonly DEFAULT_TTL = 5; // seconds

  constructor(
    private redisClient: Redis,
    private logger: Logger,
    extraRedlockNodes?: Redis[]
  ) {
    this.redis = redisClient;
    const allNodes: Redis[] = [this.redis, ...(extraRedlockNodes ?? [])];

    if (allNodes.length < 3) {
      this.logger.warn(
        { nodeCount: allNodes.length },
        'DistributedLockService: Redlock is operating with fewer than 3 independent Redis ' +
        'nodes. This does NOT provide consensus-based safety against split-brain locking. ' +
        'Set REDIS_REDLOCK_NODES with ≥3 independent primaries in production.'
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
   * Executes a provided callback function within a distributed lock.
   * Ensures atomicity of lock acquisition and release.
   * 
   * @param orderId The ID of the order to lock.
   * @param callback The async function to execute.
   * @returns The result of the callback.
   */
  public async withLock<T>(orderId: string, callback: () => Promise<T>): Promise<T> {
    const lockKey = `{order-lock}:${orderId}`;
    let lock;

    try {
      lock = await this.redlock.acquire([lockKey], this.DEFAULT_TTL * 1000);
      this.logger.info({ orderId }, 'Lock acquired via Redlock');
      return await callback();
    } catch (error) {
      if ((error as any).name === 'ExecutionError') {
        throw new DistributedLockError(`Could not acquire lock for order: ${orderId}`, 'LOCK_ACQUISITION_FAILED');
      }
      this.logger.error({ orderId, error }, 'Error during locked operation');
      throw error;
    } finally {
      if (lock) {
        await lock.release().catch(err => this.logger.error({ err }, 'Failed to release Redlock'));
      }
    }
  }

  /**
   * Returns current service health status.
   */
  public async getHealth(): Promise<{ status: 'healthy' | 'unhealthy'; redis: string }> {
    const redisStatus = this.redis.status;

    return {
      status: redisStatus === 'ready' ? 'healthy' : 'unhealthy',
      redis: redisStatus,
    };
  }
}
