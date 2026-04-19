import { Router, Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { CartController } from '../../../services/cart/manager/cart.controller';

/**
 * @fileoverview Cart API Routing Module.
 */

export interface CartRouterDependencies {
  cartController: CartController;
  logger: Logger;
  authMiddleware: any; // Expression returning middleware
}

/**
 * Configures and returns the Express router for the Cart API.
 * 
 * @param deps - Dependencies including controller and middleware.
 * @returns {Router} Configured Express router.
 */
export const createCartRouter = (deps: CartRouterDependencies): Router => {
  const router = Router();
  const { cartController, authMiddleware } = deps;

  /**
   * GET /api/v1/cart/:cartId
   */
  router.get('/:cartId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cartController.getCart(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/v1/cart/:cartId/items
   */
  router.post('/:cartId/items', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cartController.addItem(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * PATCH /api/v1/cart/:cartId/items
   */
  router.patch('/:cartId/items', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cartController.updateQuantity(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/v1/cart/:cartId/items/:productId
   */
  router.delete('/:cartId/items/:productId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await cartController.removeItem(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
