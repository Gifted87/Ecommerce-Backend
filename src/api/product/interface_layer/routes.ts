import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';
import Breaker from 'opossum';
import { v4 as uuidv4 } from 'uuid';

/**
 * Zod Schemas for Request Validation
 */
const GetProductsSchema = z.object({
  limit: z.coerce.number().int().positive().default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  category: z.string().optional(),
  priceRange: z.string().regex(/^\d+-\d+$/).optional(),
});

const InventoryReserveSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
});

/**
 * Interfaces for Dependencies
 */
interface Dependencies {
  logger: Logger;
  catalogService: any;
  inventoryRepository: any;
  authMiddleware: (options: { requiredRoles?: string[] }) => (req: Request, res: Response, next: NextFunction) => void;
}

/**
 * Routes definition for Catalog and Inventory
 */
export const createProductRouter = (deps: Dependencies): Router => {
  const router = Router();
  const { logger, catalogService, inventoryRepository, authMiddleware } = deps;

  // Circuit Breaker Options
  const breakerOptions = { timeout: 3000, errorThresholdPercentage: 50, resetTimeout: 30000 };

  const catalogBreaker = new Breaker(async (params: any) => await catalogService.fetchProducts(params), breakerOptions);
  const inventoryBreaker = new Breaker(async (params: any) => await inventoryRepository.reserve(params), breakerOptions);

  /**
   * GET /products - List products with pagination/filtering
   */
  router.get('/products', async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = (req.headers['x-request-id'] as string) || uuidv4();
    try {
      const validated = GetProductsSchema.parse(req.query);
      
      const products = await catalogBreaker.fire({ ...validated, correlationId });
      res.status(200).json({ data: products, meta: { correlationId } });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ code: 'INVALID_INPUT', errors: err.errors });
      }
      logger.error({ err, correlationId }, 'Error fetching products');
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Catalog service currently unavailable' });
    }
  });

  /**
   * POST /inventory/:sku/reserve - Reserve inventory
   */
  router.post(
    '/inventory/:sku/reserve',
    authMiddleware({ requiredRoles: ['USER', 'SERVICE_ACCOUNT'] }),
    async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = (req.headers['x-request-id'] as string) || uuidv4();
      const idempotencyKey = req.headers['x-idempotency-key'] as string;

      if (!idempotencyKey) {
        return res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'X-Idempotency-Key header is required' });
      }

      try {
        const validated = InventoryReserveSchema.parse({
          sku: req.params.sku,
          quantity: req.body.quantity,
        });

        const result = await inventoryBreaker.fire({
          ...validated,
          idempotencyKey,
          correlationId,
        });

        res.status(201).json({ status: 'RESERVED', reservationId: result.id, correlationId });
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return res.status(400).json({ code: 'INVALID_INPUT', errors: err.errors });
        }
        
        // Translate domain-specific errors
        if (err.name === 'InsufficientStockError') {
          return res.status(409).json({ code: 'INSUFFICIENT_STOCK', message: err.message });
        }

        logger.error({ err, correlationId, sku: req.params.sku }, 'Inventory reservation failed');
        res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Inventory service temporarily unavailable' });
      }
    }
  );

  return router;
};
