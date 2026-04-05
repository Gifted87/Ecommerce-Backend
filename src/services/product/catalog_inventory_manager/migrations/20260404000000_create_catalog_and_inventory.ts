import { Knex } from 'knex';

/**
 * Migration: Create Catalog and Inventory
 * 
 * Sets up the product catalog and real-time inventory tracking system.
 * Implements strict ACID constraints and ensures domain integrity at the database level.
 */

export async function up(knex: Knex): Promise<void> {
  // Create products table
  await knex.schema.createTable('products', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('sku').notNullable().unique();
    table.string('name').notNullable();
    table.decimal('price', 14, 2).notNullable();
    table.jsonb('metadata').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    // Constraint for SKU format validation [A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+
    table.check('sku ~* \'^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$\'', [], 'products_sku_format_check');
  });

  // Create B-tree index on SKU for fast lookups
  await knex.raw('CREATE INDEX products_sku_index ON products (sku)');

  // Create inventory table
  await knex.schema.createTable('inventory', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('product_id').notNullable().references('id').inTable('products').unique();
    table.integer('total_stock').notNullable();
    table.integer('reserved_stock').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    // ACID Integrity constraints
    table.check('total_stock >= 0', [], 'inventory_total_stock_nonnegative_check');
    table.check('reserved_stock >= 0', [], 'inventory_reserved_stock_nonnegative_check');
    table.check('total_stock >= reserved_stock', [], 'inventory_stock_logical_integrity_check');
  });

  // Create B-tree index on product_id for fast joins
  await knex.raw('CREATE INDEX inventory_product_id_index ON inventory (product_id)');
}

export async function down(knex: Knex): Promise<void> {
  // Drop tables in reverse order of creation
  await knex.schema.dropTableIfExists('inventory');
  await knex.schema.dropTableIfExists('products');
}
