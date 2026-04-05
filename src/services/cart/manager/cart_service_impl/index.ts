import { Redis } from 'ioredis';
import RedisLock from 'redlock';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import pino from 'pino';

// Domain Types and Contracts
export type UUID = string;
export type ISO8601Date = string;

export enum CartStatus {
  ACTIVE = 'ACTIVE',
  PENDING_CHECKOUT = 'PENDING_CHECKOUT',
  PURCHASED = 'PURCHASED',
  ABANDONED = 'ABANDONED',
}

export interface CartItem {
  readonly productId: UUID;
  readonly sku: string;
  quantity: number;
  readonly pricePerUnit: bigint;
  readonly currency: string;
  readonly addedAt: ISO8601Date;
  updatedAt: ISO8601Date;
}

export interface CartSummary {
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly shippingTotal: bigint;
  readonly discountTotal: bigint;
  readonly grandTotal: bigint;
}

export interface Cart {
  readonly cartId: UUID;
  readonly userId: UUID | null;
  items: CartItem[];
  summary: CartSummary;
  status: CartStatus;
  readonly createdAt: ISO8601Date;
  updatedAt: ISO8601Date;
  readonly lockId: UUID;
  readonly version: number;
  readonly correlationId: UUID;
  readonly requestId: UUID;
}

export class CartServiceError extends Error {
  constructor(message: string, public readonly status: number = 500) {
    super(message);
    this.name = 'CartServiceError';
  }
}

export class CartConcurrencyError extends CartServiceError {
  constructor(public readonly cartId: UUID) {
    super(`Concurrency violation for cart ${cartId}`, 409);
    this.name = 'CartConcurrencyError';
  }
}

// Service Implementation
export class CartService {
  private readonly logger = pino({ name: 'CartService' });
  private readonly breaker: CircuitBreaker;
  private readonly lockManager: RedisLock;

  constructor(
    private readonly redis: Redis,
    private readonly lockClients: Redis[]
  ) {
    this.lockManager = new RedisLock(this.lockClients, {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200,
      retryJitter: 200,
    });

    const breakerOptions = {
      timeout: 500,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breaker = new CircuitBreaker(async (action: () => Promise<any>) => action(), breakerOptions);
    this.breaker.fallback(() => {
      throw new CartServiceError('Service Unavailable', 503);
    });
  }

  async getCart(cartId: UUID): Promise<Cart> {
    return this.breaker.fire(async () => {
      const data = await this.redis.get(`cart:${cartId}`);
      if (!data) throw new CartServiceError('Cart not found', 404);
      return JSON.parse(data, (key, value) => 
        (key === 'pricePerUnit' || key.endsWith('Total')) ? BigInt(value) : value
      ) as Cart;
    });
  }

  async addItem(cartId: UUID, item: CartItem): Promise<Cart> {
    return this.withLock(cartId, async () => {
      const cart = await this.getCart(cartId);
      const existing = cart.items.find(i => i.productId === item.productId);
      if (existing) {
        existing.quantity += item.quantity;
        existing.updatedAt = new Date().toISOString();
      } else {
        cart.items.push(item);
      }
      return this.saveCart(cart);
    });
  }

  async mergeCarts(guestCartId: UUID, userCartId: UUID): Promise<Cart> {
    const script = `
      local guest = redis.call('get', KEYS[1])
      local user = redis.call('get', KEYS[2])
      if not guest then return user end
      
      local guestCart = cjson.decode(guest)
      local userCart = user and cjson.decode(user) or { items = {}, version = 0 }
      
      for _, gItem in ipairs(guestCart.items) do
        local found = false
        for _, uItem in ipairs(userCart.items) do
          if uItem.productId == gItem.productId then
            uItem.quantity = uItem.quantity + gItem.quantity
            found = true
            break
          end
        end
        if not found then table.insert(userCart.items, gItem) end
      end
      
      userCart.version = userCart.version + 1
      userCart.updatedAt = guestCart.updatedAt
      
      redis.call('set', KEYS[2], cjson.encode(userCart))
      redis.call('del', KEYS[1])
      return cjson.encode(userCart)
    `;

    return this.breaker.fire(async () => {
      const result = await this.redis.eval(script, 2, `cart:${guestCartId}`, `cart:${userCartId}`);
      return JSON.parse(result as string);
    });
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async saveCart(cart: Cart): Promise<Cart> {
    const serialized = JSON.stringify(cart, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    await this.redis.set(`cart:${cart.cartId}`, serialized);
    return cart;
  }

  private async withLock<T>(cartId: UUID, task: () => Promise<T>): Promise<T> {
    const lockKey = `lock:cart:${cartId}`;
    const lock = await this.lockManager.acquire([lockKey], 1000);
    try {
      return await task();
    } finally {
      await lock.release();
    }
  }
}
