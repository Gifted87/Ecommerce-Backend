import { Knex } from 'knex';
import { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { Inventory, InventorySchema, validateInventoryMutation } from '../../domain/schemas';

/**
 * Custom error class for inventory domain failures.
 */
export class InsufficientStockError extends Error {
  constructor(public message: string, public productId: string) {
    super(message);
    this.name = 'InsufficientStockError';
  }
}

/**
 * Custom error class for repository database operations.
 */
export class InventoryRepositoryError extends Error {
  constructor(public message: string, public code: string, public originalError?: any) {
    super(message);
    this.name = 'InventoryRepositoryError';
  }
}

/**
 * Repository for managing product inventory levels with ACID compliance,
 * row-level locking, and circuit breaker resilience.
 */
export class InventoryRepository {
  private readonly tableName = 'inventory';
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly knex: Knex,
    private readonly logger: Logger
  ) {
    this.logger = this.logger.child({ module: 'repository/inventory' });

    // Circuit breaker configuration per mandate
    this.breaker = new CircuitBreaker(async (fn: () => Promise<any>) => await fn(), {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    this.breaker.on('open', () => this.logger.error('InventoryRepository: Circuit breaker opened.'));
    this.breaker.on('close', () => this.logger.info('InventoryRepository: Circuit breaker closed.'));
  }

  /**
   * Retrieves current inventory for a given product.
   */
  public async getInventory(productId: string): Promise<Inventory | null> {
    const start = Date.now();
    try {
      return await this.breaker.fire(async () => {
        const row = await this.knex(this.tableName)
          .where({ product_id: productId })
          .first();

        if (!row) return null;
        return InventorySchema.parse(row);
      });
    } catch (error) {
      this.logger.error({ error, productId, duration: Date.now() - start }, 'Failed to fetch inventory');
      throw new InventoryRepositoryError('Failed to fetch inventory', 'FETCH_ERROR', error);
    }
  }

  /**
   * Executes a transactional stock mutation with deadlock handling.
   */
  private async executeWithTransaction<T>(
    productId: string,
    work: (trx: Knex.Transaction, current: Inventory) => Promise<T>,
    retries = 3
  ): Promise<T> {
    let attempt = 0;
    while (attempt < retries) {
      try {
        return await this.knex.transaction(async (trx) => {
          // Select for update to lock the row
          const row = await trx(this.tableName)
            .select('*')
            .where({ product_id: productId })
            .forUpdate()
            .first();

          if (!row) {
            throw new InventoryRepositoryError('Product inventory not found', 'NOT_FOUND');
          }

          const current = InventorySchema.parse(row);
          return await work(trx, current);
        });
      } catch (error: any) {
        attempt++;
        // PostgreSql error code 40P01 is deadlock_detected
        if (error?.code === '40P01' && attempt < retries) {
          const delay = Math.pow(2, attempt) * 100;
          this.logger.warn({ attempt, delay, productId, error }, 'Deadlock detected, retrying transaction');
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw new InventoryRepositoryError('Transaction failed after maximum retries', 'DEADLOCK_LIMIT_EXCEEDED');
  }

  /**
   * Reserves stock for a product.
   */
  public async reserveStock(productId: string, amount: number): Promise<Inventory> {
    const start = Date.now();
    try {
      return await this.breaker.fire(() =>
        this.executeWithTransaction(productId, async (trx, current) => {
          const mutation = validateInventoryMutation(current, 0, amount);
          if (!mutation.success) {
            throw new InsufficientStockError(mutation.error || 'Invalid mutation', productId);
          }

          await trx(this.tableName)
            .where({ product_id: productId })
            .update({ reserved_stock: mutation.data!.reserved_stock });

          return mutation.data!;
        })
      );
    } catch (error) {
      this.logger.error({ error, productId, amount, duration: Date.now() - start }, 'Failed to reserve stock');
      throw error;
    }
  }

  /**
   * Releases previously reserved stock.
   */
  public async releaseStock(productId: string, amount: number): Promise<Inventory> {
    const start = Date.now();
    try {
      return await this.breaker.fire(() =>
        this.executeWithTransaction(productId, async (trx, current) => {
          const mutation = validateInventoryMutation(current, 0, -amount);
          if (!mutation.success) {
            throw new InsufficientStockError(mutation.error || 'Invalid mutation', productId);
          }

          await trx(this.tableName)
            .where({ product_id: productId })
            .update({ reserved_stock: mutation.data!.reserved_stock });

          return mutation.data!;
        })
      );
    } catch (error) {
      this.logger.error({ error, productId, amount, duration: Date.now() - start }, 'Failed to release stock');
      throw error;
    }
  }

  /**
   * Updates total stock (e.g., adding stock replenishment).
   */
  public async updateStock(productId: string, totalChange: number): Promise<Inventory> {
    const start = Date.now();
    try {
      return await this.breaker.fire(() =>
        this.executeWithTransaction(productId, async (trx, current) => {
          const mutation = validateInventoryMutation(current, totalChange, 0);
          if (!mutation.success) {
            throw new InsufficientStockError(mutation.error || 'Invalid mutation', productId);
          }

          await trx(this.tableName)
            .where({ product_id: productId })
            .update({ total_stock: mutation.data!.total_stock });

          return mutation.data!;
        })
      );
    } catch (error) {
      this.logger.error({ error, productId, totalChange, duration: Date.now() - start }, 'Failed to update total stock');
      throw error;
    }
  }
}
