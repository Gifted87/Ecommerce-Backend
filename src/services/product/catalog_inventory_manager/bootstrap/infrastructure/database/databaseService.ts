import knex, { Knex } from 'knex';
import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { z } from 'zod';

/**
 * Database configuration schema for runtime validation.
 * Ensures strict adherence to environment variables.
 */
export const DbConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  user: z.string().min(1),
  password: z.string().min(1),
  database: z.string().min(1),
  maxPoolSize: z.coerce.number().int().positive().default(50),
  minPoolSize: z.coerce.number().int().nonnegative().default(5),
  idleTimeoutMillis: z.coerce.number().int().positive().default(30000),
  connectionTimeoutMillis: z.coerce.number().int().positive().default(5000),
  statementTimeout: z.coerce.number().int().positive().default(10000),
});

export type DatabaseConfig = z.infer<typeof DbConfigSchema>;

/**
 * DatabaseService implements a robust, singleton-patterned service for
 * managing PostgreSQL connectivity via Knex.js.
 */
export class DatabaseService {
  private static instance: DatabaseService;
  private readonly knexInstance: Knex;
  private readonly breaker: CircuitBreaker<[() => Promise<any>], any>;
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

    this.breaker = new CircuitBreaker(async (work: () => Promise<any>) => await work(), {
      timeout: config.statementTimeout,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    this.setupMonitoring();
    this.setupLifecycle();
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

  private setupLifecycle(): void {
    const shutdown = async () => {
      this.logger.info('Shutting down DatabaseService...');
      await this.knexInstance.destroy();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
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
        
        // PostgreSql error code 40P01 is deadlock_detected
        if (error?.code === '40P01' && attempt < retries) {
          const delay = Math.pow(2, attempt) * 100 + Math.random() * 50; // Exponential backoff + jitter
          this.logger.warn({ attempt, delay, error: this.scrubError(error) }, 'Deadlock detected, retrying transaction');
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        
        this.logger.error({ error: this.scrubError(error), attempt }, 'Transaction failed permanently');
        throw error;
      }
    }
    throw new Error('Transaction failed after maximum retry attempts');
  }

  /**
   * Performs a Liveness/Readiness health check.
   */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.knexInstance.raw('SELECT 1');
      return true;
    } catch (error) {
      this.logger.error({ error: this.scrubError(error) }, 'Database health check failed');
      return false;
    }
  }

  /**
   * Scrubs PII from error objects to ensure compliance.
   */
  private scrubError(error: any): any {
    if (!error) return error;
    const scrubbed = { ...error };
    // Remove potential sensitive connection details
    delete scrubbed.password;
    delete scrubbed.user;
    if (scrubbed.message && typeof scrubbed.message === 'string') {
        scrubbed.message = scrubbed.message.replace(/password=\S+/g, 'password=***');
    }
    return scrubbed;
  }
}
