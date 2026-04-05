import { Pool } from 'pg';
import Redis, { Cluster } from 'ioredis';
import { Kafka, Producer } from 'kafkajs';
import CircuitBreaker from 'opossum';
import { z } from 'zod';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'KAFKA_SASL_PASSWORD']
});

// --- Configuration Validation ---
const InfrastructureConfigSchema = z.object({
  POSTGRES_URL: z.string().url(),
  POSTGRES_MAX_POOL: z.coerce.number().default(20),
  REDIS_NODES: z.string().default('127.0.0.1:6379'),
  REDIS_PASSWORD: z.string().optional(),
  KAFKA_BROKERS: z.string().transform((val) => val.split(',')),
  KAFKA_CLIENT_ID: z.string().default('ecommerce-backend'),
  KAFKA_BOOTSTRAP_TOPIC: z.string().default('health-check'),
});

const config = InfrastructureConfigSchema.parse(process.env);

// --- Custom Error Types ---
class FatalStartupError extends Error {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'FatalStartupError';
  }
}

// --- Infrastructure Instances ---
let pgPool: Pool;
let redisClient: Redis | Cluster;
let kafkaProducer: Producer;

// --- Circuit Breakers ---
const breakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
};

const pgBreaker = new CircuitBreaker(async (query: string) => await pgPool.query(query), breakerOptions);
const redisBreaker = new CircuitBreaker(async (cmd: string, ...args: any[]) => (redisClient as any)[cmd](...args), breakerOptions);
const kafkaBreaker = new CircuitBreaker(async (payload: any) => await kafkaProducer.send(payload), breakerOptions);

// Attach logging to breakers
[pgBreaker, redisBreaker, kafkaBreaker].forEach((b, i) => {
  const name = ['Postgres', 'Redis', 'Kafka'][i];
  b.on('open', () => logger.error({ component: name }, 'Circuit breaker opened'));
  b.on('halfOpen', () => logger.warn({ component: name }, 'Circuit breaker half-open'));
  b.on('close', () => logger.info({ component: name }, 'Circuit breaker closed'));
});

// --- Initialization Logic ---
async function initializePostgres() {
  pgPool = new Pool({
    connectionString: config.POSTGRES_URL,
    max: config.POSTGRES_MAX_POOL,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pgPool.query('SELECT 1');
      logger.info('Postgres connected');
      return;
    } catch (err) {
      if (i === maxRetries - 1) throw new FatalStartupError('Postgres connection failed', err);
      const delay = Math.pow(2, i) * 1000;
      logger.warn({ attempt: i + 1, delay }, 'Postgres connection failed, retrying...');
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

async function initializeRedis() {
  const nodes = config.REDIS_NODES.split(',').map(node => {
    const [host, port] = node.split(':');
    return { host, port: parseInt(port, 10) };
  });

  const options = {
    password: config.REDIS_PASSWORD,
    retryStrategy: (times: number) => Math.min(times * 1000, 30000),
  };

  redisClient = nodes.length > 1 ? new Cluster(nodes, { redisOptions: options }) : new Redis({ ...options, ...nodes[0] });

  try {
    await redisClient.ping();
    logger.info('Redis connected');
  } catch (err) {
    throw new FatalStartupError('Redis connection failed', err);
  }
}

async function initializeKafka() {
  const kafka = new Kafka({
    clientId: config.KAFKA_CLIENT_ID,
    brokers: config.KAFKA_BROKERS,
  });

  kafkaProducer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
  });

  try {
    await kafkaProducer.connect();
    // Verify by fetching metadata
    await kafka.admin().connect();
    await kafka.admin().fetchTopicMetadata({ topics: [config.KAFKA_BOOTSTRAP_TOPIC] });
    await kafka.admin().disconnect();
    logger.info('Kafka connected');
  } catch (err) {
    throw new FatalStartupError('Kafka connection failed', err);
  }
}

// --- Bootstrap ---
export const initializeInfrastructure = async () => {
  try {
    await Promise.all([initializePostgres(), initializeRedis(), initializeKafka()]);
  } catch (err) {
    logger.error({ err }, 'Infrastructure initialization failed');
    process.exit(1);
  }
};

export const shutdownInfrastructure = async () => {
  logger.info('Shutting down infrastructure...');
  await Promise.allSettled([
    pgPool.end(),
    redisClient.quit(),
    kafkaProducer.disconnect(),
  ]);
  logger.info('Infrastructure shutdown complete');
};

export { pgPool, redisClient, kafkaProducer, pgBreaker, redisBreaker, kafkaBreaker };
