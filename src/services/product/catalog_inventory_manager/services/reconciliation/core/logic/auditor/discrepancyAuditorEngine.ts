import { Logger } from 'pino';
import Opossum = require('opossum');
import { InventorySnapshot, InventorySnapshotSchema } from '../../schemas/inventorySchemas';
import { DatabaseService } from '../../infrastructure/database/databaseInfrastructure';
import { KafkaMessagingService } from '../../infrastructure/messaging/kafkaMessagingService';

/**
 * DiscrepancyAuditorEngine is responsible for identifying inconsistencies
 * between the source-of-truth (DB) and the event-stream (Kafka).
 */
export class DiscrepancyAuditorEngine {
  // Use any to bypass TS namespace issue
  private readonly dbBreaker: any;
  // Use any to bypass TS namespace issue
  private readonly kafkaBreaker: any;

  constructor(
    private readonly db: DatabaseService,
    private readonly kafka: KafkaMessagingService,
    private readonly logger: Logger
  ) {
    this.logger = logger.child({ module: 'logic/discrepancy-auditor' });
    
    const breakerOptions = {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.dbBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), breakerOptions);
    this.kafkaBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), breakerOptions);
  }

  public async audit(correlationId: string): Promise<void> {
    this.logger.info({ correlationId }, 'Starting discrepancy audit');
    
    try {
      const dbInventory = await this.dbBreaker.fire(() => this.db.knex('inventory').select('*'));
      
      for (const row of dbInventory) {
        const inventory = InventorySnapshotSchema.parse(row);
        
        // Audit validation against business invariants
        const availableStock = inventory.total_stock - inventory.reserved_stock;
        if (availableStock < 0) {
          this.logger.warn({ sku: inventory.sku, availableStock, correlationId }, 'Negative inventory detected (Violation of constraints)');
          
          await this.kafkaBreaker.fire(() => this.kafka.publish('inventory-discrepancies', inventory.sku, {
            sku: inventory.sku,
            reason: 'NEGATIVE_INVENTORY',
            measured_quantity: availableStock,
            audited_at: new Date().toISOString(),
            correlationId
          }));
        }
      }
      
      this.logger.info({ correlationId }, 'Audit complete');
    } catch (error) {
      this.logger.error({ error, correlationId }, 'Audit failed');
      throw error;
    }
  }
}
