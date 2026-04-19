import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka, Producer, Consumer } from 'kafkajs';
import pino, { Logger } from 'pino';
import Opossum = require('opossum');
import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config, AppConfig } from './config';
import { createServer } from './server';

/**
 * Interface representing a component that can be gracefully shut down.
 * 
 * Used by the AppOrchestrator to manage the ordered and safe termination of
 * infrastructure connections (e.g., database pools, message bus clients).
 */
export interface GracefulShutdownComponent {
  /** A human-readable name for the component, used in logs. */
  name: string;
  /** An asynchronous function that performs the shutdown operation. */
  shutdown: () => Promise<void>;
}

/**
 * Context for the AppOrchestrator, holding initialized infrastructure clients.
 * 
 * This object is typically passed to the composition root and other setup
 * functions to provide access to shared infrastructure.
 */
export interface AppOrchestratorContext {
  /** The initialized PostgreSQL connection pool. */
  pgPool: Pool;
  /** The initialized ioredis client. */
  redisClient: Redis;
  /** The initialized Kafka producer. */
  kafkaProducer: Producer;
  /** The initialized Kafka consumer. */
  kafkaConsumer: Consumer;
  /** The Express application server. */
  httpServer: Express;
  /** The application's pino logger instance. */
  logger: Logger;
}

/**
 * AppOrchestrator is the central nervous system of the ecommerce backend.
 * 
 * It manages the entire application lifecycle, from the sequential initialization
 * of infrastructure (PostgreSQL, Redis, Kafka) to the coordination of
 * graceful shutdown during process termination signals (SIGTERM, SIGINT).
 * 
 * Key Responsibilities:
 * - Bootstrapping and connecting to all external dependencies.
 * - Configuring shared application settings (logging, REDACT rules).
 * - Managing global circuit breakers for system-wide resilience.
 * - Implementing a robust signal handling and shutdown mechanism.
 */
export class AppOrchestrator {
  private readonly logger: Logger;
  private readonly components: GracefulShutdownComponent[] = [];
  private pgPool: Pool | null = null;
  private redisClient: Redis | null = null;
  private kafkaProducer: Producer | null = null;
  private kafkaConsumer: Consumer | null = null;
  private httpServer: Express | null = null;
  private kafka: Kafka | null = null;
  // Use any to bypass TS namespace issue
  private readonly breakers: Map<string, any> = new Map();

  /**
   * Initializes the orchestrator and sets up core logging and signal handlers.
   */
  constructor() {
    this.logger = pino({
      level: config.LOG_LEVEL,
      redact: ['email', 'shipping_address', 'payment_token', 'password', 'credit_card'],
      formatters: { level: (label) => ({ level: label }) },
    });
    this.setupSignalHandlers();
  }

  /**
   * Initializes all infrastructure components in a strict, sequential order.
   * 
   * This method ensures that critical dependencies like PostgreSQL and Redis are
   * available before the HTTP server begins accepting traffic. If a critical
   * failure occurs during initialization, it triggers an emergency shutdown.
   * 
   * @returns A promise that resolves when initialization is complete.
   * @throws CRITICAL_INITIALIZATION_FAILURE if any essential component fails to connect.
   */
  public async initialize(): Promise<void> {
    this.logger.info('Starting AppOrchestrator initialization sequence...');

    try {
      await this.initPostgres();
      await this.initRedis();
      await this.initKafka();
      this.initCircuitBreakers();
      await this.initHttpServer();

      this.logger.info('AppOrchestrator initialized successfully.');
    } catch (error) {
      if (error instanceof Error) {
        this.logger.fatal({ msg: error.message, stack: error.stack }, 'CRITICAL_INITIALIZATION_FAILURE: Shutting down system');
      } else {
        this.logger.fatal({ error }, 'CRITICAL_INITIALIZATION_FAILURE: Shutting down system');
      }
      await this.shutdown();
      process.exit(1);
    }
  }

  /**
   * Initializes the PostgreSQL connection pool and registers it for shutdown.
   * 
   * @private
   */
  private async initPostgres(): Promise<void> {
    this.pgPool = new Pool({
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      max: config.DB_POOL_MAX,
      min: config.DB_POOL_MIN,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    try {
      await this.pgPool.query('SELECT 1');
      this.logger.info('PostgreSQL connection pool established.');
      this.registerShutdownComponent({
        name: 'PostgreSQL',
        shutdown: async () => {
          if (this.pgPool) await this.pgPool.end();
        },
      });
    } catch (error) {
      this.logger.error({ error }, 'Failed to connect to PostgreSQL');
      throw error;
    }
  }

  /**
   * Initializes the Redis connection and registers it for shutdown.
   * 
   * @private
   */
  private async initRedis(): Promise<void> {
    this.redisClient = new Redis(config.REDIS_URL, {
      retryStrategy: (times) => Math.min(times * 100, 3000),
      connectTimeout: config.REDIS_TIMEOUT,
    });

    try {
      await this.redisClient.ping();
      this.logger.info('Redis connection established.');
      this.registerShutdownComponent({
        name: 'Redis',
        shutdown: async () => {
          if (this.redisClient) await this.redisClient.quit();
        },
      });
    } catch (error) {
      this.logger.error({ error }, 'Failed to connect to Redis');
      throw error;
    }
  }

  /**
   * Initializes the Kafka client, producer, and consumer.
   * 
   * Provides a 'degraded mode' for non-production environments if Kafka is unavailable.
   * 
   * @private
   */
  private async initKafka(): Promise<void> {
    this.kafka = new Kafka({
      clientId: config.KAFKA_CLIENT_ID,
      brokers: config.KAFKA_BROKER_URL,
    });

    this.kafkaProducer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
    });
    this.kafkaConsumer = this.kafka.consumer({ groupId: config.KAFKA_GROUP_ID });

    try {
      await this.kafkaProducer.connect();
      await this.kafkaConsumer.connect();
      this.logger.info('Kafka infrastructure connected.');
      this.registerShutdownComponent({
        name: 'Kafka',
        shutdown: async () => {
          if (this.kafkaProducer) await this.kafkaProducer.disconnect();
          if (this.kafkaConsumer) await this.kafkaConsumer.disconnect();
        },
      });
    } catch (error) {
      this.logger.warn({ error }, 'Failed to connect to Kafka - continuing in degraded mode (non-production only)');
      if (config.NODE_ENV === 'production') {
        throw error;
      }
      
      this.registerShutdownComponent({
        name: 'Kafka (Degraded)',
        shutdown: async () => {
          if (this.kafkaProducer) await this.kafkaProducer.disconnect().catch(() => {});
          if (this.kafkaConsumer) await this.kafkaConsumer.disconnect().catch(() => {});
        },
      });
    }
  }

  /**
   * Initializes shared circuit breakers for core infrastructure services.
   * 
   * @private
   */
  private initCircuitBreakers(): void {
    const breakerOptions = {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    const breakerNames = ['database', 'cache', 'messaging'];
    breakerNames.forEach((name) => {
      const breaker = new Opossum(async (fn: any) => fn(), breakerOptions);
      breaker.on('open', () => this.logger.warn({ breaker: name }, 'Circuit breaker opened'));
      breaker.on('halfOpen', () => this.logger.info({ breaker: name }, 'Circuit breaker half-open'));
      breaker.on('close', () => this.logger.info({ breaker: name }, 'Circuit breaker closed'));
      this.breakers.set(name, breaker);
    });
  }

  /**
   * Boots the Express HTTP server by delegating to the server factory.
   * 
   * @private
   */
  private async initHttpServer(): Promise<void> {
    this.httpServer = await createServer({
      redis: this.redisClient!,
      db: this.pgPool!,
      kafka: this.kafka!,
      logger: this.logger
    });

    this.logger.info('HTTP Server initialized.');
    this.registerShutdownComponent({
        name: 'HTTPServer',
        shutdown: async () => {
          this.logger.info('Shutting down HTTP server.');
        }
    });
  }

  /**
   * Internal registry to track components that require cleanup during shutdown.
   * 
   * @param component - The component to register.
   * @private
   */
  private registerShutdownComponent(component: GracefulShutdownComponent): void {
    this.components.push(component);
  }

  /**
   * Binds process signal listeners for graceful termination.
   * 
   * @private
   */
  private setupSignalHandlers(): void {
    process.once('SIGTERM', () => this.handleShutdown('SIGTERM'));
    process.once('SIGINT', () => this.handleShutdown('SIGINT'));
  }

  /**
   * Executes the shutdown procedure for all registered components.
   * 
   * Components are shut down in the reverse order they were initialized to
   * ensure that dependencies are released safely.
   * 
   * @param signal - The signal or trigger that initiated the shutdown.
   * @private
   */
  private async handleShutdown(signal: string): Promise<void> {
    this.logger.info({ signal }, 'GRACEFUL_SHUTDOWN_INITIATED');
    
    const watchdog = setTimeout(() => {
      this.logger.fatal('SHUTDOWN_TIMEOUT_EXCEEDED: Forcing exit');
      process.exit(1);
    }, 30000);

    const reversedComponents = [...this.components].reverse();
    for (const component of reversedComponents) {
      try {
        this.logger.info({ component: component.name }, 'Shutting down component');
        await component.shutdown();
      } catch (error) {
        this.logger.error({ component: component.name, error }, 'Error during component shutdown');
      }
    }

    clearTimeout(watchdog);
    this.logger.info('SHUTDOWN_COMPLETE: Process exiting');
    process.exit(0);
  }

  /**
   * Publicly triggers a manual shutdown of the system.
   */
  public async shutdown(): Promise<void> {
    await this.handleShutdown('MANUAL');
  }

  /**
   * Retrieves the initialized application context.
   * 
   * @returns The AppOrchestratorContext.
   * @throws Error if core components have not been successfully initialized.
   */
  public getContext(): AppOrchestratorContext {
    if (!this.pgPool || !this.redisClient || !this.httpServer) {
        throw new Error('AppOrchestrator core components not initialized');
    }
    return {
      pgPool: this.pgPool,
      redisClient: this.redisClient,
      kafkaProducer: this.kafkaProducer!,
      kafkaConsumer: this.kafkaConsumer!,
      httpServer: this.httpServer,
      logger: this.logger,
    };
  }
}
