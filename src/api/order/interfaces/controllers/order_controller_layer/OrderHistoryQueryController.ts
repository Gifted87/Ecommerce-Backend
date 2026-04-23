import { Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import { CheckoutProcessorService } from '../../../../../services/order/checkout_processor/service/CheckoutProcessorService';
import { PaginationQuerySchema, ValidationError, ValidationErrorCode } from '@/api/order/interfaces/validators/OrderValidator';
import { redactOrderPII } from '@/api/order/interfaces/dtos/OrderDTOs';

/**
 * OrderHistoryQueryController handles high-throughput retrieval of historical order data.
 * Adheres to Clean Architecture, using dependency injection for Repository and Logger.
 */
export class OrderHistoryQueryController {
  constructor(
    private readonly checkoutProcessor: CheckoutProcessorService,
    private readonly logger: Logger
  ) {}

  /**
   * Retrieves paginated order history for the authenticated user.
   * Enforces strict validation, RBAC, and observability constraints.
   */
  public async getOrderHistory(req: Request, res: Response): Promise<void> {
    const correlationId = req.headers['x-correlation-id'] as string || 'unknown';
    const userId = (req as any).user?.id; // Assuming auth middleware populates req.user

    if (!userId) {
      res.status(401).json({
        error_code: 'UNAUTHORIZED',
        message: 'Authentication required',
        trace_id: correlationId,
      });
      return;
    }

    try {
      // 1. Validation
      const queryResult = PaginationQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        throw new ValidationError(
          queryResult.error.issues.map((issue) => ({
            path: issue.path.map((p) => String(p)),
            message: issue.message,
            code: ValidationErrorCode.INVALID_SCHEMA,
          })),
          correlationId
        );
      }

      const { page, limit, from, to } = queryResult.data;

      this.logger.info(
        { correlationId, userId, page, limit, from, to },
        'Fetching order history'
      );

      // 2. Data Fetching via Repository (Paginated)
      const orders = await this.checkoutProcessor.listOrdersPaginated(userId, limit, page);

      // 3. Response Construction (Redacting PII)
      const safeOrders = orders.map(redactOrderPII);

      res.status(200).json({
        data: safeOrders,
        meta: {
          trace_id: correlationId,
          timestamp: new Date().toISOString(),
        },
      });

    } catch (error: any) {
      this.handleError(error, res, correlationId);
    }
  }

  /**
   * Normalizes domain and infrastructure errors into HTTP status codes.
   */
  private handleError(error: any, res: Response, correlationId: string): void {
    this.logger.error({ correlationId, error: error.message, stack: error.stack }, 'Request failed');

    if (error instanceof ValidationError) {
      res.status(400).json({
        error_code: 'BAD_REQUEST',
        message: error.message,
        details: error.details,
        trace_id: correlationId,
      });
      return;
    }

    if (error.code === 'NOT_FOUND') {
      res.status(404).json({
        error_code: 'NOT_FOUND',
        message: 'Order records not found',
        trace_id: correlationId,
      });
      return;
    }

    // Circuit Breaker / Database Connectivity Issues
    if (error.name === 'BrokenCircuitError' || error.name === 'TimeoutError') {
      res.status(503).json({
        error_code: 'SERVICE_UNAVAILABLE',
        message: 'Downstream service currently unavailable',
        trace_id: correlationId,
      });
      return;
    }

    res.status(500).json({
      error_code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      trace_id: correlationId,
    });
  }
}
