import { Redis } from 'ioredis';
import CircuitBreaker from 'opossum';
import { Logger } from 'pino';
import { z } from 'zod';

/**
 * Custom error class for Cart Repository operations.
 */
export class CartServiceError extends Error {
  constructor(public message: string, public code: string, public correlationId: string, public originalError?: Error) {
    super(`${message} (Correlation ID: ${correlationId})`);
    this.name = 'CartServiceError';
  }
}

/**
 * Concurrency error triggered by version mismatch.
 */
export class CartConcurrencyError extends CartServiceError {
  constructor(correlationId: string) {
    super('Cart version mismatch detected.', 'CONCURRENCY_ERROR', correlationId);
  }
}

/**
 * Schema for cart items with financial precision handled via BigInt strings for Redis.
 */
const CartItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  price: z.string().refine((val) => /^\d+$/.test(val), { message: 'Price must be a string representation of a BigInt' }),
  name: z.string(),
  version: z.number().int().nonnegative(),
});

type CartItem = z.infer<typeof CartItemSchema>;

/**
 * CartRepository implementation for Redis-backed storage with strict atomic operations.
 */
export class CartRepository {
  private static instance: CartRepository;
  private readonly redis: Redis;
  private readonly breaker: CircuitBreaker;
  private readonly logger: Logger;
  private readonly CART_TTL = 86400; // 24 hours

  private constructor(redis: Redis, logger: Logger) {
    this.redis = redis;
    this.logger = logger.child({ module: 'CartRepository' });

    const breakerOptions = {
      timeout: 500,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breaker = new CircuitBreaker(async (action: () => Promise<any>) => await action(), breakerOptions);
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

  public async getCart(userId: string, correlationId: string): Promise<Record<string, CartItem>> {
    const start = Date.now();
    try {
      const data = await this.breaker.fire(async () => await this.redis.hgetall(`cart:${userId}`));
      if (!data || Object.keys(data).length === 0) return {};

      const cart: Record<string, CartItem> = {};
      for (const [productId, json] of Object.entries(data)) {
        const item = CartItemSchema.parse(JSON.parse(json));
        cart[productId] = item;
      }
      this.logger.info({ userId, duration: Date.now() - start, correlationId }, 'Cart fetched');
      return cart;
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error fetching cart');
      throw new CartServiceError('Failed to fetch cart', 'REDIS_ERROR', correlationId, err);
    }
  }

  public async updateCart(userId: string, item: CartItem, correlationId: string): Promise<void> {
    const start = Date.now();
    const key = `cart:${userId}`;
    const luaScript = `
      local current = redis.call('HGET', KEYS[1], ARGV[1])
      if current then
        local item = cjson.decode(current)
        if item.version ~= tonumber(ARGV[2]) then
          return {err = "CONCURRENCY_ERROR"}
        end
      end
      local newItem = cjson.decode(ARGV[3])
      newItem.version = newItem.version + 1
      redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(newItem))
      redis.call('EXPIRE', KEYS[1], ARGV[4])
      return 1
    `;

    try {
      await this.breaker.fire(async () => {
        const result = await this.redis.eval(luaScript, 1, key, item.productId, item.version, JSON.stringify(item), this.CART_TTL);
        if (result && result.err === 'CONCURRENCY_ERROR') throw new CartConcurrencyError(correlationId);
      });
      this.logger.info({ userId, productId: item.productId, duration: Date.now() - start, correlationId }, 'Cart updated');
    } catch (err: any) {
      if (err instanceof CartConcurrencyError) throw err;
      this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error updating cart');
      throw new CartServiceError('Failed to update cart', 'REDIS_ERROR', correlationId, err);
    }
  }

  public async deleteCart(userId: string, correlationId: string): Promise<void> {
    const start = Date.now();
    try {
      await this.breaker.fire(async () => await this.redis.del(`cart:${userId}`));
      this.logger.info({ userId, duration: Date.now() - start, correlationId }, 'Cart deleted');
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, correlationId }, 'Error deleting cart');
      throw new CartServiceError('Failed to delete cart', 'REDIS_ERROR', correlationId, err);
    }
  }

  public async checkHealth(correlationId: string): Promise<void> {
    try {
      await this.breaker.fire(async () => await this.redis.ping());
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), correlationId }, 'Cart health check failed');
      throw new CartServiceError('Service Unavailable', 'SERVICE_UNAVAILABLE', correlationId, err);
    }
  }
}
