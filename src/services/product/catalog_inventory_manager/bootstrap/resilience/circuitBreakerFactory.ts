import CircuitBreaker from 'opossum';
import { Logger } from 'pino';
import { z } from 'zod';

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
 * Factory for creating production-ready circuit breakers with integrated
 * logging, state monitoring, and standardized error handling.
 */
export class CircuitBreakerFactory {
  private readonly logger: Logger;

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
  ): CircuitBreaker {
    const validatedConfig = CircuitBreakerConfigSchema.parse(config || {});
    
    const breaker = new CircuitBreaker(action, {
      timeout: validatedConfig.timeout,
      errorThresholdPercentage: validatedConfig.errorThresholdPercentage,
      resetTimeout: validatedConfig.resetTimeout,
    });

    breaker.fallback(fallback);

    // Instrument with structured logging
    breaker.on('open', () => {
      this.logger.error({ 
        breakerName: name, 
        state: 'open',
        threshold: validatedConfig.errorThresholdPercentage 
      }, 'Circuit breaker opened: Infrastructure failure threshold exceeded.');
    });

    breaker.on('halfOpen', () => {
      this.logger.warn({ 
        breakerName: name, 
        state: 'half-open' 
      }, 'Circuit breaker half-open: Probing infrastructure for recovery.');
    });

    breaker.on('close', () => {
      this.logger.info({ 
        breakerName: name, 
        state: 'close' 
      }, 'Circuit breaker closed: Infrastructure restored.');
    });

    breaker.on('timeout', () => {
      this.logger.warn({ 
        breakerName: name 
      }, 'Circuit breaker operation timed out.');
    });

    breaker.on('reject', () => {
      this.logger.error({ 
        breakerName: name 
      }, 'Circuit breaker rejected call due to open state.');
    });

    return breaker;
  }
}
