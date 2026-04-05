import { ZodSchema } from 'zod';

/**
 * Metadata for traceability and observability across distributed transactions.
 */
export interface EventMetadata {
  correlationId: string;
  timestamp: Date;
  sourceService: string;
}

/**
 * Standardized payload structure for all Kafka events.
 */
export interface EventPayload<T> {
  metadata: EventMetadata;
  data: T;
}

/**
 * Receipt returned after successful message production.
 */
export interface ProducerReceipt {
  topic: string;
  partition: number;
  offset: string;
  timestamp: string;
}

/**
 * Configuration for SASL/SSL credentials.
 */
export interface AuthProvider {
  saslUsername?: string;
  saslPassword?: string;
  sslCa?: string | Buffer;
}

/**
 * Handler interface for consuming events.
 */
export type IEventHandler<T> = (payload: EventPayload<T>) => Promise<void>;

/**
 * Producer interface for sending validated events.
 */
export interface IProducer<T> {
  initialize(): Promise<void>;
  connect(): Promise<void>;
  send(topic: string, payload: EventPayload<T>, schema: ZodSchema<T>): Promise<ProducerReceipt>;
  disconnect(): Promise<void>;
}

/**
 * Consumer interface for event subscription and lifecycle management.
 */
export interface IConsumer<T> {
  initialize(groupId: string): Promise<void>;
  connect(): Promise<void>;
  subscribe(topic: string, fromBeginning?: boolean): Promise<void>;
  poll(handler: IEventHandler<T>, schema: ZodSchema<T>): Promise<void>;
  commitOffset(topic: string, partition: number, offset: string): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Explicit lifecycle states for messaging components.
 */
export enum MessagingState {
  INITIALIZED = 'INITIALIZED',
  CONNECTED = 'CONNECTED',
  SUBSCRIBED = 'SUBSCRIBED',
  POLLING = 'POLLING',
  COMMITTING = 'COMMITTING',
  DISCONNECTED = 'DISCONNECTED',
  FAILED = 'FAILED',
}
