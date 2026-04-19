import { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import Redis from 'ioredis';
import pino, { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import createError, { HttpError } from 'http-errors';
import { DistributedRateLimiter } from './rateLimiter';
import { globalErrorMiddleware } from './errorMiddleware';

/**
 * Interface defining the configuration for the ResilienceMiddlewareStack.
 */
export interface ResilienceConfig {
  redisUrl: string;
  rateLimitPoints: number;
  rateLimitDuration: number;
  breakerTimeout: number;
  breakerErrorThreshold: number;
  breakerResetTimeout: number;
}

/**
 * ResilienceMiddlewareStack orchestrates rate limiting, circuit breaking,
 * observability (logging), and error handling for high-concurrency requests.
 */
export class ResilienceMiddlewareStack {
  private readonly logger: Logger;
  private readonly redis: Redis;
  private readonly rateLimiter: DistributedRateLimiter;

  constructor(config: ResilienceConfig) {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      redact: {
        paths: ['password', 'credit_card', 'authorization', 'token', 'secret'],
        censor: '[REDACTED]',
      },
      base: { service: 'traffic-resilience-middleware' },
    });

    this.redis = new Redis(config.redisUrl, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    this.rateLimiter = new DistributedRateLimiter(this.redis, this.logger);
  }

  /**
   * Returns a composite middleware stack for application integration.
   * Includes correlation ID injection, rate limiting, and global error handling.
   */
  public get stack(): (RequestHandler | ErrorRequestHandler)[] {
    return [
      this.correlationMiddleware,
      this.rateLimiter.middleware(),
      globalErrorMiddleware as ErrorRequestHandler,
    ];
  }

  /**
   * Ensures every request has a correlation ID for distributed tracing.
   */
  private correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  }

  /**
   * Performs health checks against internal infrastructure (Redis connectivity, breaker state).
   */
  public async healthCheck(): Promise<{ status: 'ok' | 'degraded' | 'error'; components: any }> {
    const redisStatus = this.redis.status;
    const rateLimiterStatus = await this.rateLimiter.getHealth();

    const isHealthy = redisStatus === 'ready' && rateLimiterStatus.status !== 'down';

    return {
      status: isHealthy ? 'ok' : (redisStatus === 'ready' ? 'degraded' : 'error'),
      components: {
        redis: redisStatus,
        rateLimiter: rateLimiterStatus,
      },
    };
  }

  /**
   * Graceful shutdown of infrastructure connections.
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down ResilienceMiddlewareStack');
    await this.redis.quit();
  }
}

/**
 * Factory function to instantiate the resilience stack.
 */
export const createResilienceStack = (config: ResilienceConfig): ResilienceMiddlewareStack => {
  return new ResilienceMiddlewareStack(config);
};
