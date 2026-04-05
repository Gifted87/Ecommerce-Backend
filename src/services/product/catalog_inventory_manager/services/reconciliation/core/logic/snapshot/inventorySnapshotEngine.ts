import { Knex } from 'knex';
import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import Redis from 'ioredis';
import { InventorySnapshotSchema, InventorySnapshot } from '../schemas';

/**
 * Custom error class for snapshot engine operations.
 */
export class InventorySnapshotEngineError extends Error {
  constructor(public message: string, public code: string, public originalError?: any) {
    super(message);
    this.name = 'InventorySnapshotEngineError';
  }
}

/**
 * The InventorySnapshotEngine (ISE) is the foundational component of the Stage 1 reconciliation process.
 * It provides an immutable, point-in-time view of inventory levels across the database catalog.
 */
export class InventorySnapshotEngine {
  private readonly tableName = 'inventory';
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly knex: Knex,
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {
    this.logger = this.logger.child({ module: 'services/reconciliation/snapshot_engine' });

    // Circuit breaker configuration for database and redis operations
    this.breaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    this.breaker.on('open', () => this.logger.error('ISE: Circuit breaker opened.'));
    this.breaker.on('close', () => this.logger.info('ISE: Circuit breaker closed.'));
  }

  /**
   * Captures a snapshot of inventory records for a given SKU range.
   * Ensures serializable transaction isolation and row-level locking.
   */
  public async captureSnapshot(startSku: string, endSku: string): Promise<InventorySnapshot[]> {
    const lockKey = `reconciliation:lock:inventory:${startSku}:${endSku}`;
    
    // Acquire distributed lock to prevent overlapping runs
    const lockAcquired = await this.redis.set(lockKey, 'locked', 'NX', 'EX', 3600);
    if (!lockAcquired) {
      throw new InventorySnapshotEngineError('Reconciliation already in progress for this range', 'LOCK_ACQUIRED_ERROR');
    }

    try {
      return await this.breaker.fire(async () => {
        return await this.executeWithRetry(async () => {
          return await this.knex.transaction(async (trx) => {
            // Set transaction isolation level
            await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

            const rows = await trx(this.tableName)
              .select('*')
              .whereBetween('sku', [startSku, endSku])
              .forUpdate();

            const snapshots: InventorySnapshot[] = [];
            for (const row of rows) {
              const validated = InventorySnapshotSchema.parse(row);
              snapshots.push(validated);
            }

            this.logger.info({ startSku, endSku, count: snapshots.length }, 'Snapshot captured successfully');
            return snapshots;
          });
        });
      });
    } catch (error: any) {
      this.logger.error({ error, startSku, endSku }, 'CRITICAL_INCONSISTENCY: Failed to capture snapshot');
      throw new InventorySnapshotEngineError('Failed to capture snapshot after retries', 'SNAPSHOT_FAILED', error);
    } finally {
      await this.redis.del(lockKey);
    }
  }

  /**
   * Executes database operations with retry logic for deadlocks and serializable conflicts.
   */
  private async executeWithRetry<T>(work: () => Promise<T>, maxRetries = 3): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await work();
      } catch (error: any) {
        attempt++;
        // Postgres error 40P01 (deadlock) or 40001 (serialization failure)
        const isRetryable = error?.code === '40P01' || error?.code === '40001';
        
        if (isRetryable && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 100 + Math.random() * 50;
          this.logger.warn({ attempt, error: error.code }, 'Retryable error detected, backing off');
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw new InventorySnapshotEngineError('Max retries exceeded', 'RETRY_LIMIT_EXCEEDED');
  }

  /**
   * Returns current health status of the engine.
   */
  public getHealth(): { status: string; circuitState: string } {
    return {
      status: 'OK',
      circuitState: this.breaker.opened ? 'OPEN' : 'CLOSED',
    };
  }
}
