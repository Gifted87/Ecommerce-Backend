import { Router, Request, Response, NextFunction } from 'express';
import CircuitBreaker from 'opossum';
import { Logger } from 'pino';
import { z } from 'zod';

// Interfaces for injected dependencies
export interface OrderRouterDependencies {
  orderController: any; // Defined in OrderController
  logger: Logger;
  authMiddleware: any; // Returns (permissions: string[]) => RequestHandler
  rbacMiddleware: (permissions: string[]) => any;
  validateSchema: (schema: z.ZodSchema) => (req: Request, res: Response, next: NextFunction) => void;
  errorHandler: (err: any, req: Request, res: Response, next: NextFunction) => void;
  correlationMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}

/**
 * Creates the Express router for Order Management.
 * Implements security, validation, observability, and circuit breaking.
 */
export const createOrderRouter = (deps: OrderRouterDependencies): Router => {
  const router = Router();
  const { 
    orderController, 
    logger, 
    authMiddleware, 
    rbacMiddleware, 
    validateSchema, 
    errorHandler, 
    correlationMiddleware 
  } = deps;

  // Global Middleware
  router.use(correlationMiddleware);

  // Circuit Breaker for Order Fetching
  const getOrderBreaker = new CircuitBreaker(
    (id: string) => orderController.getOrderById(id),
    {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    }
  );

  /**
   * POST /orders
   * Initiates order checkout.
   */
  router.post(
    '/',
    authMiddleware(),
    rbacMiddleware(['order:write']),
    // validateSchema(OrderRequestSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await orderController.createOrder(req, res);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /orders
   * Lists orders for the authenticated user.
   */
  router.get(
    '/',
    authMiddleware(),
    rbacMiddleware(['order:read']),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await orderController.listOrders(req, res);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /orders/:id
   * Retrieves order details with circuit breaking.
   */
  router.get(
    '/:id',
    authMiddleware(),
    rbacMiddleware(['order:read']),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const order = await getOrderBreaker.fire(req.params.id);
        res.status(200).json(order);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * PATCH /orders/:id
   * Handles order state transitions.
   */
  router.patch(
    '/:id',
    authMiddleware(),
    rbacMiddleware(['order:write']),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await orderController.updateOrderStatus(req, res);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * DELETE /orders/:id
   * Cancels an order.
   */
  router.delete(
    '/:id',
    authMiddleware(),
    rbacMiddleware(['order:write']),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await orderController.cancelOrder(req, res);
      } catch (error) {
        next(error);
      }
    }
  );

  // Global error handler
  router.use(errorHandler);

  return router;
};
