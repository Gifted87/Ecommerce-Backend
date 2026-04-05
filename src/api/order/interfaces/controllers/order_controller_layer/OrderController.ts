import { Request, Response } from 'express';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { CheckoutProcessorService } from '../../../services/CheckoutProcessorService';
import { CreateOrderSchema, redactOrderPII } from '../../dtos/OrderDTOs';
import { ZodError } from 'zod';

/**
 * OrderController handles the incoming HTTP lifecycle for order placement.
 * Enforces strict validation, PII redaction, and error mapping to HTTP status codes.
 */
export class OrderController {
  constructor(
    private readonly checkoutProcessor: CheckoutProcessorService,
    private readonly logger: Logger
  ) {}

  /**
   * Handles POST /orders
   * Validates schema, triggers business logic, and ensures observability/security.
   */
  public async createOrder(req: Request, res: Response): Promise<void> {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    const startTime = Date.now();

    this.logger.info({
      msg: 'Received createOrder request',
      correlationId,
      path: req.path,
      method: req.method,
    });

    try {
      // 1. Schema Validation
      const validationResult = CreateOrderSchema.safeParse(req.body);
      if (!validationResult.success) {
        this.logError(correlationId, 'Validation failed', validationResult.error);
        res.status(400).json({
          error: 'Bad Request',
          details: validationResult.error.issues,
          correlationId,
        });
        return;
      }

      // 2. Business Logic Execution
      const orderData = validationResult.data;
      const result = await this.checkoutProcessor.processCheckout({
        ...orderData,
        orderId: uuidv4(),
        correlationId,
      });

      // 3. Success Response
      this.logCompletion(correlationId, startTime, 201);
      res.status(201).json({
        data: result,
        meta: { trace_id: correlationId, timestamp: new Date().toISOString() },
      });
    } catch (error: any) {
      // 4. Error Mapping
      this.handleError(error, correlationId, startTime, res);
    } finally {
      // Ensure connection closure if necessary (handled by express naturally, 
      // but explicitly referenced for resource cleanup safety)
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private handleError(error: any, correlationId: string, startTime: number, res: Response): void {
    this.logError(correlationId, 'Checkout process error', error);

    const errorMessage = error.message || 'Internal Server Error';
    
    // Map domain-specific errors to HTTP codes
    if (errorMessage.includes('409') || errorMessage.includes('Conflict')) {
      res.status(409).json({ error_code: 'CONFLICT', message: errorMessage, trace_id: correlationId });
    } else if (errorMessage.includes('422') || errorMessage.includes('Invalid')) {
      res.status(422).json({ error_code: 'UNPROCESSABLE_ENTITY', message: errorMessage, trace_id: correlationId });
    } else {
      res.status(500).json({ error_code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', trace_id: correlationId });
    }

    this.logCompletion(correlationId, startTime, res.statusCode);
  }

  private logError(correlationId: string, message: string, error: any): void {
    const errorDetails = error instanceof ZodError ? error.issues : String(error);
    this.logger.error({
      msg: message,
      correlationId,
      error: errorDetails,
    });
  }

  private logCompletion(correlationId: string, startTime: number, statusCode: number): void {
    const duration = Date.now() - startTime;
    this.logger.info({
      msg: 'Request completed',
      correlationId,
      durationMs: duration,
      statusCode,
    });
  }
}
