import { Knex } from 'knex';

/**
 * Migration: Create outbox_events table for the Transactional Outbox Pattern.
 *
 * The OutboxRelayService sweeps this table, publishes each row's payload to Kafka,
 * and marks it processed — all atomically decoupled from the original order transaction.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('outbox_events', (table) => {
    table.uuid('event_id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('aggregate_id').notNullable();
    table.string('aggregate_type').notNullable();
    table.string('event_type').notNullable();
    table.jsonb('payload').notNullable();
    table.boolean('processed').notNullable().defaultTo(false);
    table.timestamp('processed_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Partial index: only unprocessed rows are ever queried by the relay sweeper.
  await knex.raw(
    `CREATE INDEX outbox_events_unprocessed_idx ON outbox_events (created_at ASC) WHERE processed = false`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('outbox_events');
}
