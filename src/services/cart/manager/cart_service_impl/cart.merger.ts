import { Redis } from 'ioredis';
import Opossum from 'opossum';
import { Logger } from 'pino';
import { z } from 'zod';

/**
 * Domain error for Cart Service issues.
 */
export class CartServiceError extends Error {
  constructor(
    public message: string,
    public code: string,
    public correlationId: string,
    public originalError?: Error
  ) {
    super(`${message} (Correlation ID: ${correlationId})`);
    this.name = 'CartServiceError';
  }
}

/**
 * Concurrency error triggered when a lock cannot be acquired.
 */
export class CartConcurrencyError extends CartServiceError {
  constructor(correlationId: string, userId: string) {
    super(`Could not acquire lock for user: ${userId}`, 'CONCURRENCY_ERROR', correlationId);
  }
}

/**
 * Zod schema for validated cart items.
 */
export const CartItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  price: z.string(), // BigInt stored as string
  name: z.string(),
  updatedAt: z.string(),
});

export type CartItem = z.infer<typeof CartItemSchema>;

/**
 * CartMerger handles the atomic migration of guest carts to user carts.
 */
export class CartMerger {
  private readonly breaker: Opossum;
  private readonly logger: Logger;
  private readonly luaScriptHash: string;

  constructor(
    private readonly redis: Redis,
    private readonly loggerInstance: Logger,
    private readonly lockManager: any // Assuming CartLockManager interface
  ) {
    this.logger = loggerInstance.child({ module: 'CartMerger' });
    this.breaker = new Opossum(async (func: () => Promise<any>) => await func(), {
      timeout: 500,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
    // This is a placeholder for the actual script loading mechanism
    // In production, one should load the script into Redis on startup.
    this.luaScriptHash = 'merge_cart_script_hash'; 
  }

  /**
   * Merges a guest cart into a user cart atomically.
   */
  public async merge(
    guestId: string,
    userId: string,
    correlationId: string
  ): Promise<void> {
    const lock = await this.lockManager.acquire(userId, 5000);
    if (!lock) {
      throw new CartConcurrencyError(correlationId, userId);
    }

    try {
      await this.breaker.fire(async () => {
        const guestKey = `cart:${guestId}`;
        const userKey = `cart:${userId}`;

        // Lua Script:
        // 1. Fetch both carts
        // 2. Merge contents in Lua
        // 3. Delete Guest Cart
        const lua = `
          local guestCart = redis.call('HGETALL', KEYS[1])
          local userCart = redis.call('HGETALL', KEYS[2])
          
          local merged = {}
          
          local function processCart(cartData)
            for i=1, #cartData, 2 do
              local item = cjson.decode(cartData[i+1])
              local pId = cartData[i]
              if merged[pId] then
                merged[pId].quantity = merged[pId].quantity + item.quantity
                if item.updatedAt > merged[pId].updatedAt then
                  merged[pId].updatedAt = item.updatedAt
                end
              else
                merged[pId] = item
              end
            end
          end
          
          processCart(guestCart)
          processCart(userCart)
          
          for pId, item in pairs(merged) do
            redis.call('HSET', KEYS[2], pId, cjson.encode(item))
          end
          
          redis.call('DEL', KEYS[1])
          return 1
        `;

        await this.redis.eval(lua, 2, guestKey, userKey);
      });

      this.logger.info({ userId, guestId, correlationId }, 'Cart merged successfully');
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, guestId, correlationId }, 'Failed to merge carts');
      throw new CartServiceError('Merge operation failed', 'MERGE_FAILED', correlationId, err);
    } finally {
      await this.lockManager.release(lock);
    }
  }

  private redactPII(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj;
    const sensitiveKeys = ['address', 'phone', 'email', 'userId', 'guestId'];
    const redacted = { ...obj };
    for (const key of sensitiveKeys) {
      if (key in redacted) redacted[key] = '[REDACTED]';
    }
    return redacted;
  }
}
