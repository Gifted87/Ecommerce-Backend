import { Logger } from 'pino';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { setTimeout } from 'timers/promises';

/**
 * Interface for the reconciliation task executor.
 */
export interface IReconciliationTask {
  execute(skuRange: string): Promise<void>;
}

/**
 * Configuration for the Background Scheduler.
 */
export interface SchedulerConfig {
  reconciliationFrequencyMs: number;
  maxRetryAttempts: number;
  baseDelayMs: number;
}

/**
 * BackgroundScheduler orchestrates the reconciliation lifecycle.
 * It manages execution cycles, handles distributed locking, and implements exponential backoff.
 */
export class BackgroundScheduler extends EventEmitter {
  private isRunning: boolean = false;
  private readonly config: SchedulerConfig;

  constructor(
    private readonly taskExecutor: IReconciliationTask,
    private readonly redis: Redis,
    private readonly logger: Logger,
    config: Partial<SchedulerConfig> = {}
  ) {
    super();
    this.config = {
      reconciliationFrequencyMs: config.reconciliationFrequencyMs || 60000,
      maxRetryAttempts: config.maxRetryAttempts || 5,
      baseDelayMs: config.baseDelayMs || 1000,
    };
  }

  /**
   * Starts the scheduler loop.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('BackgroundScheduler starting reconciliation loop.');
    this.runLoop().catch((err) => {
      this.logger.error({ err }, 'BackgroundScheduler loop terminated unexpectedly.');
    });
  }

  /**
   * Stops the scheduler loop.
   */
  public stop(): void {
    this.isRunning = false;
    this.logger.info('BackgroundScheduler stopped.');
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      const startTime = Date.now();
      
      try {
        // Simple partitioning strategy based on SKU ranges
        // In a production environment, this would dynamically fetch active ranges
        await this.performReconciliationCycle('default-range');
      } catch (err) {
        this.logger.error({ err }, 'Critical failure in reconciliation cycle.');
      }

      const duration = Date.now() - startTime;
      const jitter = Math.random() * 5000;
      const delay = Math.max(0, this.config.reconciliationFrequencyMs - duration) + jitter;
      
      await setTimeout(delay);
    }
  }

  private async performReconciliationCycle(skuRange: string): Promise<void> {
    const lockKey = `recon:lock:${skuRange}`;
    const requestId = Math.random().toString(36).substring(7);
    
    // Acquire lock with TTL
    const acquired = await this.redis.set(lockKey, requestId, 'EX', 30, 'NX');
    if (!acquired) {
      this.logger.debug({ skuRange }, 'Could not acquire lock, skipping cycle.');
      return;
    }

    try {
      this.logger.info({ skuRange }, 'Starting reconciliation cycle.');
      await this.executeWithRetry(skuRange);
      this.logger.info({ skuRange }, 'Reconciliation cycle completed successfully.');
    } catch (err) {
      this.logger.error({ skuRange, err }, 'Reconciliation cycle failed.');
    } finally {
      // Release lock safely
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await this.redis.eval(script, 1, lockKey, requestId);
    }
  }

  private async executeWithRetry(skuRange: string): Promise<void> {
    let attempt = 0;
    
    while (attempt < this.config.maxRetryAttempts) {
      try {
        await this.taskExecutor.execute(skuRange);
        return;
      } catch (err) {
        attempt++;
        if (attempt >= this.config.maxRetryAttempts) {
          this.logger.error({ skuRange, attempt, err }, 'Max retries reached for reconciliation task.');
          throw err;
        }

        const backoff = this.config.baseDelayMs * Math.pow(2, attempt) + (Math.random() * 1000);
        this.logger.warn({ skuRange, attempt, backoff }, 'Retrying reconciliation task.');
        await setTimeout(backoff);
      }
    }
  }
}
