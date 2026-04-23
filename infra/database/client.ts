/**
 * DEPRECATED — This file has been intentionally disabled.
 *
 * This module previously instantiated a PrismaClient that opened a second PostgreSQL
 * connection pool alongside the canonical Knex pool used by the rest of the application.
 * Two competing pools cause connection exhaustion under load.
 *
 * The entire application uses Knex.js (configured in src/app_bootstrap/composition_root.ts)
 * as its single DB access layer. Do NOT re-introduce Prisma unless you intend to fully
 * migrate all repositories to it and retire Knex.
 *
 * If you need Prisma for schema introspection or migrations in a dev tooling context,
 * keep it strictly out of the application's runtime import graph.
 */
export {};
