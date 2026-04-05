/**
 * @fileoverview Definitive type contract for the application lifecycle.
 * Provides strictly enforced interfaces for dependency injection, infrastructure state management,
 * and system observability in a high-concurrency, production-grade ecommerce backend.
 */

import { Pool } from 'pg';
import { Cluster } from 'ioredis';
import { Producer, Consumer } from 'kafkajs';
import { EventEmitter } from 'events';
import { Logger } from 'pino';

// --- Opaque Types for Security ---
export type Token = string & { readonly __brand: unique symbol };
export type Secret = string & { readonly __brand: unique symbol };

// --- Lifecycle & System States ---
export enum ClientStatus {
  INITIALIZING = 'INITIALIZING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR',
  DISCONNECTED = 'DISCONNECTED',
}

export type LifecycleStage = Promise<void>;

export interface HealthCheckMetadata {
  last_check_at: string;
  latency_ms: number;
  error?: string;
}

export interface ClientInstance<T> {
  instance: T;
  status: ClientStatus;
  metadata: HealthCheckMetadata;
}

// --- Error Taxonomy ---
export interface IAppError extends Error {
  code: string;
  is_transient: boolean;
  correlation_id: string;
}

export class TransientError extends Error implements IAppError {
  public readonly is_transient = true;
  constructor(public readonly code: string, message: string, public readonly correlation_id: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class FatalError extends Error implements IAppError {
  public readonly is_transient = false;
  constructor(public readonly code: string, message: string, public readonly correlation_id: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// --- Observability & Context ---
export interface RequestContext {
  correlation_id: string;
}

// --- Infrastructure Containers ---
export interface InfrastructureClients {
  db: ClientInstance<Pool>;
  cache: {
    master: ClientInstance<Cluster>;
    replicas: ClientInstance<Cluster>[];
  };
  events: {
    producer: ClientInstance<Producer>;
    consumer: ClientInstance<Consumer>;
  };
}

// --- Application Context Interface ---
export interface ApplicationContext {
  readonly logger: Logger;
  readonly config: Record<string, unknown>;
  readonly clients: InfrastructureClients;
  readonly lifecycle: EventEmitter;
}

// --- Dependency Injection Contract ---
export interface IService {
  /**
   * Services must be instantiated with the immutable application context
   * to ensure no direct bypass of the infrastructure layer.
   */
  readonly context: ApplicationContext;
}

/**
 * Factory type for initializing services.
 */
export type ServiceFactory<T extends IService> = (context: ApplicationContext) => T;
