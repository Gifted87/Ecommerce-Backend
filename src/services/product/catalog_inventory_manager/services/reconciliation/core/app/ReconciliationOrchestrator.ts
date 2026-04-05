import { Logger } from 'pino';
import { Knex } from 'knex';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import { ReconciliationCacheManager } from '../infrastructure/ReconciliationCacheManager';
import { ConfigurationProvider } from '../config/ConfigurationProvider';

/**
 * Zod schema for validated inventory discrepancy events.
 */
export const DiscrepancySchema = z.object({
  sku: z.string(),
  dbQuantity: z.number().int(),
  eventQuantity: z.number().int(),
  variance: z.number().int(),
  timestamp: z.string().datetime(),
});

export type Discrepancy = z.infer<typeof DiscrepancySchema>;

/**
 * Orchestrates the inventory reconciliation cycle.
 * Manages distributed locks, transaction snapshots, and discrepancy resolution.
 */
export class ReconciliationOrchestrator {
  private readonly dbBreaker: CircuitBreaker;
  private readonly cacheBreaker: CircuitBreaker;

  constructor(
    private readonly db: Knex,
    private readonly cacheManager: ReconciliationCacheManager,
    private readonly configProvider: ConfigurationProvider,
    private readonly logger: Logger
  ) {
    const breakerOptions = {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.dbBreaker = new CircuitBreaker(async (fn: () => Promise<any>) => fn(), breakerOptions);
    this.cacheBreaker = new CircuitBreaker(async (fn: () => Promise<any>) => fn(), breakerOptions);
  }

  /**
   * Executes a reconciliation cycle for a specific SKU range.
   */
  public async reconcileSkuRange(skuRange: string): Promise<void> {
    this.logger.info({ msg: 'Starting reconciliation cycle', skuRange });

    const locked = await this.cacheBreaker.fire(() => this.cacheManager.lockSkuRange(skuRange, 60));
    if (!locked) {
      this.logger.warn({ msg: 'Could not acquire lock for SKU range', skuRange });
      return;
    }

    try {
      await this.db.transaction(async (trx) => {
        // Snapshot inventory state
        const snapshot = await this.dbBreaker.fire(async () =>
          trx('inventory')
            .select('sku', 'quantity')
            .where('sku', 'like', `${skuRange}%`)
            .forUpdate()
        );

        // Audit against event store stream
        const discrepancies = await this.performAudit(snapshot);

        // Resolve discrepancies
        for (const discrepancy of discrepancies) {
          await this.resolveDiscrepancy(trx, discrepancy);
        }
      });
    } catch (error) {
      this.logger.error({ msg: 'Reconciliation cycle failed', skuRange, error });
      throw error;
    } finally {
      await this.cacheBreaker.fire(() => this.cacheManager.releaseSkuRange(skuRange));
      this.logger.info({ msg: 'Reconciliation cycle completed', skuRange });
    }
  }

  private async performAudit(snapshot: any[]): Promise<Discrepancy[]> {
    const discrepancies: Discrepancy[] = [];
    
    for (const item of snapshot) {
      const cachedState = await this.cacheBreaker.fire(() => this.cacheManager.getInventoryState(item.sku));
      
      if (cachedState && cachedState.quantity !== item.quantity) {
        const variance = cachedState.quantity - item.quantity;
        discrepancies.push({
          sku: item.sku,
          dbQuantity: item.quantity,
          eventQuantity: cachedState.quantity,
          variance,
          timestamp: new Date().toISOString(),
        });
      }
    }
    return discrepancies;
  }

  private async resolveDiscrepancy(trx: Knex.Transaction, discrepancy: Discrepancy): Promise<void> {
    const THRESHOLD = 100;
    
    if (Math.abs(discrepancy.variance) > THRESHOLD) {
      this.logger.error({
        msg: 'CRITICAL_INCONSISTENCY detected',
        diagnostic: this.configProvider.redact({ discrepancy }),
      });
      return;
    }

    await trx('inventory')
      .where('sku', discrepancy.sku)
      .update({
        quantity: discrepancy.eventQuantity,
        updated_at: this.db.fn.now(),
      });

    this.logger.info({ msg: 'Discrepancy resolved', sku: discrepancy.sku, newQuantity: discrepancy.eventQuantity });
  }
}
