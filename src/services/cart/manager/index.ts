import { Redis } from 'ioredis';
import RedisLock from 'redlock';
import CircuitBreaker from 'opossum';
import { Logger } from 'pino';
import { z } from 'zod';

// Domain imports (assumed existing based on architecture)
import { CartRepository } from '../repository/cart_repository';
import { CartService } from '../service/cart_service';
import { CartLockManager } from '../../locks/cart_lock_manager';
import { CartMerger } from '../merger/cart_merger';
import { Cart, CartItem, CartSummary, CartStatus, CartConcurrencyError } from '../../../domain/cart.types';

export class ServiceInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceInitializationError';
  }
}

/**
 * Zod schemas for runtime input validation
 */
export const CartItemSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  quantity: z.number().int().positive(),
  pricePerUnit: z.bigint(),
  currency: z.string().length(3),
  addedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CartSchema = z.object({
  cartId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  items: z.array(CartItemSchema),
  status: z.nativeEnum(CartStatus),
  version: z.number().int().nonnegative(),
});

/**
 * Factory to bootstrap the Cart Management Service
 */
export async function createCartService(
  redis: Redis,
  lockClients: Redis[],
  logger: Logger
): Promise<CartService> {
  // 1. Verify infrastructure connectivity
  try {
    await redis.ping();
  } catch (error) {
    logger.error({ error }, 'Failed to ping Redis during initialization');
    throw new ServiceInitializationError('Redis cluster connection failed');
  }

  // 2. Initialize layers
  const repository = new CartRepository(redis);
  const lockManager = new CartLockManager(lockClients);
  const merger = new CartMerger();

  // 3. Configure Circuit Breaker
  const breakerOptions = {
    timeout: 500,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
  };

  const breaker = new CircuitBreaker(async (action: () => Promise<any>) => await action(), breakerOptions);
  
  breaker.on('open', () => logger.warn('CartService circuit breaker opened'));
  breaker.on('halfOpen', () => logger.info('CartService circuit breaker half-open'));
  breaker.on('close', () => logger.info('CartService circuit breaker closed'));

  // 4. Instantiate Service
  const service = new CartService(repository, lockManager, merger, logger, breaker);

  return service;
}

// Export domain types for consumers
export type { Cart, CartItem, CartSummary };
export { CartStatus, CartConcurrencyError };
