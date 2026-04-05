import { Redis } from 'ioredis';
import Opossum from 'opossum';
import { Logger } from 'pino';
import { z } from 'zod';
import { RedisClient } from '../../../../infrastructure/redis/redis.client';
import logger from '../../../../logging/logger';

export interface CartItem {
  productId: string;
  quantity: number;
  price: number;
  name: string;
}

export class CartNotFoundError extends Error {
  constructor(userId: string) {
    super(`Cart not found for user: ${userId}`);
    this.name = 'CartNotFoundError';
  }
}

export class RedisCacheError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = 'RedisCacheError';
  }
}

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyError';
  }
}

export class CartRepository {
  private static instance: CartRepository;
  private redis: Redis;
  private breaker: Opossum;
  private log: Logger;
  private readonly CART_TTL = 86400; // 24 hours

  private constructor() {
    this.redis = RedisClient.getInstance().getClient();
    this.log = logger.child({ module: 'CartRepository' });

    this.breaker = new Opossum(async (command: string, ...args: any[]) => {
      return (this.redis as any)[command](...args);
    }, {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  public static getInstance(): CartRepository {
    if (!CartRepository.instance) {
      CartRepository.instance = new CartRepository();
    }
    return CartRepository.instance;
  }

  private getCartKey(userId: string): string {
    return `cart:${userId}`;
  }

  public async getCart(userId: string): Promise<Record<string, CartItem>> {
    const start = Date.now();
    const key = this.getCartKey(userId);
    try {
      const data = await this.breaker.fire('hgetall', key);
      const cart: Record<string, CartItem> = {};
      for (const [productId, itemJson] of Object.entries(data)) {
        cart[productId] = JSON.parse(itemJson as string);
      }
      this.log.info({ userId, duration: Date.now() - start }, 'Fetched cart');
      return cart;
    } catch (err) {
      this.log.error({ err, userId }, 'Failed to fetch cart');
      throw new RedisCacheError('Failed to fetch cart from Redis', err as Error);
    }
  }

  public async addToCart(userId: string, item: CartItem): Promise<Record<string, CartItem>> {
    const start = Date.now();
    const key = this.getCartKey(userId);
    const luaScript = `
      local cart = redis.call('HGET', KEYS[1], ARGV[1])
      local item
      if cart then
        item = cjson.decode(cart)
        item.quantity = item.quantity + tonumber(ARGV[2])
      else
        item = {productId=ARGV[1], quantity=tonumber(ARGV[2]), price=tonumber(ARGV[3]), name=ARGV[4]}
      end
      redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(item))
      redis.call('EXPIRE', KEYS[1], ARGV[5])
      return redis.call('HGETALL', KEYS[1])
    `;

    try {
      const result = await this.breaker.fire('eval', luaScript, 1, key, item.productId, item.quantity, item.price, item.name, this.CART_TTL);
      const cart: Record<string, CartItem> = {};
      for (let i = 0; i < result.length; i += 2) {
        cart[result[i]] = JSON.parse(result[i + 1]);
      }
      this.log.info({ userId, productId: item.productId, duration: Date.now() - start }, 'Added item to cart');
      return cart;
    } catch (err) {
      this.log.error({ err, userId, item }, 'Failed to add item to cart');
      throw new RedisCacheError('Failed to atomic add item to cart', err as Error);
    }
  }

  public async removeFromCart(userId: string, productId: string): Promise<void> {
    const start = Date.now();
    const key = this.getCartKey(userId);
    const luaScript = `
      redis.call('HDEL', KEYS[1], ARGV[1])
      if redis.call('HLEN', KEYS[1]) == 0 then
        redis.call('DEL', KEYS[1])
      end
    `;
    try {
      await this.breaker.fire('eval', luaScript, 1, key, productId);
      this.log.info({ userId, productId, duration: Date.now() - start }, 'Removed item from cart');
    } catch (err) {
      this.log.error({ err, userId, productId }, 'Failed to remove item from cart');
      throw new RedisCacheError('Failed to remove item from cart', err as Error);
    }
  }

  public async clearCart(userId: string): Promise<void> {
    const key = this.getCartKey(userId);
    try {
      await this.breaker.fire('del', key);
      this.log.info({ userId }, 'Cart cleared');
    } catch (err) {
      this.log.error({ err, userId }, 'Failed to clear cart');
      throw new RedisCacheError('Failed to clear cart', err as Error);
    }
  }

  public async mergeCarts(guestUserId: string, registeredUserId: string): Promise<void> {
    const guestKey = this.getCartKey(guestUserId);
    const userKey = this.getCartKey(registeredUserId);
    try {
      const guestCart = await this.breaker.fire('hgetall', guestKey);
      if (Object.keys(guestCart).length > 0) {
        const pipeline = this.redis.pipeline();
        for (const [productId, itemJson] of Object.entries(guestCart)) {
          pipeline.hset(userKey, productId, itemJson);
        }
        pipeline.del(guestKey);
        pipeline.expire(userKey, this.CART_TTL);
        await this.breaker.fire('exec', await pipeline.exec());
      }
      this.log.info({ guestUserId, registeredUserId }, 'Carts merged');
    } catch (err) {
      this.log.error({ err, guestUserId, registeredUserId }, 'Failed to merge carts');
      throw new RedisCacheError('Failed to merge carts', err as Error);
    }
  }

  public async getHealth(): Promise<{ status: 'healthy' | 'unhealthy'; redis: string; circuit: string }> {
    const redisStatus = this.redis.status;
    const circuitStatus = this.breaker.opened ? 'open' : 'closed';
    return {
      status: redisStatus === 'ready' && circuitStatus === 'closed' ? 'healthy' : 'unhealthy',
      redis: redisStatus,
      circuit: circuitStatus,
    };
  }
}
