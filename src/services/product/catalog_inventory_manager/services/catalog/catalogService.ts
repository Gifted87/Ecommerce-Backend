import { z } from 'zod';
import { Logger } from 'pino';
import Opossum from 'opossum';
import { ProductRepository } from '../../repository/ProductRepository';
import { RedisClient } from '../../../../infrastructure/redis/redis.client';
import logger from '../../../../logging/logger';
import { Product, ProductSchema } from '../../domain/Product';

/**
 * Domain-specific errors for CatalogService
 */
export class CatalogServiceError extends Error {
  constructor(public message: string, public code: string, public originalError?: Error) {
    super(message);
    this.name = 'CatalogServiceError';
  }
}

/**
 * CatalogService manages product information retrieval using a cache-aside pattern.
 * It coordinates between PostgreSQL via ProductRepository and Redis for high-performance access.
 */
export class CatalogService {
  private static instance: CatalogService;
  private readonly repository: ProductRepository;
  private readonly cache: RedisClient;
  private readonly log: Logger;
  private readonly CACHE_TTL = 3600;

  private readonly getProductBreaker: Opossum<[string], Product | null>;

  private constructor() {
    this.repository = ProductRepository.getInstance();
    this.cache = RedisClient.getInstance();
    this.log = logger.child({ module: 'CatalogService' });

    // Circuit breaker configuration
    const breakerOptions = {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.getProductBreaker = new Opossum(this.executeGetProduct.bind(this), breakerOptions);
    this.getProductBreaker.on('open', () => this.log.error('CatalogService: Circuit breaker opened.'));
    this.getProductBreaker.on('halfOpen', () => this.log.info('CatalogService: Circuit breaker half-open.'));
    this.getProductBreaker.on('close', () => this.log.info('CatalogService: Circuit breaker closed.'));
  }

  public static getInstance(): CatalogService {
    if (!CatalogService.instance) {
      CatalogService.instance = new CatalogService();
    }
    return CatalogService.instance;
  }

  /**
   * Retrieves a product by SKU using cache-aside pattern.
   * Validates integrity using Zod schemas.
   * @param sku The product SKU.
   * @param transactionId Unique ID for tracing.
   */
  public async getProductBySku(sku: string, transactionId: string): Promise<Product | null> {
    const start = Date.now();
    this.log.info({ sku, transactionId, operation: 'getProductBySku' }, 'Initiating product fetch');

    try {
      return await this.getProductBreaker.fire(sku);
    } catch (err) {
      this.log.error({ err, sku, transactionId }, 'Failed to retrieve product');
      throw new CatalogServiceError(`Failed to fetch product: ${sku}`, 'FETCH_FAILED', err as Error);
    } finally {
      this.log.debug({ duration: Date.now() - start, sku, transactionId }, 'Operation completed');
    }
  }

  private async executeGetProduct(sku: string): Promise<Product | null> {
    // 1. Try Cache
    try {
      const cached = await this.cache.get<unknown>(`product:${sku}`);
      if (cached) {
        const validated = ProductSchema.safeParse(cached);
        if (validated.success) {
          this.log.info({ sku }, 'Cache hit');
          return validated.data;
        }
        this.log.warn({ sku }, 'Cache data corruption detected. Invalidate and re-fetch.');
        await this.cache.del(`product:${sku}`);
      }
    } catch (err) {
      this.log.error({ err, sku }, 'Cache access failed, proceeding to DB');
    }

    // 2. Try DB
    const product = await this.repository.getBySku(sku);
    if (!product) {
      return null;
    }

    // 3. Populate Cache (async fire-and-forget)
    this.cache.set(`product:${sku}`, product, this.CACHE_TTL).catch((err) =>
      this.log.error({ err, sku }, 'Failed to update cache after miss')
    );

    return product;
  }

  /**
   * Invalidates product cache. Requires ADMIN scope.
   */
  public async invalidateCache(sku: string, userRole: string): Promise<void> {
    if (userRole !== 'ADMIN') {
      throw new CatalogServiceError('Unauthorized access', 'FORBIDDEN');
    }
    await this.cache.del(`product:${sku}`);
    this.log.info({ sku }, 'Cache invalidated by admin');
  }
}
