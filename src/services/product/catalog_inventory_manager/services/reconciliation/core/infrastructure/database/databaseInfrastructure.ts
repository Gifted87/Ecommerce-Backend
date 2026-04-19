import knex, { Knex } from 'knex';
import { Logger } from 'pino';
import Opossum = require('opossum');
import { z } from 'zod';

/**
 * Database configuration schema for runtime validation ensuring
 * strict environment variable adherence.
 */
export const DbConfigSchema = z.object({
  host: z.string(),
  port: z.coerce.number(),
  user: z.string(),
  password: z.string(),
  database: z.string(),
  maxPoolSize: z.coerce.number().default(20),
  minPoolSize: z.coerce.number().default(2),
  idleTimeoutMillis: z.coerce.number().default(30000),
  connectionTimeoutMillis: z.coerce.number().default(5000),
  statementTimeout: z.coerce.number().default(10000),
});

export type DatabaseConfig = z.infer<typeof DbConfigSchema>;

/**
 * DatabaseService provides a robust, singleton-based interface for PostgreSQL
 * interactions using Knex.js, featuring ACID-compliant transactions,
 * exponential backoff, and Opossum circuit breaking.
 */
export class DatabaseService {
  private static instance: DatabaseService;
  private readonly knexInstance: Knex;
  // Use any to bypass TS namespace issue
  private readonly breaker: any;
  private readonly logger: Logger;

  private constructor(config: DatabaseConfig, logger: Logger) {
    this.logger = logger.child({ module: 'infrastructure/database' });

    this.knexInstance = knex({
      client: 'pg',
      connection: {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: { rejectUnauthorized: true },
      },
      pool: {
        min: config.minPoolSize,
        max: config.maxPoolSize,
        idleTimeoutMillis: config.idleTimeoutMillis,
        createTimeoutMillis: config.connectionTimeoutMillis,
      },
      acquireConnectionTimeout: config.connectionTimeoutMillis,
      debug: false,
    });

    this.breaker = new Opossum(async (work: () => Promise<any>) => await work(), {
      timeout: config.statementTimeout,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    this.setupMonitoring();
  }

  public static initialize(config: unknown, logger: Logger): DatabaseService {
    const validated = DbConfigSchema.parse(config);
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService(validated, logger);
    }
    return DatabaseService.instance;
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      throw new Error('DatabaseService must be initialized before use.');
    }
    return DatabaseService.instance;
  }

  private setupMonitoring(): void {
    this.breaker.on('open', () => this.logger.error('Database circuit breaker: OPEN'));
    this.breaker.on('halfOpen', () => this.logger.warn('Database circuit breaker: HALF-OPEN'));
    this.breaker.on('close', () => this.logger.info('Database circuit breaker: CLOSED'));
  }

  public get knex(): Knex {
    return this.knexInstance;
  }

  /**
   * Executes a transactional block with automatic retry logic for transient deadlock errors (40P01).
   * Ensures serializable transaction isolation.
   */
  public async runTransaction<T>(
    work: (trx: Knex.Transaction) => Promise<T>,
    retries = 3
  ): Promise<T> {
    let attempt = 0;
    while (attempt < retries) {
      try {
        return await this.breaker.fire(async () => {
          return await this.knexInstance.transaction(async (trx) => {
            await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            return await work(trx);
          });
        });
      } catch (error: any) {
        attempt++;
        if (error?.code === '40P01' && attempt < retries) {
          const delay = Math.pow(2, attempt) * 100;
          this.logger.warn({ attempt, delay, error }, 'Deadlock detected, retrying transaction');
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        this.logger.error({ error, attempt }, 'Transaction failed permanently');
        throw error;
      }
    }
    throw new Error('Transaction failed after maximum retry attempts');
  }

  /**
   * Performs a health check on the database connection pool.
   */
  public async healthCheck(): Promise<{ status: 'up' | 'down'; message?: string }> {
    try {
      await this.knexInstance.raw('SELECT 1');
      return { status: 'up' };
    } catch (error: any) {
      this.logger.error({ error }, 'Database health check failed');
      return { status: 'down', message: error.message };
    }
  }

  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down database connection pool');
    await this.knexInstance.destroy();
  }
}
