import knex, { Knex } from 'knex';
import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { ZodSchema } from 'zod';

/**
 * Domain-specific exception for database-related errors.
 */
export class RepositoryError extends Error {
  constructor(public message: string, public code: string, public originalError?: any) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/**
 * Interface for database transaction provider.
 */
export interface IUnitOfWork {
  transaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>;
}

/**
 * Base Repository providing standard CRUD operations and transaction support.
 */
export abstract class DatabaseRepository<T, ID> implements IUnitOfWork {
  protected readonly knex: Knex;
  protected readonly logger: Logger;
  protected readonly breaker: CircuitBreaker;

  constructor(protected readonly db: Knex, protected readonly log: Logger, protected readonly tableName: string) {
    this.knex = db;
    this.logger = log.child({ module: 'repository', table: tableName });

    this.breaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  /**
   * Executes a transactional block.
   */
  public async transaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.knex.transaction(async (trx) => {
      try {
        return await work(trx);
      } catch (error) {
        this.logger.error({ error }, 'Transaction failed, rolling back');
        throw error;
      }
    });
  }

  protected async findById(id: ID, schema: ZodSchema): Promise<T | null> {
    return await this.breaker.fire(async () => {
      const start = Date.now();
      try {
        const result = await this.knex(this.tableName).where({ id }).first();
        if (!result) return null;
        const parsed = schema.parse(result);
        this.logger.debug({ duration: Date.now() - start, id }, 'Entity found');
        return parsed as T;
      } catch (error) {
        this.logger.error({ error, id }, 'Database query failed');
        throw new RepositoryError('Query execution failed', 'DB_QUERY_ERROR', error);
      }
    });
  }

  protected async create(data: Partial<T>, schema: ZodSchema): Promise<T> {
    return await this.breaker.fire(async () => {
      const start = Date.now();
      try {
        const [result] = await this.knex(this.tableName).insert(data).returning('*');
        const parsed = schema.parse(result);
        this.logger.debug({ duration: Date.now() - start }, 'Entity created');
        return parsed as T;
      } catch (error) {
        this.logger.error({ error, data }, 'Create operation failed');
        throw new RepositoryError('Create operation failed', 'DB_INSERT_ERROR', error);
      }
    });
  }

  protected async update(id: ID, data: Partial<T>, schema: ZodSchema): Promise<T> {
    return await this.breaker.fire(async () => {
      const start = Date.now();
      try {
        const [result] = await this.knex(this.tableName).where({ id }).update(data).returning('*');
        if (!result) throw new RepositoryError('Entity not found', 'NOT_FOUND');
        const parsed = schema.parse(result);
        this.logger.debug({ duration: Date.now() - start, id }, 'Entity updated');
        return parsed as T;
      } catch (error) {
        this.logger.error({ error, id }, 'Update operation failed');
        throw new RepositoryError('Update operation failed', 'DB_UPDATE_ERROR', error);
      }
    });
  }

  protected async delete(id: ID): Promise<void> {
    return await this.breaker.fire(async () => {
      const start = Date.now();
      try {
        await this.knex(this.tableName).where({ id }).del();
        this.logger.debug({ duration: Date.now() - start, id }, 'Entity deleted');
      } catch (error) {
        this.logger.error({ error, id }, 'Delete operation failed');
        throw new RepositoryError('Delete operation failed', 'DB_DELETE_ERROR', error);
      }
    });
  }
}
