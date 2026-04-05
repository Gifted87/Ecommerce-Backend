import { Knex } from 'knex';
import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { z } from 'zod';

/**
 * Domain-specific exceptions for Inventory business logic.
 */
export class InventoryNotFoundError extends Error {
  constructor(public productId: string) {
    super(`Inventory record not found for product: ${productId}`);
    this.name = 'InventoryNotFoundError';
  }
}

export class InsufficientStockError extends Error {
  constructor(public productId: string, public available: number, public requested: number) {
    super(`Insufficient stock for product ${productId}. Available: ${available}, Requested: ${requested}`);
    this.name = 'InsufficientStockError';
  }
}

export class RepositoryConcurrencyError extends Error {
  constructor(message: string, public originalError?: any) {
    super(message);
    this.name = 'RepositoryConcurrencyError';
  }
}

export class RepositorySystemError extends Error {
  constructor(message: string, public originalError?: any) {
    super(message);
    this.name = 'RepositorySystemError';
  }
}

/**
 * Inventory schema for data validation.
 */
export const InventorySchema = z.object({
  product_id: z.string().uuid(),
  total_stock: z.number().int().min(0),
  reserved_stock: z.number().int().min(0),
  updated_at: z.date(),
});

export type Inventory = z.infer<typeof InventorySchema>;

/**
 * Production-ready repository for atomic inventory management.
 */
export class InventoryRepository {
  private readonly tableName = 'inventory';
  private readonly breaker: CircuitBreaker<[() => Promise<any>], any>;

  constructor(
    private readonly knex: Knex,
    private readonly logger: Logger
  ) {
    this.logger = this.logger.child({ module: 'repository/inventory' });

    this.breaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    this.setupCircuitBreakerMonitoring();
  }

  private setupCircuitBreakerMonitoring(): void {
    this.breaker.on('open', () => this.logger.error('InventoryRepository: Circuit breaker opened.'));
    this.breaker.on('halfOpen', () => this.logger.warn('InventoryRepository: Circuit breaker half-open.'));
    this.breaker.on('close', () => this.logger.info('InventoryRepository: Circuit breaker closed.'));
  }

  /**
   * Retrieves inventory for a given product with circuit breaker protection.
   */
  public async getInventory(productId: string): Promise<Inventory> {
    return await this.breaker.fire(async () => {
      const row = await this.knex(this.tableName).where({ product_id: productId }).first();
      if (!row) throw new InventoryNotFoundError(productId);
      return InventorySchema.parse(row);
    });
  }

  /**
   * Performs an atomic stock mutation using SELECT FOR UPDATE row locking.
   * Includes exponential backoff for deadlock handling.
   */
  public async updateStock(
    productId: string,
    adjustment: number,
    correlationId: string
  ): Promise<Inventory> {
    const start = performance.now();
    let attempt = 0;
    const maxRetries = 3;

    while (attempt < maxRetries) {
      try {
        return await this.breaker.fire(async () => {
          return await this.knex.transaction(async (trx) => {
            const row = await trx(this.tableName)
              .select('*')
              .where({ product_id: productId })
              .forUpdate()
              .first();

            if (!row) throw new InventoryNotFoundError(productId);

            const current = InventorySchema.parse(row);
            const nextTotal = current.total_stock + adjustment;

            if (nextTotal < 0) {
              throw new InsufficientStockError(productId, current.total_stock, Math.abs(adjustment));
            }

            const [updated] = await trx(this.tableName)
              .where({ product_id: productId })
              .update({
                total_stock: nextTotal,
                updated_at: new Date(),
              })
              .returning('*');

            const result = InventorySchema.parse(updated);
            
            this.logger.info({
              operation: 'UPDATE_STOCK',
              productId,
              adjustment,
              correlationId,
              duration: performance.now() - start,
              finalStock: result.total_stock
            }, 'Stock updated successfully');

            return result;
          });
        });
      } catch (error: any) {
        attempt++;
        
        // Handle PostgreSQL deadlock (40P01)
        if (error?.code === '40P01') {
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 100;
            this.logger.warn({ attempt, productId, error: error.message }, 'Deadlock detected, retrying');
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new RepositoryConcurrencyError('Deadlock limit exceeded', error);
        }

        if (error instanceof InventoryNotFoundError || error instanceof InsufficientStockError) {
          throw error;
        }

        this.logger.error({ error, productId, correlationId }, 'Unexpected repository failure');
        throw new RepositorySystemError('Internal database error', error);
      }
    }
    throw new RepositorySystemError('Transaction failed after retries');
  }

  /**
   * Performs a system health check.
   */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.knex.raw('SELECT 1');
      return true;
    } catch (error) {
      this.logger.error({ error }, 'Database health check failed');
      return false;
    }
  }
}
