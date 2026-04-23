import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import Breaker from 'opossum';
import { CatalogService } from '../../../services/product/catalog_inventory_manager/services/catalog/catalogService';
import { InventoryProcessor } from '../../../services/product/catalog_inventory_manager/services/inventory/inventory_processor/InventoryProcessor';

/**
 * Zod Schemas for Request Validation
 */
const InventoryReserveSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

/**
 * Interfaces for Dependencies
 */
export interface ProductRouterDependencies {
  logger: Logger;
  catalogService: CatalogService;
  inventoryProcessor: InventoryProcessor;
  authMiddleware: (options?: { requiredRoles?: string[]; mfaRequired?: boolean }) => (req: Request, res: Response, next: NextFunction) => void;
  validateSchema: (schema: any) => (req: Request, res: Response, next: NextFunction) => void;
}

/**
 * Routes definition for Catalog and Inventory
 */
export const createProductRouter = (deps: ProductRouterDependencies): Router => {
  const router = Router();
  const { logger, catalogService, inventoryProcessor, authMiddleware, validateSchema } = deps;

  // Circuit Breaker Options
  const breakerOptions = { timeout: 3000, errorThresholdPercentage: 50, resetTimeout: 30000 };

  const catalogBreaker = new Breaker(async (params: { sku: string; correlationId: string }) => 
    await catalogService.getProductBySku(params.sku, params.correlationId), 
    breakerOptions
  );

  /**
   * GET /products/:sku - Get product details
   */
  router.get('/products/:sku', async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = (req as any).correlationId;
    try {
      const product = await catalogBreaker.fire({ sku: req.params.sku, correlationId });
      if (!product) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found', correlationId });
      }
      res.status(200).json({ data: product, meta: { correlationId } });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /inventory/reserve - Reserve inventory
   */
  router.post(
    '/inventory/reserve',
    authMiddleware({ requiredRoles: ['USER', 'SERVICE_ACCOUNT'] }),
    validateSchema(InventoryReserveSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = (req as any).correlationId;
      const idempotencyKey = req.headers['x-idempotency-key'] as string;

      if (!idempotencyKey) {
        return res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'X-Idempotency-Key header is required', correlationId });
      }

      try {
        const validated = req.body; // Already validated by middleware

        await inventoryProcessor.reserveStock({
          productId: validated.productId,
          amount: validated.quantity,
          correlationId,
          userId: (req as any).user?.sub || 'system',
          idempotencyKey,
        });

        res.status(201).json({ status: 'RESERVED', correlationId });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
};
