import { Redis } from 'ioredis';
import Opossum = require('opossum');
import { Logger } from 'pino';
import { z } from 'zod';
import { CartGeneralError } from './cart.errors';

/**
 * Schema for cart items with financial precision handled via BigInt strings for Redis.
 */
const CartItemSchema = z.object({
  productId: z.string(),
  sku: z.string().optional(),
  quantity: z.number().int().positive(),
  pricePerUnit: z.string().refine((val) => /^\d+$/.test(val), { message: 'Price must be a string representation of a BigInt' }),
  currency: z.string().optional(),
  addedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
});

type CartItem = z.infer<typeof CartItemSchema>;

/**
 * CartRepository implementation for Redis-backed storage with strict atomic operations.
 */
export class CartRepository {
  private static instance: CartRepository;
  private readonly redis: Redis;
  // Use any to bypass TS namespace issue
  private readonly breaker: any;
  private readonly logger: Logger;
  private readonly CART_TTL = 86400; // 24 hours

  constructor(redis: Redis, logger: Logger) {
    this.redis = redis;
    this.logger = logger.child({ module: 'CartRepository' });

    const breakerOptions = {
      timeout: 500,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breaker = new Opossum(async (action: () => Promise<any>) => await action(), breakerOptions);
  }

  public static initialize(redis: Redis, logger: Logger): void {
    if (!CartRepository.instance) {
      CartRepository.instance = new CartRepository(redis, logger);
    }
  }

  public static getInstance(): CartRepository {
    if (!CartRepository.instance) {
      throw new Error('CartRepository must be initialized before use.');
    }
    return CartRepository.instance;
  }

  private redactPII(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj;
    const sensitiveKeys = ['address', 'phone', 'email'];
    const redacted = { ...obj };
    for (const key of sensitiveKeys) {
      if (key in redacted) redacted[key] = '[REDACTED]';
    }
    for (const key in redacted) {
      if (typeof redacted[key] === 'object') {
        redacted[key] = this.redactPII(redacted[key]);
      }
    }
    return redacted;
  }

  public async getCart(userId: string, correlationId: string): Promise<Record<string, any>> {
    const start = Date.now();
    try {
      const data = await this.breaker.fire(async () => await this.redis.hgetall(`cart:${userId}`));
      if (!data || Object.keys(data).length === 0) return {};

      const cart: Record<string, any> = {};
      for (const [productId, json] of Object.entries(data)) {
        const item = JSON.parse(json as string);
        // Cast bigints from strings
        item.pricePerUnit = BigInt(item.pricePerUnit);
        cart[productId] = item;
      }
      this.logger.info({ userId, duration: Date.now() - start, correlationId }, 'Cart fetched');
      return cart;
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error fetching cart');
      throw new CartGeneralError('Failed to fetch cart', { userId, metadata: { correlationId } });
    }
  }

  public async updateCart(userId: string, item: any, correlationId: string): Promise<void> {
    const start = Date.now();
    const key = `cart:${userId}`;
    
    // Convert BigInt to string for JSON serialization
    const serializedItem = {
      ...item,
      pricePerUnit: item.pricePerUnit.toString(),
      version: (item.version || 0) + 1
    };

    try {
      await this.breaker.fire(async () => {
        await this.redis.hset(key, item.productId, JSON.stringify(serializedItem));
        await this.redis.expire(key, this.CART_TTL);
      });
      this.logger.info({ userId, productId: item.productId, duration: Date.now() - start, correlationId }, 'Cart updated');
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error updating cart');
      throw new CartGeneralError('Failed to update cart', { userId, metadata: { correlationId } });
    }
  }

  public async updateQuantity(userId: string, productId: string, quantity: number, correlationId: string): Promise<void> {
    const start = Date.now();
    const key = `cart:${userId}`;
    try {
      await this.breaker.fire(async () => {
        const json = await this.redis.hget(key, productId);
        if (!json) throw new Error('Item not found in cart');
        const item = JSON.parse(json);
        item.quantity = quantity;
        item.version = (item.version || 0) + 1;
        item.updatedAt = new Date().toISOString();
        await this.redis.hset(key, productId, JSON.stringify(item));
      });
      this.logger.info({ userId, productId, quantity, duration: Date.now() - start, correlationId }, 'Cart item quantity updated');
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, productId, correlationId }, 'Error updating cart item quantity');
      throw new CartGeneralError('Failed to update cart item quantity', { userId, metadata: { correlationId } });
    }
  }

  public async removeItem(userId: string, productId: string, correlationId: string): Promise<void> {
    const start = Date.now();
    try {
      await this.breaker.fire(async () => {
        await this.redis.hdel(`cart:${userId}`, productId);
      });
      this.logger.info({ userId, productId, duration: Date.now() - start, correlationId }, 'Item removed from cart');
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, productId, correlationId }, 'Error removing item from cart');
      throw new CartGeneralError('Failed to remove item from cart', { userId, metadata: { correlationId } });
    }
  }

  public async deleteCart(userId: string, correlationId: string): Promise<void> {
    const start = Date.now();
    try {
      await this.breaker.fire(async () => await this.redis.del(`cart:${userId}`));
      this.logger.info({ userId, duration: Date.now() - start, correlationId }, 'Cart deleted');
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error deleting cart');
      throw new CartGeneralError('Failed to delete cart', { userId, metadata: { correlationId } });
    }
  }

  public async checkHealth(correlationId: string): Promise<void> {
    try {
      await this.breaker.fire(async () => await this.redis.ping());
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), correlationId }, 'Cart health check failed');
      throw new CartGeneralError('Service Unavailable', { metadata: { correlationId } });
    }
  }
}
