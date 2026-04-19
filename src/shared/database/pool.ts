import { Pool, PoolClient, QueryResult, QueryConfig, PoolConfig, QueryResultRow } from 'pg';
import { Logger } from 'winston';
import * as winston from 'winston';

/**
 * Configuration interface for database connection settings.
 */
export interface DatabaseConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeout: number;
  ssl: boolean | { rejectUnauthorized: boolean };
}

/**
 * DatabasePool provides a singleton-like managed interface for PostgreSQL connections.
 * It integrates with Winston for telemetry and implements robust lifecycle management.
 */
export class DatabasePool {
  private pool: Pool;
  private logger: Logger;

  /**
   * Initializes the PostgreSQL connection pool.
   * @param config Database configuration settings.
   * @param logger Winston logger instance for telemetry.
   */
  constructor(config: DatabaseConfig, logger: Logger) {
    this.logger = logger;
    
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.max,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      statement_timeout: config.statementTimeout,
      ssl: config.ssl
    };

    this.pool = new Pool(poolConfig);

    this.setupEventListeners();
  }

  /**
   * Sets up event listeners on the pool for operational visibility and fault tolerance.
   */
  private setupEventListeners(): void {
    this.pool.on('error', (err: Error, client: PoolClient) => {
      this.logger.error('Unexpected error on idle client', { error: err.message, stack: err.stack });
    });

    this.pool.on('connect', () => {
      this.logger.info('New client connected to the database pool');
    });

    this.pool.on('acquire', (client: PoolClient) => {
      this.logger.debug('Client acquired from pool');
    });

    this.pool.on('remove', () => {
      this.logger.debug('Client removed from pool');
    });
  }

  /**
   * Executes a database query with performance monitoring.
   * @param queryText The SQL query string or QueryConfig object.
   * @param values Query parameters.
   * @returns Promise resolving to the QueryResult.
   */
  public async query<T extends QueryResultRow = any>(queryText: string | QueryConfig, values?: any[]): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const res = await this.pool.query(queryText, values);
      const duration = Date.now() - start;
      this.logger.debug('Query executed successfully', { duration, sql: typeof queryText === 'string' ? queryText : queryText.text });
      return res;
    } catch (err: any) {
      this.logger.error('Database query error', { error: err.message, sql: typeof queryText === 'string' ? queryText : queryText.text });
      throw err;
    }
  }

  /**
   * Returns a dedicated client from the pool to support transactional integrity.
   * The caller is responsible for calling client.release().
   * @returns Promise resolving to a PoolClient.
   */
  public async getTransaction(): Promise<PoolClient> {
    const client = await this.pool.connect();
    return client;
  }

  /**
   * Returns current pool metrics for observability and capacity planning.
   */
  public getMetrics() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount
    };
  }

  /**
   * Gracefully shuts down the database pool.
   * Ensures all active queries are drained or timed out.
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down database connection pool...');
    await this.pool.end();
    this.logger.info('Database connection pool closed.');
  }
}
