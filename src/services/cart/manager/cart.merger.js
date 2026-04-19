"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CartMerger = void 0;
const opossum_1 = __importDefault(require("opossum"));
const cart_types_1 = require("./cart.types");
/**
 * CartMerger handles the atomic migration of guest carts to user carts.
 */
class CartMerger {
    constructor(redis, loggerInstance, lockManager) {
        this.redis = redis;
        this.loggerInstance = loggerInstance;
        this.lockManager = lockManager;
        this.logger = loggerInstance.child({ module: 'CartMerger' });
        this.breaker = new opossum_1.default(async (func) => await func(), {
            timeout: 500,
            errorThresholdPercentage: 50,
            resetTimeout: 30000,
        });
    }
    /**
     * Merges a guest cart into a user cart atomically.
     */
    async merge(guestId, userId, correlationId) {
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
        }
        catch (err) {
            this.logger.error({ err: this.redactPII(err), userId, guestId, correlationId }, 'Failed to merge carts');
            if (err instanceof cart_types_1.CartServiceError)
                throw err;
            throw new cart_types_1.CartServiceError('Merge operation failed', 'MERGE_FAILED', correlationId, err);
        }
    }
    redactPII(obj) {
        if (typeof obj !== 'object' || obj === null)
            return obj;
        const sensitiveKeys = ['address', 'phone', 'email', 'userId', 'guestId'];
        const redacted = { ...obj };
        for (const key of sensitiveKeys) {
            if (key in redacted)
                redacted[key] = '[REDACTED]';
        }
        return redacted;
    }
}
exports.CartMerger = CartMerger;
