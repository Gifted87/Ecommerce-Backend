import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka, Producer, Consumer } from 'kafkajs';
import pino, { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import { EventEmitter } from 'events';

/**
 * PII Redaction Middleware for Pino.
 */
const redactPaths = ['email', 'shipping_address', 'payment_token', 'password', 'credit_card'];
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * Service Orchestrator for Catalog and Inventory Management.
 * Manages infrastructure lifecycle, fault tolerance, and graceful shutdown.
 */
export class ServiceOrchestrator extends EventEmitter {
  private pgPool: Pool | null = null;
  private redisClient: Redis | null = null;
  private kafkaProducer: Producer | null = null;
  private kafkaConsumer: Consumer | null = null;
  private readonly logger: Logger = logger;

  private readonly breakers: Map<string, CircuitBreaker> = new Map();

  constructor() {
    super();
    this.setupSignalHandlers();
  }

  /**
   * Initializes all infrastructure components in a deterministic sequence.
   */
  public async initialize(): Promise<void> {
    this.logger.info('Starting service orchestration...');

    try {
      // 1. PostgreSQL Initialization
      this.pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
      await this.pgPool.query('SELECT 1');
      this.logger.info('PostgreSQL connection pool established.');

      // 2. Redis Initialization
      this.redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
        retryStrategy: (times) => Math.min(times * 50, 2000),
      });
      await this.redisClient.ping();
      this.logger.info('Redis cluster connection established.');

      // 3. Kafka Initialization
      const kafka = new Kafka({
        clientId: 'catalog-inventory-service',
        brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      });
      this.kafkaProducer = kafka.producer();
      await this.kafkaProducer.connect();
      this.logger.info('Kafka producer connected.');

      this.kafkaConsumer = kafka.consumer({ groupId: 'catalog-inventory-group' });
      await this.kafkaConsumer.connect();
      this.logger.info('Kafka consumer connected.');

      // 4. Initialize Circuit Breakers
      this.initializeBreakers();

      this.logger.info('Service orchestration initialized successfully.');
    } catch (error) {
      this.logger.error({ msg: 'Initialization failed', error: error instanceof Error ? error.message : String(error) });
      await this.shutdown();
      throw error;
    }
  }

  private initializeBreakers(): void {
    const breakerOptions = {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    this.breakers.set('redis', new CircuitBreaker(async (fn: Function) => fn(), { ...breakerOptions }));
    this.breakers.set('kafka', new CircuitBreaker(async (fn: Function) => fn(), { ...breakerOptions }));
    this.breakers.set('db', new CircuitBreaker(async (fn: Function) => fn(), { ...breakerOptions, timeout: 5000 }));
  }

  private setupSignalHandlers(): void {
    process.on('SIGTERM', () => this.handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => this.handleShutdownSignal('SIGINT'));
  }

  private async handleShutdownSignal(signal: string): Promise<void> {
    this.logger.info({ signal }, 'Received shutdown signal.');
    await this.shutdown();
    process.exit(0);
  }

  /**
   * Graceful shutdown sequence.
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Starting graceful shutdown...');

    try {
      // 1. Stop consuming Kafka
      if (this.kafkaConsumer) {
        await this.kafkaConsumer.disconnect();
        this.logger.info('Kafka consumer disconnected.');
      }

      // 2. Close Producer
      if (this.kafkaProducer) {
        await this.kafkaProducer.disconnect();
        this.logger.info('Kafka producer disconnected.');
      }

      // 3. Close Redis
      if (this.redisClient) {
        await this.redisClient.quit();
        this.logger.info('Redis connection closed.');
      }

      // 4. Close Postgres Pool
      if (this.pgPool) {
        await this.pgPool.end();
        this.logger.info('Postgres pool drained and closed.');
      }
    } catch (error) {
      this.logger.error({ msg: 'Error during shutdown', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.logger.info('Service shutdown complete.');
    }
  }

  /**
   * Health check endpoint probe implementation.
   */
  public async getStatus(): Promise<{ status: string; components: Record<string, string> }> {
    const status = {
      status: 'ok',
      components: {
        postgres: this.pgPool ? 'connected' : 'disconnected',
        redis: this.redisClient?.status === 'ready' ? 'connected' : 'disconnected',
        kafka: this.kafkaProducer ? 'connected' : 'disconnected',
      },
    };

    if (Object.values(status.components).includes('disconnected')) {
      status.status = 'degraded';
    }

    return status;
  }
}
