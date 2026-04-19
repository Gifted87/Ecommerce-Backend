import { Logger } from 'pino';
import Opossum = require('opossum');
import { ReconciliationCacheManager } from '../infrastructure/cache/reconciliation_cache_manager';
import { ConfigurationProvider } from '../config/configService';
import { DiscrepancyAuditorEngine } from '../logic/auditor/discrepancyAuditorEngine';
import { EventReplayEngine } from '../logic/replay/event_replay_engine';

/**
 * ReconciliationOrchestrator
 * High-level service to manage the lifecycle of reconciliation jobs.
 */
export class ReconciliationOrchestrator {
  // Use any to bypass TS namespace issue
  private readonly auditorBreaker: any;
  // Use any to bypass TS namespace issue
  private readonly replayBreaker: any;

  constructor(
    private readonly cache: ReconciliationCacheManager,
    private readonly config: ConfigurationProvider,
    private readonly auditor: DiscrepancyAuditorEngine,
    private readonly replayEngine: EventReplayEngine,
    private readonly logger: Logger
  ) {
    this.logger = logger.child({ module: 'ReconciliationOrchestrator' });

    const breakerOptions = {
      timeout: 10000,
      errorThresholdPercentage: 30,
      resetTimeout: 60000,
    };

    this.auditorBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), breakerOptions);
    this.replayBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), breakerOptions);
  }

  public async orchestrate(correlationId: string): Promise<void> {
    this.logger.info({ correlationId }, 'Starting orchestration');
    
    try {
      // Logic for orchestrating auditing and replay
      await this.auditorBreaker.fire(() => this.auditor.audit(correlationId));
      await this.replayBreaker.fire(() => this.replayEngine.start());
      
      this.logger.info({ correlationId }, 'Orchestration complete');
    } catch (error: any) {
      this.logger.error({ error, correlationId }, 'Orchestration failed');
      throw error;
    }
  }
}
