import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import Opossum from 'opossum';
import { InventoryRepository, InsufficientStockError, InventoryRepositoryError } from '../../../domain/inventory/repository';
import { InventoryCacheManager } from '../../../infrastructure/cache/redis';

/**
 * Validation schemas for catalog browsing.
 */
const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * Interface representing the structure of a product reservation request.
 */
const ReservationSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

/**
 * Controller class for managing Product Catalog and Inventory transactions.
 * Orchestrates between Cache, Repository, and Express transport layer.
 */
export class ProductCatalogAndInventoryController {
  private readonly catalogBreaker: Opossum;
  private readonly inventoryBreaker: Opossum;

  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly cacheManager: InventoryCacheManager,
    private readonly logger: Logger
  ) {
    this.logger = logger.child({ module: 'ProductCatalogAndInventoryController' });

    // Circuit breakers as per mandate
    this.catalogBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    this.inventoryBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  /**
   * Retrieves products with pagination. Implements cache-aside.
   */
  public async getProducts(req: Request, res: Response, next: NextFunction): Promise<void> {
    const requestId = req.header('X-Request-ID') || 'unknown';
    const log = this.logger.child({ correlationId: requestId });
    
    try {
      const { page, limit } = PaginationSchema.parse(req.query);
      const cacheKey = `products_page_${page}_limit_${limit}`;

      // Try Cache
      const cached = await this.cacheManager.get(cacheKey, { correlationId: requestId });
      if (cached) {
        res.json(cached);
        return;
      }

      // Fetch from Repository
      const products = await this.catalogBreaker.fire(async () => {
        return await this.inventoryRepository.findAllPaginated(page, limit);
      });

      // Async Cache Populate
      this.cacheManager.set(cacheKey, products, { correlationId: requestId }, 300).catch(err => 
        log.error({ err }, 'Background cache population failed')
      );

      res.json(products);
    } catch (err: any) {
      this.handleError(err, res, log);
    }
  }

  /**
   * Reserves stock for a product, ensuring idempotency.
   */
  public async reserveInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
    const requestId = req.header('X-Request-ID') || 'unknown';
    const idempotencyKey = req.header('Idempotency-Key');
    const log = this.logger.child({ correlationId: requestId, idempotencyKey });

    if (!idempotencyKey) {
      res.status(400).json({ error: 'Missing Idempotency-Key header' });
      return;
    }

    try {
      const { productId, quantity } = ReservationSchema.parse(req.body);

      // Check Idempotency
      const cachedResult = await this.cacheManager.get(`idempotency_${idempotencyKey}`, { correlationId: requestId });
      if (cachedResult) {
        res.json(cachedResult);
        return;
      }

      // Execute Reservation
      const reservation = await this.inventoryBreaker.fire(async () => {
        return await this.inventoryRepository.reserveStock(productId, quantity);
      });

      // Persist Idempotency
      await this.cacheManager.set(`idempotency_${idempotencyKey}`, reservation, { correlationId: requestId }, 86400);

      res.status(201).json(reservation);
    } catch (err: any) {
      this.handleError(err, res, log);
    }
  }

  /**
   * Health check for system monitoring.
   */
  public async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      // Basic connectivity check to RDBMS and Cache
      await this.inventoryRepository.ping();
      res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: 'unhealthy', error: 'Downstream dependency failure' });
    }
  }

  /**
   * Centralized error handling and mapping.
   */
  private handleError(err: any, res: Response, log: Logger): void {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
    } else if (err instanceof InsufficientStockError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof InventoryRepositoryError && err.code === 'NOT_FOUND') {
      res.status(404).json({ error: 'Product or inventory record not found' });
    } else {
      log.error({ err: this.redact(err) }, 'Internal System Error');
      res.status(500).json({ error: 'Internal system error' });
    }
  }

  private redact(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj;
    const sensitive = ['password', 'authorization', 'secret', 'credit_card'];
    const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const key of Object.keys(redacted)) {
      if (sensitive.includes(key.toLowerCase())) {
        redacted[key] = '[REDACTED]';
      } else if (typeof redacted[key] === 'object') {
        redacted[key] = this.redact(redacted[key]);
      }
    }
    return redacted;
  }
}
