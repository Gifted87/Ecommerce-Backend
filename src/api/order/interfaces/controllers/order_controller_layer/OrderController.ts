import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { CheckoutProcessorService } from '../../../../../services/order/checkout_processor/service/CheckoutProcessorService';
import { CheckoutRequestSchema } from '../../validation/orderValidation';
import { OrderErrorMapper } from './order_error_mapper';
import { ZodError } from 'zod';

/**
 * OrderController handles the incoming HTTP lifecycle for order placement and management.
 */
export class OrderController {
  constructor(
    private readonly checkoutProcessor: CheckoutProcessorService,
    private readonly logger: Logger,
    private readonly errorMapper: OrderErrorMapper
  ) {}

  public async createOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const startTime = Date.now();

    this.logger.info({
      msg: 'Received createOrder request',
      correlationId,
      path: req.path,
      method: req.method,
    });

    try {
      const validationResult = CheckoutRequestSchema.safeParse(req.body);
      if (!validationResult.success) {
        this.logError(req, correlationId, 'Validation failed', validationResult.error);
        res.status(400).json({
          error: 'Bad Request',
          details: validationResult.error.issues,
          correlationId,
        });
        return;
      }

      const orderData = validationResult.data;
      const result = await this.checkoutProcessor.processCheckout({
        ...orderData,
        orderId: (req as any).correlationId,
        userId: (req as any).user?.sub,
        correlationId,
      });

      this.logCompletion(req, correlationId, startTime, 201);
      res.status(201).json({
        data: result,
        meta: { trace_id: correlationId, timestamp: new Date().toISOString() },
      });
    } catch (error: any) {
      next(error);
    }
  }

  public async getOrderById(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { id } = req.params;
    try {
        const order = await this.checkoutProcessor.getOrderById(id);
        res.status(200).json(order);
    } catch (error: any) {
        next(error);
    }
  }

  public async listOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const userId = (req as any).user?.sub;
    try {
        if (!userId) {
            res.status(401).json({ error: 'Unauthorized', correlationId });
            return;
        }
        const orders = await this.checkoutProcessor.listOrdersByUserId(userId);
        res.status(200).json(orders);
    } catch (error: any) {
        next(error);
    }
  }

  public async updateOrderStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const { id } = req.params;
    const { status } = req.body;
    try {
        await this.checkoutProcessor.updateStatus(id, status);
        res.status(200).json({ message: 'Order status updated', correlationId });
    } catch (error: any) {
        next(error);
    }
  }

  public async cancelOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    const correlationId = (req as any).correlationId;
    const { id } = req.params;
    try {
        await this.checkoutProcessor.updateStatus(id, 'CANCELLED' as any);
        res.status(200).json({ message: 'Order cancelled', correlationId });
    } catch (error: any) {
        next(error);
    }
  }

  private logError(req: Request, correlationId: string, message: string, error: any): void {
    const errorDetails = error instanceof ZodError ? error.issues : String(error);
    this.logger.error({
      msg: message,
      correlationId,
      error: errorDetails,
    });
  }

  private logCompletion(req: Request, correlationId: string, startTime: number, statusCode: number): void {
    const duration = Date.now() - startTime;
    this.logger.info({
      msg: 'Request completed',
      correlationId,
      durationMs: duration,
      statusCode,
    });
  }
}
