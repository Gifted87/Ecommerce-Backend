import knex, { Knex } from 'knex';
import { Logger } from 'pino';
import Opossum = require('opossum');
import { z } from 'zod';

/**
 * Database configuration schema for runtime validation.
 */
const DbConfigSchema = z.object({
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

/**
 * Singleton database service providing Knex query builder,
 * transaction management, circuit breaking, and health monitoring.
 */
export class DatabaseService {
  private static instance: DatabaseService;
  private knexInstance: Knex;
  // Use any to bypass TS namespace issue
  private breaker: any;
  private logger: Logger;

  private constructor(config: z.infer<typeof DbConfigSchema>, logger: Logger) {
    this.logger = logger.child({ module: 'infrastructure/database' });

    this.knexInstance = knex({
      client: 'pg',
      connection: {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
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

    // Configure circuit breaker for database operations
    this.breaker = new Opossum(
      async (queryFn: () => Promise<any>) => await queryFn(),
      {
        timeout: config.statementTimeout,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

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
   * Executes a transactional block with automatic retry logic for transient deadlock errors.
   */
  public async runTransaction<T>(
    work: (trx: Knex.Transaction) => Promise<T>,
    retries = 3
  ): Promise<T> {
    let attempt = 0;
    while (attempt < retries) {
      try {
        return await this.breaker.fire(() => this.knexInstance.transaction(work));
      } catch (error: any) {
        attempt++;
        // PostgreSql error code 40P01 is deadlock_detected
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
   * Checks database connectivity.
   */
  public async healthCheck(): Promise<{ status: 'up' | 'down'; message?: string }> {
    try {
      await this.knexInstance.raw('SELECT 1');
      return { status: 'up' };
    } catch (error) {
      this.logger.error({ error }, 'Database health check failed');
      return { status: 'down', message: (error as Error).message };
    }
  }

  /**
   * Exports metrics from the connection pool.
   */
  public getMetrics() {
    const pool = (this.knexInstance.client as any).pool;
    return {
      active: pool.numUsed(),
      idle: pool.numFree(),
      pending: pool.numPendingAcquires(),
    };
  }

  /**
   * Graceful shutdown of the database pool.
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down database connection pool');
    await this.knexInstance.destroy();
  }
}
