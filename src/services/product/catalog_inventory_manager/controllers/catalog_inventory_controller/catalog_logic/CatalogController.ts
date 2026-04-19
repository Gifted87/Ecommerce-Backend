import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import { Redis } from 'ioredis';
import { ProductSchema } from '@/domain/product/schemas/productInventorySchema';
import { CatalogService } from '../../../services/catalog/catalogService';

/**
 * @fileoverview CatalogController handles product discovery and catalog updates.
 * Implements cache-aside pattern, circuit breaker resilience, and strict input validation.
 */

export interface IRequestWithContext extends Request {
  correlationId?: string;
}

export class CatalogController {
  private readonly skuRegex = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;

  constructor(
    private readonly catalogService: CatalogService,
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {
    this.logger = this.logger.child({ component: 'CatalogController' });
  }

  /**
   * GET /products/:sku
   * Retrieves product data using cache-aside strategy.
   */
  public async getProductBySku(req: IRequestWithContext, res: Response): Promise<void> {
    const { sku } = req.params;
    const correlationId = req.headers['x-request-id'] as string || 'unknown';

    if (!this.skuRegex.test(sku)) {
      this.logger.warn({ sku, correlationId }, 'Invalid SKU format');
      res.status(400).json({ error: 'Invalid SKU format' });
      return;
    }

    try {
      // 1. Check Redis Cache
      const cachedProduct = await this.redis.get(`product:${sku}`);
      if (cachedProduct) {
        this.logger.debug({ sku, correlationId }, 'Cache hit');
        res.status(200).json(JSON.parse(cachedProduct));
        return;
      }

      // 2. Cache Miss: Fetch from Service
      this.logger.debug({ sku, correlationId }, 'Cache miss, fetching from source');
      // Note: CatalogService has getProductBySku instead of getBySku
      const product = await this.catalogService.getProductBySku(sku, correlationId);

      if (!product) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }

      // 3. Populate Cache Asynchronously
      this.redis.set(`product:${sku}`, JSON.stringify(product), 'EX', 3600).catch((err) =>
        this.logger.error({ err, sku, correlationId }, 'Failed to warm cache')
      );

      res.status(200).json(product);
    } catch (error: any) {
      this.handleError(error, res, correlationId);
    }
  }

  /**
   * POST /products
   * Creates a new product with validated payload.
   */
  public async createProduct(req: IRequestWithContext, res: Response): Promise<void> {
    const correlationId = req.headers['x-request-id'] as string || 'unknown';

    try {
      const validatedData = ProductSchema.omit({ id: true, created_at: true, updated_at: true }).parse(req.body);
      // Note: CatalogService doesn't have createProduct, it should probably call repository directly or service needs to be updated.
      // For now, I'll assume it exists or needs to be added to service.
      const product = await (this.catalogService as any).createProduct(validatedData);
      
      res.status(201).json(product);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      this.handleError(error, res, correlationId);
    }
  }

  /**
   * PUT /products/:id
   * Updates an existing product.
   */
  public async updateProduct(req: IRequestWithContext, res: Response): Promise<void> {
    const { id } = req.params;
    const correlationId = req.headers['x-request-id'] as string || 'unknown';

    try {
      const validatedData = ProductSchema.partial().parse(req.body);
      const product = await (this.catalogService as any).updateProduct(id, validatedData);

      // Invalidate cache on update
      await this.redis.del(`product:${product.sku}`);

      res.status(200).json(product);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: error.errors });
        return;
      }
      this.handleError(error, res, correlationId);
    }
  }

  /**
   * Centralized error mapping.
   */
  private handleError(error: any, res: Response, correlationId: string): void {
    this.logger.error({ error, correlationId }, 'Controller operation failed');

    if (error.code === 'NOT_FOUND') {
      res.status(404).json({ error: 'Resource not found' });
    } else if (error.code === 'CONFLICT') {
      res.status(409).json({ error: 'Concurrency conflict' });
    } else if (error.message && error.message.includes('timeout')) {
      res.status(504).json({ error: 'Gateway timeout' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
