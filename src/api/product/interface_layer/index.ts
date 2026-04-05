import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import CircuitBreaker from 'opossum';
import pino from 'pino';

// Internal modules assumed to be available per architectural requirement
import { 
  getProduct, 
  listProducts, 
  reserveInventory, 
  releaseInventory 
} from './controllers';
import { 
  productSchema, 
  inventoryReserveSchema 
} from './schemas';
import { 
  authenticate, 
  authorizeRBAC 
} from '../../middleware/auth';
import { 
  validateRequest 
} from '../../middleware/validation';
import { 
  errorHandler 
} from '../../middleware/error';
import { 
  requestIdMiddleware 
} from '../../middleware/observability';

const logger = pino({ name: 'product-interface-layer' });

// Circuit Breaker Configuration
const breakerOptions = {
  timeout: 3000, 
  errorThresholdPercentage: 50,
  resetTimeout: 30000 
};

const getProductBreaker = new CircuitBreaker(getProduct, breakerOptions);
const reserveInventoryBreaker = new CircuitBreaker(reserveInventory, breakerOptions);

/**
 * Product API Interface Layer
 * Central registry for catalog and inventory-related traffic.
 */
const productRouter = Router();

// Global Observability: Inject Request ID
productRouter.use(requestIdMiddleware);

/**
 * @route GET /products
 * @desc List all products
 */
productRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await listProducts();
    res.status(200).json(products);
  } catch (error) {
    next(error);
  }
});

/**
 * @route GET /products/:id
 * @desc Get product details
 */
productRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await getProductBreaker.fire(req.params.id);
    res.status(200).json(product);
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /inventory/:sku/reserve
 * @desc Reserve inventory for a product
 * @access Protected (RBAC: 'inventory:write')
 */
productRouter.post(
  '/inventory/:sku/reserve',
  authenticate,
  authorizeRBAC(['inventory:write']),
  validateRequest(inventoryReserveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reserveInventoryBreaker.fire(req.params.sku, req.body);
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route DELETE /inventory/:sku/reserve
 * @desc Release reserved inventory
 * @access Protected (RBAC: 'inventory:write')
 */
productRouter.delete(
  '/inventory/:sku/reserve',
  authenticate,
  authorizeRBAC(['inventory:write']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await releaseInventory(req.params.sku, req.body.reservationId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Centralized Error Handling
productRouter.use(errorHandler);

export default productRouter;
