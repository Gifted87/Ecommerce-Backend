import { Router, Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import { OrderRequestSchema } from '../../../../domain/order/schemas/orderSchemas';

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

  /**
   * POST /orders
   * Initiates order checkout.
   */
  router.post(
    '/',
    authMiddleware(),
    rbacMiddleware(['order:write']),
    validateSchema(OrderRequestSchema),
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
   * Retrieves order details.
   */
  router.get(
    '/:id',
    authMiddleware(),
    rbacMiddleware(['order:read']),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await orderController.getOrderById(req, res);
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
