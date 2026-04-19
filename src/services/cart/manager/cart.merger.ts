import { Redis } from 'ioredis';
import Opossum = require('opossum');
import { Logger } from 'pino';
import { CartGeneralError } from './cart.errors';
import { CartLockManager } from './cart.lock.manager';

/**
 * CartMerger handles the atomic migration of guest carts to user carts.
 */
export class CartMerger {
  // Use any to bypass TS namespace issue
  private readonly breaker: any;
  private readonly logger: Logger;

  constructor(
    private readonly redis: Redis,
    private readonly loggerInstance: Logger,
    private readonly lockManager: CartLockManager
  ) {
    this.logger = loggerInstance.child({ module: 'CartMerger' });
    this.breaker = new Opossum(async (func: () => Promise<any>) => await func(), {
      timeout: 500,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }

  /**
   * Merges a guest cart into a user cart atomically.
   */
  public async merge(
    guestId: string,
    userId: string,
    correlationId: string
  ): Promise<void> {
    try {
      await this.lockManager.withLock(userId, 30, async () => {
        await this.breaker.fire(async () => {
          const guestKey = `cart:${guestId}`;
          const userKey = `cart:${userId}`;

          // Lua Script for atomic merge
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
      });

      this.logger.info({ userId, guestId, correlationId }, 'Cart merged successfully');
    } catch (err: any) {
      this.logger.error({ err: this.redactPII(err), userId, guestId, correlationId }, 'Failed to merge carts');
      throw new CartGeneralError('Merge operation failed', { metadata: { correlationId }, userId, guestId });
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
