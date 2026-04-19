import { Knex } from 'knex';

/**
 * Migration: Create Users Table
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.uuid('user_id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email').notNullable().unique();
    table.string('password_hash').notNullable();
    table.string('first_name').notNullable();
    table.string('last_name').notNullable();
    table.jsonb('roles').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.boolean('mfa_enabled').notNullable().defaultTo(false);
    table.text('mfa_secret').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX users_email_index ON users (email)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
