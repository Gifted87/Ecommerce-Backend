/**
 * Canonical RedisClient implementation lives at:
 *   src/services/product/catalog_inventory_manager/infrastructure/cache/redisClient.ts
 *
 * This barrel re-exports from the canonical location so that any import from
 * 'src/shared/redis/redisClient' continues to resolve without code changes.
 */
export {
  RedisClient,
  RedisCacheError,
} from '../../services/product/catalog_inventory_manager/infrastructure/cache/redisClient';

export type {
  RedisHealthStatus,
} from '../../services/product/catalog_inventory_manager/infrastructure/cache/redisClient';
