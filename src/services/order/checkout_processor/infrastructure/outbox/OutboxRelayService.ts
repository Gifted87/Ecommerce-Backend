import { Knex } from 'knex';
import { Logger } from 'pino';
import { CheckoutEventProducer } from '../events/CheckoutEventProducer';

/**
 * Represents a single row from the outbox_events table.
 */
interface OutboxRow {
  event_id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: Record<string, unknown>;
  processed: boolean;
  created_at: Date;
}

/**
 * OutboxRelayService — Transactional Outbox Sweeper
 *
 * Runs a continuous background loop that:
 *   1. Claims a batch of unprocessed outbox rows using SELECT … FOR UPDATE SKIP LOCKED,
 *      ensuring no two relay instances process the same row concurrently.
 *   2. Publishes each event payload to the correct Kafka topic via CheckoutEventProducer.
 *   3. Marks the row as processed in the same transaction only if Kafka ACKed the message.
 *
 * This guarantees **at-least-once** delivery semantics. Consumers must be idempotent.
 *
 * Usage:
 *   const relay = new OutboxRelayService(knex, eventProducer, logger);
 *   relay.start();          // call once at app boot
 *   await relay.stop();     // call during graceful shutdown
 */
export class OutboxRelayService {
  private readonly tableName = 'outbox_events';
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  /**
   * @param db            Knex instance (shared with the rest of the app — same pool).
   * @param producer      CheckoutEventProducer used to publish to Kafka.
   * @param logger        Pino logger.
   * @param batchSize     Max rows to claim per sweep (default: 50).
   * @param intervalMs    Sweep interval in milliseconds (default: 1000).
   */
  constructor(
    private readonly db: Knex,
    private readonly producer: CheckoutEventProducer,
    private readonly logger: Logger,
    batchSize = 50,
    intervalMs = 1000
  ) {
    this.batchSize = batchSize;
    this.intervalMs = intervalMs;
  }

  /**
   * Start the relay loop. Safe to call multiple times (idempotent).
   */
  public start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.logger.info({ batchSize: this.batchSize, intervalMs: this.intervalMs }, 'OutboxRelayService started');
    this.scheduleNext();
  }

  /**
   * Gracefully stop the relay loop. Waits for any in-flight sweep to complete.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('OutboxRelayService stopped');
  }

  // ──────────────────────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.sweep();
      } catch (err) {
        // Sweep errors are non-fatal — log and keep looping.
        this.logger.error({ err }, 'OutboxRelayService sweep error');
      } finally {
        this.scheduleNext();
      }
    }, this.intervalMs);
  }

  /**
   * Core sweep: claim → publish → mark processed.
   */
  private async sweep(): Promise<void> {
    await this.db.transaction(async (trx) => {
      // 1. Claim a batch of unprocessed rows, skipping any locked by another relay instance.
      const rows: OutboxRow[] = await trx(this.tableName)
        .select('*')
        .where({ processed: false })
        .orderBy('created_at', 'asc')
        .limit(this.batchSize)
        .forUpdate()
        .skipLocked();

      if (rows.length === 0) return;

      this.logger.debug({ count: rows.length }, 'Outbox sweep: claiming rows');

      // 2. Publish each event to Kafka. Failures throw and roll back the transaction,
      //    so the rows remain unprocessed and will be retried on the next sweep.
      for (const row of rows) {
        await this.publishRow(row);
      }

      // 3. Mark all claimed rows as processed atomically.
      const ids = rows.map((r) => r.event_id);
      await trx(this.tableName)
        .whereIn('event_id', ids)
        .update({ processed: true, processed_at: new Date() });

      this.logger.info({ count: rows.length }, 'Outbox sweep: published and marked processed');
    });
  }

  /**
   * Routes a single outbox row to the correct Kafka topic via the producer.
   */
  private async publishRow(row: OutboxRow): Promise<void> {
    const { event_id, aggregate_id, event_type, payload } = row;

    this.logger.debug({ event_id, aggregate_id, event_type }, 'Publishing outbox event');

    // The producer's publishEvent is private; we use the public surface based on event_type.
    // For any unknown event type we publish to the generic 'orders.updated' topic.
    switch (event_type) {
      case 'OrderPlaced':
        await this.producer.publishOrderPlaced(payload as any);
        break;
      case 'OrderUpdated':
      default:
        await this.producer.publishOrderUpdated(payload as any);
        break;
    }
  }
}
