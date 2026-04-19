import Opossum = require('opossum');
import { Logger } from 'pino';
import { z } from 'zod';
import createError from 'http-errors';

/**
 * Zod schema for enforcing strict circuit breaker configuration.
 */
export const CircuitBreakerConfigSchema = z.object({
  timeout: z.number().int().positive().default(3000),
  errorThresholdPercentage: z.number().min(0).max(100).default(50),
  resetTimeout: z.number().int().positive().default(30000),
});

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

/**
 * Interface representing the health of a circuit breaker for K8s probes.
 */
export interface CircuitBreakerHealth {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  stats: {
    failures: number;
    successes: number;
    openRequests: number;
  };
}

/**
 * Factory for creating production-ready circuit breakers with integrated
 * logging, state monitoring, and standardized error handling.
 */
export class CircuitBreakerFactory {
  private readonly logger: Logger;
  // Use any to bypass TS namespace issue
  private readonly breakers: Map<string, any> = new Map();

  constructor(logger: Logger) {
    this.logger = logger.child({ module: 'CircuitBreakerFactory' });
  }

  /**
   * Creates a new, configured, and instrumented CircuitBreaker.
   *
   * @param name - Human-readable name for the breaker (e.g., 'redis-cache-read').
   * @param action - The asynchronous function to wrap with the breaker.
   * @param fallback - The fallback function to invoke if the circuit is open or action fails.
   * @param config - Configuration overrides for this specific breaker.
   */
  public create<T, A extends any[]>(
    name: string,
    action: (...args: A) => Promise<T>,
    fallback: (err: Error, ...args: A) => Promise<T>,
    config?: Partial<CircuitBreakerConfig>
  ): any {
    const validatedConfig = CircuitBreakerConfigSchema.parse(config || {});

    const breaker = new Opossum(action, {
      timeout: validatedConfig.timeout,
      errorThresholdPercentage: validatedConfig.errorThresholdPercentage,
      resetTimeout: validatedConfig.resetTimeout,
    });

    breaker.fallback(fallback);

    // Instrument with structured logging
    breaker.on('open', () => {
      this.logger.error(
        {
          breakerName: name,
          state: 'open',
          threshold: validatedConfig.errorThresholdPercentage,
        },
        'Circuit breaker opened: Infrastructure failure threshold exceeded.'
      );
    });

    breaker.on('halfOpen', () => {
      this.logger.warn(
        { breakerName: name, state: 'half-open' },
        'Circuit breaker half-open: Probing infrastructure for recovery.'
      );
    });

    breaker.on('close', () => {
      this.logger.info(
        { breakerName: name, state: 'close' },
        'Circuit breaker closed: Infrastructure restored.'
      );
    });

    breaker.on('timeout', () => {
      this.logger.warn({ breakerName: name }, 'Circuit breaker operation timed out.');
    });

    breaker.on('reject', () => {
      this.logger.error({ breakerName: name }, 'Circuit breaker rejected call due to open state.');
    });

    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * Wraps an asynchronous call in a middleware-style function that handles
   * circuit breaker state and abstracts errors into HTTP 503 if required.
   */
  public async execute<T, A extends any[]>(
    breakerName: string,
    action: (...args: A) => Promise<T>,
    correlationId: string,
    ...args: A
  ): Promise<T> {
    const breaker = this.breakers.get(breakerName);
    if (!breaker) {
      throw new Error(`Circuit breaker '${breakerName}' not initialized.`);
    }

    try {
      return await breaker.fire(...args);
    } catch (error: any) {
      // If the circuit is open, Opossum throws 'OpenCircuitError'
      if (error.code === 'EOPENBREAKER' || error.message === 'OpenCircuitError') {
        this.logger.error(
          { breakerName, correlationId, error: error.message },
          'Request rejected by circuit breaker.'
        );
        throw createError(503, 'Service Temporarily Unavailable', {
          expose: false, // Don't expose internal error details
        });
      }
      
      this.logger.error(
        { breakerName, correlationId, error: error.message },
        'Downstream operation failed.'
      );
      throw error;
    }
  }

  /**
   * Retrieves the current health of all managed circuits for K8s liveness probes.
   */
  public getHealth(): CircuitBreakerHealth[] {
    const health: CircuitBreakerHealth[] = [];
    for (const [name, breaker] of this.breakers.entries()) {
      health.push({
        name,
        state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
        stats: {
          failures: breaker.stats.failures,
          successes: breaker.stats.successes,
          openRequests: breaker.stats.pendingRequests,
        },
      });
    }
    return health;
  }
}
