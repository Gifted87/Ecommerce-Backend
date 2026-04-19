import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import Opossum = require('opossum');
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

const RateLimitConfigSchema = z.object({
  UNAUTH_POINTS: z.coerce.number().default(100),
  UNAUTH_DURATION: z.coerce.number().default(60),
  AUTH_POINTS: z.coerce.number().default(500),
  AUTH_DURATION: z.coerce.number().default(60),
});

const config = RateLimitConfigSchema.parse({
  UNAUTH_POINTS: process.env.RATE_LIMIT_UNAUTH_POINTS,
  UNAUTH_DURATION: process.env.RATE_LIMIT_UNAUTH_DURATION,
  AUTH_POINTS: process.env.RATE_LIMIT_AUTH_POINTS,
  AUTH_DURATION: process.env.RATE_LIMIT_AUTH_DURATION,
});

export interface RateLimitConfig {
  points: number;
  duration: number;
}

export class DistributedRateLimiter {
  private static instance: DistributedRateLimiter;
  private redis: Redis;
  private logger: pino.Logger;
  // Use any to bypass TS namespace issue
  private breaker: any; 
  private limiters: Map<string, RateLimiterRedis> = new Map();

  private constructor(redis: Redis) {
    this.redis = redis;
    this.logger = logger.child({ module: 'DistributedRateLimiter' });

    this.breaker = new Opossum(
      async (key: string, points: number, duration: number) => {
        const limiter = this.getLimiter(key, points, duration);
        return await limiter.consume(key);
      },
      {
        timeout: 3000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.breaker.on('open', () => this.logger.error('RateLimiter circuit breaker opened. Failing open.'));
    this.breaker.on('close', () => this.logger.info('RateLimiter circuit breaker closed.'));
  }

  public static getInstance(redis: Redis): DistributedRateLimiter {
    if (!DistributedRateLimiter.instance) {
      DistributedRateLimiter.instance = new DistributedRateLimiter(redis);
    }
    return DistributedRateLimiter.instance;
  }

  private getLimiter(keyPrefix: string, points: number, duration: number): RateLimiterRedis {
    if (!this.limiters.has(keyPrefix)) {
      this.limiters.set(
        keyPrefix,
        new RateLimiterRedis({
          storeClient: this.redis,
          keyPrefix,
          points,
          duration,
        })
      );
    }
    return this.limiters.get(keyPrefix)!;
  }

  public middleware(overrideConfig?: RateLimitConfig) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
      const userId = (req as any).user?.sub;
      
      const keyPrefix = userId ? 'auth' : 'anon';
      const key = userId ? `auth:${userId}` : `anon:${req.ip}`;
      
      const limit = overrideConfig || (userId 
        ? { points: config.AUTH_POINTS, duration: config.AUTH_DURATION }
        : { points: config.UNAUTH_POINTS, duration: config.UNAUTH_DURATION }
      );

      try {
        await this.breaker.fire(key, limit.points, limit.duration);
        next();
      } catch (err: any) {
        if (err instanceof Error && (err as any).name === 'RateLimiterRes') {
          const rateLimitErr = err as unknown as RateLimiterRes;
          const retryAfter = Math.ceil(rateLimitErr.msBeforeNext / 1000) || 1;

          this.logger.warn({ correlationId, key, event: 'RATE_LIMIT_EXCEEDED' }, 'Rate limit exceeded');
          
          res.setHeader('Retry-After', retryAfter.toString());
          return res.status(429).json({
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests',
            retryAfterSeconds: retryAfter,
          });
        }

        this.logger.error({ correlationId, err, event: 'RATE_LIMITER_FAILURE' }, 'Rate limiter failed, failing open');
        next();
      }
    };
  }

  public async getHealth(): Promise<{ status: 'ready' | 'degraded' | 'down' }> {
    if (this.redis.status !== 'ready') {
      return { status: 'down' };
    }
    if (this.breaker.opened) {
      return { status: 'degraded' };
    }
    return { status: 'ready' };
  }
}
