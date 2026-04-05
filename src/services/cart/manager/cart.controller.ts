import { Request, Response } from 'express';
import { Logger } from 'pino';
import { CartService } from '../service/cart_service';
import { 
  AddToCartSchema, 
  UpdateQuantitySchema, 
  RemoveItemSchema 
} from '../validation/cart.schemas';
import { 
  CartServiceError, 
  CartNotFoundError, 
  CartConcurrencyError, 
  CartItemValidationError 
} from '../errors/cart.errors';
import { CircuitBreaker } from 'opossum';

/**
 * @fileoverview CartController
 * Orchestrates HTTP requests for cart operations, handling validation,
 * service delegation, error mapping, and observability.
 */

export class CartController {
  constructor(
    private readonly cartService: CartService,
    private readonly logger: Logger,
    private readonly breaker: CircuitBreaker<[...any[]], any>
  ) {}

  public async getCart(req: Request, res: Response): Promise<void> {
    const requestId = req.headers['x-request-id'] as string || 'unknown';
    const userId = req.headers['x-user-id'] as string;
    const cartId = req.params.cartId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', requestId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.getCart(userId, cartId));
      this.recordLatency(Date.now() - startTime, 'getCart');
      res.status(200).json(cart);
    } catch (error) {
      this.handleError(error, res, requestId, userId, cartId);
    }
  }

  public async addItem(req: Request, res: Response): Promise<void> {
    const requestId = req.headers['x-request-id'] as string || 'unknown';
    const userId = req.headers['x-user-id'] as string;
    const cartId = req.params.cartId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', requestId });
      return;
    }

    const validation = AddToCartSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ error: 'Validation Failed', details: validation.error.format(), requestId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.addItem(userId, cartId, validation.data));
      this.recordLatency(Date.now() - startTime, 'addItem');
      res.status(200).json(cart);
    } catch (error) {
      this.handleError(error, res, requestId, userId, cartId);
    }
  }

  public async updateQuantity(req: Request, res: Response): Promise<void> {
    const requestId = req.headers['x-request-id'] as string || 'unknown';
    const userId = req.headers['x-user-id'] as string;
    const cartId = req.params.cartId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', requestId });
      return;
    }

    const validation = UpdateQuantitySchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ error: 'Validation Failed', details: validation.error.format(), requestId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.updateQuantity(userId, cartId, validation.data));
      this.recordLatency(Date.now() - startTime, 'updateQuantity');
      res.status(200).json(cart);
    } catch (error) {
      this.handleError(error, res, requestId, userId, cartId);
    }
  }

  public async removeItem(req: Request, res: Response): Promise<void> {
    const requestId = req.headers['x-request-id'] as string || 'unknown';
    const userId = req.headers['x-user-id'] as string;
    const cartId = req.params.cartId;
    const productId = req.params.productId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', requestId });
      return;
    }

    const validation = RemoveItemSchema.safeParse({ productId });
    if (!validation.success) {
      res.status(400).json({ error: 'Validation Failed', details: validation.error.format(), requestId });
      return;
    }

    try {
      const startTime = Date.now();
      const cart = await this.breaker.fire(async () => await this.cartService.removeItem(userId, cartId, validation.data.productId));
      this.recordLatency(Date.now() - startTime, 'removeItem');
      res.status(200).json(cart);
    } catch (error) {
      this.handleError(error, res, requestId, userId, cartId);
    }
  }

  private handleError(error: any, res: Response, requestId: string, userId?: string, cartId?: string): void {
    this.logger.error({ error, requestId, userId, cartId }, 'Cart operation failed');

    if (error instanceof CartNotFoundError) {
      res.status(404).json({ error: error.message, code: error.errorCode, requestId });
    } else if (error instanceof CartConcurrencyError) {
      res.status(409).json({ error: 'Conflict: Please retry your request', code: error.errorCode, requestId });
    } else if (error instanceof CartItemValidationError) {
      res.status(422).json({ error: error.message, code: error.errorCode, requestId });
    } else if (error.code === 'EOPENBREAKER') {
      res.status(503).json({ error: 'Service Unavailable: Circuit Open', requestId });
    } else {
      res.status(500).json({ error: 'Internal Server Error', requestId });
    }
  }

  private recordLatency(durationMs: number, operation: string): void {
    // Integration with centralized monitoring system
    this.logger.info({ operation, durationMs }, 'Operation latency tracked');
  }
}
