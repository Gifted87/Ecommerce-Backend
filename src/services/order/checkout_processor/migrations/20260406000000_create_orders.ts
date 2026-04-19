import { Knex } from 'knex';

/**
 * Migration: Create Orders Table
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('orders', (table) => {
    table.uuid('order_id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('user_id').inTable('users');
    table.string('status').notNullable();
    table.jsonb('items').notNullable();
    table.jsonb('shipping_address').notNullable();
    table.string('total_amount').notNullable();
    table.integer('version').notNullable().defaultTo(0);
    table.uuid('correlation_id').nullable();
    table.string('tracking_number').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX orders_user_id_index ON orders (user_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('orders');
}
