import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import Opossum = require('opossum');
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * Interface for Rate Limiter options per route.
 */
interface RateLimitConfig {
  points: number;
  duration: number;
}

/**
 * Default configuration for unauthenticated traffic.
 */
const DEFAULT_UNAUTHENTICATED_LIMIT: RateLimitConfig = {
  points: parseInt(process.env.RATE_LIMIT_UNAUTH_POINTS || '100', 10),
  duration: parseInt(process.env.RATE_LIMIT_UNAUTH_DURATION || '60', 10),
};

/**
 * Default configuration for authenticated traffic.
 */
const DEFAULT_AUTHENTICATED_LIMIT: RateLimitConfig = {
  points: parseInt(process.env.RATE_LIMIT_AUTH_POINTS || '500', 10),
  duration: parseInt(process.env.RATE_LIMIT_AUTH_DURATION || '60', 10),
};

/**
 * DistributedRateLimiter handles tiered traffic shaping using Redis.
 * Implements a fail-open philosophy, circuit breaking, and structured logging.
 */
export class DistributedRateLimiter {
  private redis: Redis;
  private logger: Logger;
  private breaker: InstanceType<typeof Opossum>;
  private readonly anonLimiter: RateLimiterRedis;
  private readonly authLimiter: RateLimiterRedis;

  constructor(redis: Redis, logger: Logger) {
    this.redis = redis;
    this.logger = logger.child({ module: 'DistributedRateLimiter' });

    this.anonLimiter = new RateLimiterRedis({
      storeClient: this.redis,
      keyPrefix: 'rate:anon',
      points: DEFAULT_UNAUTHENTICATED_LIMIT.points,
      duration: DEFAULT_UNAUTHENTICATED_LIMIT.duration,
    });

    this.authLimiter = new RateLimiterRedis({
      storeClient: this.redis,
      keyPrefix: 'rate:auth',
      points: DEFAULT_AUTHENTICATED_LIMIT.points,
      duration: DEFAULT_AUTHENTICATED_LIMIT.duration,
    });

    // Circuit breaker for Redis dependency protection
    this.breaker = new Opossum(
      async (key: string, isAuth: boolean) => {
        const limiter = isAuth ? this.authLimiter : this.anonLimiter;
        return await limiter.consume(key);
      },
      {
        timeout: 2000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.breaker.on('open', () => this.logger.error('RateLimiter circuit breaker opened. Failing closed.'));
    this.breaker.on('close', () => this.logger.info('RateLimiter circuit breaker closed.'));
  }

  /**
   * Middleware to enforce rate limiting.
   * @param overrideConfig Optional override for specific endpoints.
   */
  public middleware(overrideConfig?: RateLimitConfig) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
      const userId = (req as any).user?.sub;
      const key = userId ? `auth:${userId}` : `anon:${req.ip}`;
      const config = overrideConfig || (userId ? DEFAULT_AUTHENTICATED_LIMIT : DEFAULT_UNAUTHENTICATED_LIMIT);

      try {
        await this.breaker.fire(key, !!userId);
        next();
      } catch (err: any) {
        if (err instanceof Error && (err as any).name === 'RateLimiterRes') {
          const rateLimitErr = err as unknown as RateLimiterRes;
          const retryAfter = Math.round(rateLimitErr.msBeforeNext / 1000) || 1;

          this.logger.warn({ correlationId, key, event: 'RATE_LIMIT_EXCEEDED' }, 'Rate limit exceeded');
          
          return res.status(429).json({
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfterSeconds: retryAfter,
          });
        }

        // Fail-closed to prevent brute force during Redis outage
        this.logger.error({ correlationId, err, event: 'RATE_LIMITER_FAILURE' }, 'Rate limiter failed, returning 503');
        return res.status(503).json({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Rate limiting service is degraded',
        });
      }
    };
  }

  /**
   * Health check for Redis connectivity status.
   */
  public async getHealth(): Promise<{ status: 'ready' | 'degraded' | 'down' }> {
    try {
      if (this.redis.status !== 'ready') return { status: 'down' };
      if (this.breaker.opened) return { status: 'degraded' };
      return { status: 'ready' };
    } catch (err) {
      return { status: 'down' };
    }
  }
}
