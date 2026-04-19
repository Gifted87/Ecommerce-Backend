"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductRepository = void 0;
const DatabaseRepository_1 = require("../base/DatabaseRepository");
const domain_1 = require("../../schemas/domain");
const zod_1 = require("zod");
/**
 * ProductRepository handles persistence and retrieval of Product catalog data.
 * Adheres to ACID principles and ensures high-concurrency safety using row locks.
 */
class ProductRepository extends DatabaseRepository_1.DatabaseRepository {
    constructor(db, log) {
        super(db, log, 'products');
    }
    /**
     * Retrieves a product by its unique identifier.
     */
    async getById(id) {
        return await this.findById(id, domain_1.ProductSchema);
    }
    /**
     * Retrieves a product by its SKU.
     */
    async getBySku(sku) {
        return await this.breaker.fire(async () => {
            const start = Date.now();
            try {
                const result = await this.knex(this.tableName)
                    .where({ sku })
                    .whereNull('deleted_at')
                    .first();
                if (!result)
                    return null;
                const parsed = domain_1.ProductSchema.parse(result);
                this.logger.debug({ duration: Date.now() - start, sku }, 'Product found by SKU');
                return parsed;
            }
            catch (error) {
                this.logger.error({ error, sku }, 'Query by SKU failed');
                throw new DatabaseRepository_1.RepositoryError('Failed to query by SKU', 'DB_QUERY_ERROR', error);
            }
        });
    }
    /**
     * Creates a new product entry in the catalog.
     */
    async createProduct(data) {
        const validatedData = domain_1.ProductSchema.omit({ id: true, created_at: true, updated_at: true }).parse(data);
        return await this.create(validatedData, domain_1.ProductSchema);
    }
    /**
     * Updates an existing product with strict validation.
     */
    async updateProduct(id, data) {
        const validatedData = domain_1.ProductSchema.partial().parse(data);
        return await this.update(id, validatedData, domain_1.ProductSchema);
    }
    /**
     * Performs an atomic inventory update linked to product status changes.
     * Utilizes SELECT FOR UPDATE to ensure isolation.
     */
    async updateInventoryAtomic(productId, stockChange) {
        await this.transaction(async (trx) => {
            try {
                // Explicitly lock the product row for update to ensure atomicity
                const product = await trx(this.tableName)
                    .where({ id: productId })
                    .forUpdate()
                    .first();
                if (!product) {
                    throw new DatabaseRepository_1.RepositoryError('Product not found for inventory update', 'NOT_FOUND');
                }
                // Apply inventory update
                const affectedRows = await trx('inventory')
                    .where({ product_id: productId })
                    .increment('total_stock', stockChange);
                if (affectedRows === 0) {
                    throw new DatabaseRepository_1.RepositoryError('Inventory record not found', 'NOT_FOUND');
                }
                this.logger.info({ productId, stockChange }, 'Atomic inventory update successful');
            }
            catch (error) {
                this.logger.error({ error, productId }, 'Atomic inventory update failed');
                throw error;
            }
        });
    }
    /**
     * Performs a soft delete of a product.
     */
    async softDelete(id) {
        return await this.breaker.fire(async () => {
            const start = Date.now();
            try {
                const affected = await this.knex(this.tableName)
                    .where({ id })
                    .update({ deleted_at: new Date() });
                if (affected === 0) {
                    throw new DatabaseRepository_1.RepositoryError('Product not found for deletion', 'NOT_FOUND');
                }
                this.logger.debug({ duration: Date.now() - start, id }, 'Product soft-deleted');
            }
            catch (error) {
                this.logger.error({ error, id }, 'Soft-delete failed');
                throw new DatabaseRepository_1.RepositoryError('Failed to soft-delete product', 'DB_DELETE_ERROR', error);
            }
        });
    }
    /**
     * Paginated list retrieval for catalog browsing.
     */
    async listProducts(limit = 20, offset = 0) {
        return await this.breaker.fire(async () => {
            const start = Date.now();
            try {
                const results = await this.knex(this.tableName)
                    .select('*')
                    .whereNull('deleted_at')
                    .limit(limit)
                    .offset(offset)
                    .orderBy('created_at', 'desc');
                const parsed = zod_1.z.array(domain_1.ProductSchema).parse(results);
                this.logger.debug({ duration: Date.now() - start, limit, offset }, 'Products listed');
                return parsed;
            }
            catch (error) {
                this.logger.error({ error, limit, offset }, 'List products failed');
                throw new DatabaseRepository_1.RepositoryError('Failed to list products', 'DB_QUERY_ERROR', error);
            }
        });
    }
}
exports.ProductRepository = ProductRepository;
