import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka, Producer, Consumer } from 'kafkajs';
import pino, { Logger } from 'pino';
import CircuitBreaker from 'opossum';
import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config, AppConfig } from '../config/config';

/**
 * Interface representing a component that can be gracefully shut down.
 */
export interface GracefulShutdownComponent {
  name: string;
  shutdown: () => Promise<void>;
}

/**
 * Context for the AppOrchestrator, holding initialized infrastructure clients.
 */
export interface AppOrchestratorContext {
  pgPool: Pool;
  redisClient: Redis;
  kafkaProducer: Producer;
  kafkaConsumer: Consumer;
  httpServer: Express;
  logger: Logger;
}

/**
 * AppOrchestrator is the central nervous system of the ecommerce backend.
 * Manages infrastructure lifecycle, fault tolerance, and graceful shutdown.
 */
export class AppOrchestrator {
  private readonly logger: Logger;
  private readonly components: GracefulShutdownComponent[] = [];
  private pgPool: Pool | null = null;
  private redisClient: Redis | null = null;
  private kafkaProducer: Producer | null = null;
  private kafkaConsumer: Consumer | null = null;
  private httpServer: Express | null = null;
  private readonly breakers: Map<string, CircuitBreaker> = new Map();

  constructor() {
    this.logger = pino({
      level: config.LOG_LEVEL,
      redact: ['email', 'shipping_address', 'payment_token', 'password', 'credit_card'],
      formatters: { level: (label) => ({ level: label }) },
    });
    this.setupSignalHandlers();
  }

  /**
   * Initializes infrastructure components in a strict, sequential order.
   */
  public async initialize(): Promise<void> {
    this.logger.info('Starting AppOrchestrator initialization sequence...');

    try {
      await this.initPostgres();
      await this.initRedis();
      await this.initKafka();
      this.initCircuitBreakers();
      this.initHttpServer();

      this.logger.info('AppOrchestrator initialized successfully.');
    } catch (error) {
      this.logger.fatal({ error }, 'CRITICAL_INITIALIZATION_FAILURE: Shutting down system');
      await this.shutdown();
      process.exit(1);
    }
  }

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

  private async initKafka(): Promise<void> {
    const kafka = new Kafka({
      clientId: config.KAFKA_CLIENT_ID,
      brokers: config.KAFKA_BROKER_URL,
    });

    this.kafkaProducer = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
    });
    this.kafkaConsumer = kafka.consumer({ groupId: config.KAFKA_GROUP_ID });

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
      this.logger.error({ error }, 'Failed to connect to Kafka');
      throw error;
    }
  }

  private initCircuitBreakers(): void {
    const breakerOptions = {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };

    const breakerNames = ['database', 'cache', 'messaging'];
    breakerNames.forEach((name) => {
      const breaker = new CircuitBreaker(async (fn: any) => fn(), breakerOptions);
      breaker.on('open', () => this.logger.warn({ breaker: name }, 'Circuit breaker opened'));
      breaker.on('halfOpen', () => this.logger.info({ breaker: name }, 'Circuit breaker half-open'));
      breaker.on('close', () => this.logger.info({ breaker: name }, 'Circuit breaker closed'));
      this.breakers.set(name, breaker);
    });
  }

  private initHttpServer(): void {
    this.httpServer = express();
    this.httpServer.use(helmet());
    this.httpServer.use(cors());
    this.httpServer.use(express.json());
    
    // Simple health check endpoint
    this.httpServer.get('/health', (req, res) => {
      res.status(200).json({ status: 'UP' });
    });

    this.logger.info('HTTP Server initialized.');
    this.registerShutdownComponent({
        name: 'HTTPServer',
        shutdown: async () => {
          this.logger.info('Shutting down HTTP server.');
        }
    });
  }

  private registerShutdownComponent(component: GracefulShutdownComponent): void {
    this.components.push(component);
  }

  private setupSignalHandlers(): void {
    process.once('SIGTERM', () => this.handleShutdown('SIGTERM'));
    process.once('SIGINT', () => this.handleShutdown('SIGINT'));
  }

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

  public async shutdown(): Promise<void> {
    await this.handleShutdown('MANUAL');
  }
}
