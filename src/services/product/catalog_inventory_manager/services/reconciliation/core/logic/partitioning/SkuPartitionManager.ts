import { Logger } from 'pino';
import Opossum = require('opossum');
import { ReconciliationCacheManager } from '../../infrastructure/cache/reconciliation_cache_manager';

/**
 * SkuPartitionManager manages the partitioning of SKU ranges for distributed
 * reconciliation tasks, ensuring only one worker processes a given range at a time.
 */
export class SkuPartitionManager {
  // Use any to bypass TS namespace issue
  private readonly breaker: any;
  private readonly logger: Logger;

  constructor(
    private readonly cache: ReconciliationCacheManager,
    private readonly loggerInstance: Logger
  ) {
    this.logger = loggerInstance.child({ module: 'logic/sku-partition-manager' });
    
    this.breaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 2000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  public async acquireLock(skuRange: string, correlationId: string): Promise<boolean> {
    try {
      // Corrected method call based on error
      return await this.breaker.fire(() => this.cache.lockSkuRange(skuRange, correlationId));
    } catch (error) {
      this.logger.error({ error, skuRange, correlationId }, 'Failed to acquire lock');
      return false;
    }
  }

  public async releaseLock(skuRange: string, correlationId: string): Promise<void> {
    try {
      // Corrected method call based on error
      await this.breaker.fire(() => this.cache.releaseSkuRange(skuRange, correlationId));
    } catch (error) {
      this.logger.error({ error, skuRange, correlationId }, 'Failed to release lock');
    }
  }
}
