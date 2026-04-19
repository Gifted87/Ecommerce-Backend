import { z } from 'zod';
import { Logger } from 'pino';
import Opossum = require('opossum');
import { ProductRepository } from '../../repositories/product/ProductRepository';
import { Redis } from 'ioredis';
import { Product, ProductSchema } from '../../schemas/domain';

/**
 * Domain-specific error class for CatalogService operations.
 * 
 * Provides structured error information including a human-readable message,
 * an error code for programmatic handling, and the original error for debugging.
 */
export class CatalogServiceError extends Error {
  /**
   * @param message - Descriptive error message.
   * @param code - Machine-readable error code.
   * @param originalError - Optional underlying error that caused this failure.
   */
  constructor(public message: string, public code: string, public originalError?: Error) {
    super(message);
    this.name = 'CatalogServiceError';
  }
}

/**
 * CatalogService manages product information retrieval and lifecycle operations.
 * 
 * It implements a robust 'cache-aside' pattern, coordinating between a persistent
 * PostgreSQL store (via ProductRepository) and a high-speed Redis cache.
 * 
 * Key Features:
 * - Resilient data fetching with an integrated Circuit Breaker (Opossum).
 * - Integrity validation of cached data using Zod schemas.
 * - Automatic cache population and invalidation.
 * - Tracing and observability through structured logging and transaction IDs.
 */
export class CatalogService {
  private readonly CACHE_TTL = 3600; // 1 hour
  // Use any to bypass TS namespace issue
  private readonly getProductBreaker: any;

  /**
   * @param repository - The data access layer for products in PostgreSQL.
   * @param cache - The Redis client for high-performance data access.
   * @param logger - The application's pino logger instance.
   */
  constructor(
    private readonly repository: ProductRepository,
    private readonly cache: Redis,
    private readonly logger: Logger
  ) {
    // Circuit breaker configuration: handles timeouts and failure thresholds
    const breakerOptions = {
      timeout: 3000, // 3 seconds
      errorThresholdPercentage: 50,
      resetTimeout: 30000, // 30 seconds
    };

    this.getProductBreaker = new Opossum(this.executeGetProduct.bind(this), breakerOptions);
    this.getProductBreaker.on('open', () => this.logger.error('CatalogService: Circuit breaker opened.'));
    this.getProductBreaker.on('halfOpen', () => this.logger.info('CatalogService: Circuit breaker half-open.'));
    this.getProductBreaker.on('close', () => this.logger.info('CatalogService: Circuit breaker closed.'));
  }

  /**
   * Retrieves a product by its SKU using the cache-aside pattern.
   * 
   * This method first attempts to retrieve the product from the cache. If it misses or
   * the cached data is corrupt, it falls back to the database. Successful database
   * fetches are then cached for future requests.
   * 
   * The operation is wrapped in a circuit breaker to protect the system from
   * cascading failures if the database or cache is performing poorly.
   * 
   * @param sku - The unique stock-keeping unit identifier for the product.
   * @param transactionId - A unique ID used to correlate logs for this specific request.
   * @returns A promise that resolves to the Product model if found, or null otherwise.
   * @throws CatalogServiceError if the fetch operation fails or exceeds timeout.
   */
  public async getProductBySku(sku: string, transactionId: string): Promise<Product | null> {
    const start = Date.now();
    this.logger.info({ sku, transactionId, operation: 'getProductBySku' }, 'Initiating product fetch');

    try {
      return await this.getProductBreaker.fire(sku);
    } catch (err) {
      this.logger.error({ err, sku, transactionId }, 'Failed to retrieve product');
      throw new CatalogServiceError(`Failed to fetch product: ${sku}`, 'FETCH_FAILED', err as Error);
    } finally {
      this.logger.debug({ duration: Date.now() - start, sku, transactionId }, 'Operation completed');
    }
  }

  /**
   * Internal implementation of the product retrieval logic.
   * 
   * @param sku - The product SKU.
   * @returns A promise resolving to the Product or null.
   * @private
   */
  private async executeGetProduct(sku: string): Promise<Product | null> {
    // 1. Try Cache
    try {
      const cached = await this.cache.get(`product:${sku}`);
      if (cached) {
        const validated = ProductSchema.safeParse(JSON.parse(cached));
        if (validated.success) {
          this.logger.info({ sku }, 'Cache hit');
          return validated.data;
        }
        this.logger.warn({ sku }, 'Cache data corruption detected. Invalidate and re-fetch.');
        await this.cache.del(`product:${sku}`);
      }
    } catch (err) {
      this.logger.error({ err, sku }, 'Cache access failed, proceeding to DB');
    }

    // 2. Try DB
    const product = await this.repository.getBySku(sku);
    if (!product) {
      return null;
    }

    // 3. Populate Cache (async fire-and-forget)
    this.cache.set(`product:${sku}`, JSON.stringify(product), 'EX', this.CACHE_TTL).catch((err) =>
      this.logger.error({ err, sku }, 'Failed to update cache after miss')
    );

    return product;
  }

  /**
   * Creates a new product record in the system.
   * 
   * @param data - The product details excluding generated fields like id and timestamps.
   * @returns A promise resolving to the newly created Product.
   * @throws CatalogServiceError if the creation fails.
   */
  public async createProduct(data: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Promise<Product> {
    try {
        return await this.repository.createProduct(data);
    } catch (error: any) {
        throw new CatalogServiceError('Failed to create product', 'CREATE_FAILED', error);
    }
  }

  /**
   * Updates an existing product's information.
   * 
   * @param id - The unique identifier of the product to update.
   * @param data - A partial product object containing the fields to update.
   * @returns A promise resolving to the updated Product.
   * @throws CatalogServiceError if the update fails.
   */
  public async updateProduct(id: string, data: Partial<Product>): Promise<Product> {
    try {
        const product = await this.repository.updateProduct(id, data);
        // Cache invalidation could be triggered here if SKU is included in data
        return product;
    } catch (error: any) {
        throw new CatalogServiceError('Failed to update product', 'UPDATE_FAILED', error);
    }
  }

  /**
   * Explicitly invalidates the cache for a specific product.
   * 
   * This operation is restricted to users with the 'ADMIN' role.
   * 
   * @param sku - The product SKU whose cache entry should be removed.
   * @param userRole - The role of the user requesting invalidation.
   * @throws CatalogServiceError if the user is unauthorized.
   */
  public async invalidateCache(sku: string, userRole: string): Promise<void> {
    if (userRole !== 'ADMIN') {
      throw new CatalogServiceError('Unauthorized access', 'FORBIDDEN');
    }
    await this.cache.del(`product:${sku}`);
    this.logger.info({ sku }, 'Cache invalidated by admin');
  }
}
