/**
 * @fileoverview Domain types, interfaces, and error taxonomy for the Traffic and Resilience Middleware.
 * Provides the contract for rate limiting, circuit breaking, and error handling.
 */

import { z } from 'zod';

/**
 * Standard interface for diagnostic and observability context across the middleware.
 */
export interface ResilienceMetadata {
  correlation_id: string;
  timestamp: string;
  component_id: string;
}

/**
 * Base interface for custom resilience errors.
 */
export interface IResilienceError extends Error {
  code: string;
  correlation_id: string;
  metadata: ResilienceMetadata;
}

export abstract class BaseResilienceError extends Error implements IResilienceError {
  public abstract readonly code: string;
  public readonly correlation_id: string;
  public readonly metadata: ResilienceMetadata;

  constructor(message: string, correlation_id: string, component_id: string) {
    super(message);
    this.correlation_id = correlation_id;
    this.metadata = {
      correlation_id,
      timestamp: new Date().toISOString(),
      component_id,
    };
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RateLimitExceededError extends BaseResilienceError {
  public readonly code = 'RATE_LIMIT_EXCEEDED';
}

export class CircuitOpenError extends BaseResilienceError {
  public readonly code = 'CIRCUIT_OPEN';
}

export class ServiceUnavailableError extends BaseResilienceError {
  public readonly code = 'SERVICE_UNAVAILABLE';
}

export class InfrastructureError extends BaseResilienceError {
  public readonly code = 'INFRASTRUCTURE_ERROR';
}

/**
 * Configuration for distributed rate limiting.
 */
export const RateLimitConfigSchema = z.object({
  windowMs: z.number().int().positive(),
  maxRequests: z.number().int().positive(),
  prefix: z.string().default('rl:'),
  redisKey: z.string(),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

/**
 * Circuit breaker states.
 */
export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Configuration for Opossum-based circuit breakers.
 */
export const CircuitBreakerConfigSchema = z.object({
  timeout: z.number().int().positive().default(3000),
  errorThresholdPercentage: z.number().min(0).max(100).default(50),
  resetTimeout: z.number().int().positive().default(30000),
  delay: z.number().int().min(0).default(0),
});

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

/**
 * Defines a fallback strategy for generic protected actions.
 */
export interface FallbackStrategy<T, A extends any[]> {
  (err: Error, ...args: A): Promise<T>;
}

/**
 * Metadata for tracking state transition events in the resilience layer.
 */
export interface StateTransitionEvent {
  event_type: 'STATE_CHANGE' | 'ERROR' | 'FALLBACK_TRIGGERED';
  from_state?: CircuitBreakerState;
  to_state?: CircuitBreakerState;
  metadata: ResilienceMetadata;
  details: Record<string, unknown>;
}
