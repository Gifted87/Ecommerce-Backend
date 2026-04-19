import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { randomUUID } from 'crypto';
import { InventoryRepository } from '../../../repositories/inventory/inventoryRepository';
import { ReconciliationCacheManager } from '../../../services/reconciliation/core/infrastructure/cache/reconciliation_cache_manager';
import { KafkaMessagingManager } from '../../../bootstrap/infrastructure/messaging/KafkaMessagingManager';

/**
 * Zod schemas for request validation.
 */
const ReserveStockSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
});

const AdjustStockSchema = z.object({
  sku: z.string().min(1),
  adjustment: z.number().int(),
  reason: z.string().min(3),
});

/**
 * Custom Error for mapping business logic failures to HTTP status codes.
 */
export class InventoryControllerError extends Error {
  constructor(public message: string, public statusCode: number, public code: string) {
    super(message);
    this.name = 'InventoryControllerError';
  }
}

/**
 * CatalogInventoryController
 * Mediates between transport layer and business domain.
 * Implements cache-aside, idempotency, and ACID-compliant transactional updates.
 */
export class CatalogInventoryController {
  constructor(
    private readonly repository: InventoryRepository,
    private readonly cache: ReconciliationCacheManager,
    private readonly kafka: KafkaMessagingManager,
    private readonly logger: Logger
  ) {}

  /**
   * GET /inventory/:sku
   * Returns stock levels using cache-aside strategy.
   */
  public async getInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { sku } = req.params;
    const forceRefresh = req.headers['x-force-refresh'] === 'true';
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();

    const contextLogger = this.logger.child({ sku, requestId, method: 'getInventory' });

    try {
      if (!forceRefresh) {
        const cached = await this.cache.getInventoryState(sku);
        if (cached) {
          res.setHeader('X-Cache', 'HIT');
          res.status(200).json({ data: cached, requestId });
          return;
        }
      }

      const inventory = await this.repository.getInventory(sku);
      if (!inventory) {
        throw new InventoryControllerError('Product not found', 404, 'PRODUCT_NOT_FOUND');
      }

      await this.cache.setInventoryState(sku, inventory);
      res.setHeader('X-Cache', 'MISS');
      res.status(200).json({ data: inventory, requestId });
    } catch (error) {
      contextLogger.error({ error }, 'Error fetching inventory');
      next(error);
    }
  }

  /**
   * POST /inventory/:sku/reserve
   * Performs atomic stock reservation.
   */
  public async reserveStock(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { sku } = req.params;
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const body = ReserveStockSchema.safeParse({ ...req.body, sku });

    if (!body.success) {
      res.status(400).json({ errors: body.error.format() });
      return;
    }

    const { quantity, idempotencyKey } = body.data;
    const contextLogger = this.logger.child({ sku, requestId, idempotencyKey, method: 'reserveStock' });

    try {
      const inventory = await this.repository.reserveStock(sku, quantity, idempotencyKey);
      await this.cache.setInventoryState(sku, inventory);

      res.status(200).json({ data: inventory, requestId });
    } catch (error) {
      contextLogger.error({ error }, 'Failed to reserve stock');
      next(error);
    }
  }

  /**
   * POST /inventory/:sku/adjust
   * Admin only: Adjust stock levels and emit Kafka event.
   */
  public async adjustStock(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { sku } = req.params;
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const body = AdjustStockSchema.safeParse({ ...req.body, sku });

    if (!body.success) {
      res.status(400).json({ errors: body.error.format() });
      return;
    }

    const { adjustment, reason } = body.data;
    const contextLogger = this.logger.child({ sku, requestId, method: 'adjustStock' });

    try {
      const updatedInventory = await this.repository.updateStock(sku, adjustment, requestId);
      await this.cache.setInventoryState(sku, updatedInventory);

      await this.kafka.publish('inventory.adjusted', sku, {
        header: { idempotencyKey: requestId, timestamp: new Date().toISOString() },
        payload: { productId: sku, adjustment, reason }
      }, requestId);

      res.status(200).json({ data: updatedInventory, requestId });
    } catch (error) {
      contextLogger.error({ error }, 'Failed to adjust stock');
      next(error);
    }
  }

  /**
   * GET /health
   * Connectivity probes for DB and Cache.
   */
  public async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      // Validate connectivity
      await this.repository.getInventory('health-check-id');
      await this.cache.getInventoryState('health-check-id');
      res.status(200).json({ status: 'UP' });
    } catch (error) {
      this.logger.error({ error }, 'Health check failed');
      res.status(503).json({ status: 'DOWN', error: 'Service Unavailable' });
    }
  }
}
