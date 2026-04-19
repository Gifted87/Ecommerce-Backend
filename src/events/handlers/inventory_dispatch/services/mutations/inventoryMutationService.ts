import { z } from 'zod';
import { Logger } from 'pino';
import Opossum = require('opossum');
import { createHmac, timingSafeEqual } from 'crypto';
import { Knex } from 'knex';

/**
 * @fileoverview InventoryMutationService
 * Handles inventory state transitions with transactional integrity,
 * circuit breaking, and HMAC security.
 */

export const InventoryMutationSchema = z.object({
  productId: z.string().uuid(),
  changeAmount: z.number().int(),
  reservationId: z.string().uuid(),
  correlationId: z.string().uuid(),
  timestamp: z.string().datetime(),
});

export type InventoryMutation = z.infer<typeof InventoryMutationSchema>;

export class InventoryValidationError extends Error {
  constructor(public details: { path: string[]; message: string }[]) {
    super('Inventory mutation validation failed');
    this.name = 'InventoryValidationError';
  }
}

export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

export class InventoryMutationService {
  // Use any to bypass TS namespace issue
  private readonly dbBreaker: any;
  private readonly hmacSecret: string;

  constructor(
    private readonly db: Knex,
    private readonly logger: Logger,
    hmacSecret?: string
  ) {
    this.hmacSecret = hmacSecret || process.env.HMAC_SECRET || 'fallback-secret';
    
    this.dbBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 5000,
      errorThresholdPercentage: 30,
      resetTimeout: 10000,
    });

    this.dbBreaker.on('open', () => this.logger.info('Circuit breaker opened for database'));
    this.dbBreaker.on('half-open', () => this.logger.info('Circuit breaker half-open for database'));
    this.dbBreaker.on('close', () => this.logger.info('Circuit breaker closed for database'));
  }

  public verifyHmac(payload: string, signature: string): boolean {
    const hmac = createHmac('sha256', this.hmacSecret);
    hmac.update(payload);
    const expected = hmac.digest('hex');
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  public redact(data: Record<string, any>): Record<string, any> {
    const sensitive = ['reservationId', 'email', 'userId', 'customerId'];
    const redacted = { ...data };
    for (const key of Object.keys(redacted)) {
      if (sensitive.includes(key)) redacted[key] = '[REDACTED]';
    }
    return redacted;
  }

  public async processMutation(
    rawPayload: unknown,
    signature: string,
    traceParent?: string
  ): Promise<void> {
    const payloadStr = JSON.stringify(rawPayload);
    if (!this.verifyHmac(payloadStr, signature)) {
      this.logger.error({ correlationId: (rawPayload as any)?.correlationId }, 'HMAC verification failed');
      throw new Error('Unauthorized: Invalid HMAC signature');
    }

    const validation = InventoryMutationSchema.safeParse(rawPayload);
    if (!validation.success) {
      throw new InventoryValidationError(
        validation.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
      );
    }

    const mutation = validation.data;
    const log = this.logger.child({ correlationId: mutation.correlationId, traceParent, productId: mutation.productId });

    try {
      await this.dbBreaker.fire(async () => {
        await this.db.transaction(async (trx) => {
          const current = await trx('inventory')
            .where({ product_id: mutation.productId })
            .select('total_stock', 'reserved_stock')
            .first()
            .forUpdate();

          if (!current) throw new Error('Product not found');

          const nextTotal = current.total_stock + mutation.changeAmount;
          const nextReserved = current.reserved_stock;

          if (nextTotal < 0) throw new Error('Insufficient total stock');
          if (nextTotal < nextReserved) throw new Error('Inventory constraint violation: total < reserved');

          await trx('inventory')
            .where({ product_id: mutation.productId })
            .update({
              total_stock: nextTotal,
              updated_at: new Date()
            });
        });
      });

      log.info({ ...this.redact(mutation) }, 'Inventory mutation processed successfully');
    } catch (err: any) {
      if (err.message === 'OpenCircuitError') {
        log.error('Database circuit breaker is open');
        throw new ServiceUnavailableError('Database service unavailable');
      }
      log.error({ err }, 'Failed to process inventory mutation');
      throw err;
    }
  }
}
