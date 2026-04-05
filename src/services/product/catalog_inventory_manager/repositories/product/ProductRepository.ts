import { Knex } from 'knex';
import { Logger } from 'pino';
import { DatabaseRepository, RepositoryError } from '../base/DatabaseRepository';
import { Product, ProductSchema } from '../../domain/Product';
import { z } from 'zod';

/**
 * ProductRepository handles persistence and retrieval of Product catalog data.
 * Adheres to ACID principles and ensures high-concurrency safety using row locks.
 */
export class ProductRepository extends DatabaseRepository<Product, string> {
  constructor(db: Knex, log: Logger) {
    super(db, log, 'products');
  }

  /**
   * Retrieves a product by its unique identifier.
   */
  public async getById(id: string): Promise<Product | null> {
    return await this.findById(id, ProductSchema);
  }

  /**
   * Retrieves a product by its SKU.
   */
  public async getBySku(sku: string): Promise<Product | null> {
    return await this.breaker.fire(async () => {
      const start = Date.now();
      try {
        const result = await this.knex(this.tableName)
          .where({ sku })
          .whereNull('deleted_at')
          .first();
        
        if (!result) return null;
        const parsed = ProductSchema.parse(result);
        this.logger.debug({ duration: Date.now() - start, sku }, 'Product found by SKU');
        return parsed;
      } catch (error) {
        this.logger.error({ error, sku }, 'Query by SKU failed');
        throw new RepositoryError('Failed to query by SKU', 'DB_QUERY_ERROR', error);
      }
    });
  }

  /**
   * Creates a new product entry in the catalog.
   */
  public async createProduct(data: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Promise<Product> {
    const validatedData = ProductSchema.omit({ id: true, created_at: true, updated_at: true }).parse(data);
    return await this.create(validatedData, ProductSchema);
  }

  /**
   * Updates an existing product with strict validation.
   */
  public async updateProduct(id: string, data: Partial<Product>): Promise<Product> {
    const validatedData = ProductSchema.partial().parse(data);
    return await this.update(id, validatedData, ProductSchema);
  }

  /**
   * Performs an atomic inventory update linked to product status changes.
   * Utilizes SELECT FOR UPDATE to ensure isolation.
   */
  public async updateInventoryAtomic(productId: string, stockChange: number): Promise<void> {
    await this.transaction(async (trx) => {
      try {
        // Explicitly lock the product row for update to ensure atomicity
        const product = await trx(this.tableName)
          .where({ id: productId })
          .forUpdate()
          .first();

        if (!product) {
          throw new RepositoryError('Product not found for inventory update', 'NOT_FOUND');
        }

        // Apply inventory update
        const affectedRows = await trx('inventory')
          .where({ product_id: productId })
          .increment('total_stock', stockChange);
        
        if (affectedRows === 0) {
            throw new RepositoryError('Inventory record not found', 'NOT_FOUND');
        }

        this.logger.info({ productId, stockChange }, 'Atomic inventory update successful');
      } catch (error: any) {
        this.logger.error({ error, productId }, 'Atomic inventory update failed');
        throw error;
      }
    });
  }

  /**
   * Performs a soft delete of a product.
   */
  public async softDelete(id: string): Promise<void> {
    return await this.breaker.fire(async () => {
      const start = Date.now();
      try {
        const affected = await this.knex(this.tableName)
          .where({ id })
          .update({ deleted_at: new Date() });
          
        if (affected === 0) {
            throw new RepositoryError('Product not found for deletion', 'NOT_FOUND');
        }
        
        this.logger.debug({ duration: Date.now() - start, id }, 'Product soft-deleted');
      } catch (error) {
        this.logger.error({ error, id }, 'Soft-delete failed');
        throw new RepositoryError('Failed to soft-delete product', 'DB_DELETE_ERROR', error);
      }
    });
  }

  /**
   * Paginated list retrieval for catalog browsing.
   */
  public async listProducts(limit: number = 20, offset: number = 0): Promise<Product[]> {
    return await this.breaker.fire(async () => {
      const start = Date.now();
      try {
        const results = await this.knex(this.tableName)
          .select('*')
          .whereNull('deleted_at')
          .limit(limit)
          .offset(offset)
          .orderBy('created_at', 'desc');
        
        const parsed = z.array(ProductSchema).parse(results);
        this.logger.debug({ duration: Date.now() - start, limit, offset }, 'Products listed');
        return parsed;
      } catch (error) {
        this.logger.error({ error, limit, offset }, 'List products failed');
        throw new RepositoryError('Failed to list products', 'DB_QUERY_ERROR', error);
      }
    });
  }
}
