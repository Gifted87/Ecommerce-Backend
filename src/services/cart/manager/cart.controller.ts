import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { CartService } from './cart.service';
import { 
  AddToCartSchema, 
  UpdateQuantitySchema, 
  RemoveItemSchema 
} from './cart.schema';
import Opossum = require('opossum');

/**
 * @fileoverview CartController
 * Orchestrates HTTP requests for cart operations, handling validation,
 * service delegation, and observability.
 */

export class CartController {
  constructor(
    private readonly cartService: CartService,
    private readonly logger: Logger,
    // Use any to bypass TS namespace issue
    private readonly breaker: any
  ) {}

  /**
   * Handles the request to retrieve the current state of a user's cart.
   * 
   * This method extracts authentication and correlation context from the request,
   * then delegates to the CartService via a circuit breaker to ensure resilience.
   * 
   * @param req - The Express Request object, including authenticated user and cartId param.
   * @param res - The Express Response object to send back the JSON cart representation.
   * @param next - The Express NextFunction to delegate errors to global handler.
   */
  public async getCart(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;
    const cartId = req.params.cartId;

    if (!userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', correlationId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.getCart(userId, cartId, correlationId));
      this.recordLatency(Date.now() - startTime, 'getCart', correlationId);
      res.status(200).json(cart);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Handles the request to add an item to a user's cart.
   * 
   * Validates the request body against the AddToCartSchema and then calls the CartService.
   * Records operation latency for observability.
   * 
   * @param req - The Express Request object containing the item details in the body.
   * @param res - The Express Response object to send back the updated cart.
   * @param next - The Express NextFunction for error propagation.
   */
  public async addItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;
    const cartId = req.params.cartId;

    if (!userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', correlationId });
      return;
    }

    const validation = AddToCartSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ error: 'VALIDATION_FAILED', details: validation.error.format(), correlationId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.addItem(userId, cartId, validation.data, correlationId));
      this.recordLatency(Date.now() - startTime, 'addItem', correlationId);
      res.status(200).json(cart);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Handles the request to update the quantity of a product in the cart.
   * 
   * Validates the request body against the UpdateQuantitySchema and then calls the CartService.
   * 
   * @param req - The Express Request object with productId and new quantity in the body.
   * @param res - The Express Response object with updated cart details.
   * @param next - The Express NextFunction.
   */
  public async updateQuantity(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;
    const cartId = req.params.cartId;

    if (!userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', correlationId });
      return;
    }

    const validation = UpdateQuantitySchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ error: 'VALIDATION_FAILED', details: validation.error.format(), correlationId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.updateQuantity(userId, cartId, validation.data.productId, validation.data.quantity, correlationId));
      this.recordLatency(Date.now() - startTime, 'updateQuantity', correlationId);
      res.status(200).json(cart);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Handles the request to remove an entire product from the cart.
   * 
   * Extracts the productId from the request parameters, validates it, and calls the CartService.
   * 
   * @param req - The Express Request object with productId as a URL parameter.
   * @param res - The Express Response object with updated cart details.
   * @param next - The Express NextFunction.
   */
  public async removeItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;
    const cartId = req.params.cartId;
    const productId = req.params.productId;

    if (!userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', correlationId });
      return;
    }

    const validation = RemoveItemSchema.safeParse({ productId });
    if (!validation.success) {
      res.status(400).json({ error: 'VALIDATION_FAILED', details: validation.error.format(), correlationId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.removeItem(userId, cartId, validation.data.productId, correlationId));
      this.recordLatency(Date.now() - startTime, 'removeItem', correlationId);
      res.status(200).json(cart);
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Logs the time taken to perform a specific cart operation for monitoring purposes.
   * 
   * @param durationMs - The duration of the operation in milliseconds.
   * @param operation - The name of the operation being recorded.
   * @param correlationId - The unique ID for tracing this request's lifecycle.
   */
  private recordLatency(durationMs: number, operation: string, correlationId: string): void {
    this.logger.info({ operation, durationMs, correlationId }, 'Operation latency tracked');
  }
}
