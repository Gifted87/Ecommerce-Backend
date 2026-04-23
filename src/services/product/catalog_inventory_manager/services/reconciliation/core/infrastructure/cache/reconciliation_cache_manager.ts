import Redis from 'ioredis';

/**
 * Production-ready Redis cache client for reconciliation inventory state.
 * Uses ioredis for robust connection management, pipelining, and error handling.
 */
export class ReconciliationCacheManager {
  private client: Redis;

  constructor(redisUrl: string = process.env.REDIS_URL || 'redis://localhost:6379') {
    this.client = new Redis(redisUrl, {
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    this.client.on('error', (err) => {
      console.error('ReconciliationCacheManager Redis Error:', err);
    });
  }

  /**
   * Sets product inventory state in cache with a TTL.
   */
  async setInventoryState(productId: string, state: Record<string, any>, ttlSeconds: number = 3600): Promise<void> {
    const key = `reconciliation:inventory:${productId}`;
    await this.client.set(key, JSON.stringify(state), 'EX', ttlSeconds);
  }

  /**
   * Retrieves product inventory state from cache.
   */
  async getInventoryState(productId: string): Promise<Record<string, any> | null> {
    const key = `reconciliation:inventory:${productId}`;
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Deletes cached inventory state.
   */
  async invalidate(productId: string): Promise<void> {
    const key = `reconciliation:inventory:${productId}`;
    await this.client.del(key);
  }

  async lockSkuRange(skuRange: string, correlationId: string): Promise<boolean> {
    const key = `reconciliation:lock:${skuRange}`;
    const result = await this.client.set(key, correlationId, 'EX', 300, 'NX');
    return result === 'OK';
  }

  async releaseSkuRange(skuRange: string, correlationId: string): Promise<void> {
    const key = `reconciliation:lock:${skuRange}`;
    // Use a Lua script to atomically check ownership before deleting
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;
    await this.client.eval(script, 1, key, correlationId);
  }

  /**
   * Graceful shutdown of the Redis connection.
   */
  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
