import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import CircuitBreaker from 'opossum';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Singleton database client wrapper for production-grade operations.
 * Handles Prisma (PostgreSQL) and ioredis (Redis) with resilience, circuit breakers,
 * and observability.
 */

// --- Prisma Initialization ---
const prismaOptions = {
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'stdout', level: 'warn' },
  ],
  datasources: {
    db: {
      url: process.env.DATABASE_URL || '',
    },
  },
};

export const prisma = new PrismaClient(prismaOptions);

// @ts-ignore
prisma.$on('query', (e: any) => {
  if (e.duration > parseInt(process.env.QUERY_THRESHOLD_MS || '500', 10)) {
    logger.warn({
      query: e.query,
      params: e.params,
      duration: e.duration,
      correlationId: 'N/A', // Middleware to inject via AsyncLocalStorage
    }, 'Slow Query Detected');
  }
});

// --- Redis Initialization ---
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  tls: {
    rejectUnauthorized: true,
  },
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

export const redis = new Redis(redisConfig);

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
  // Logic to report unhealthy status to heartbeat monitor would be called here
});

redis.on('connect', () => {
  logger.info('Redis connected successfully');
});

// --- Resilience / Circuit Breaker Layer ---
const breakerOptions = {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
};

export const queryBreaker = new CircuitBreaker(async (queryFn: () => Promise<any>) => {
  return await queryFn();
}, breakerOptions);

queryBreaker.on('open', () => logger.error('Database circuit breaker opened'));
queryBreaker.on('halfOpen', () => logger.warn('Database circuit breaker half-open'));
queryBreaker.on('close', () => logger.info('Database circuit breaker closed'));

/**
 * Executes a database operation within a strict ACID transaction.
 * Ensures robust error handling and observability.
 */
export async function executeInTransaction<T>(work: (client: any) => Promise<T>): Promise<T> {
  return await prisma.$transaction(async (tx) => {
    try {
      return await work(tx);
    } catch (error) {
      logger.error({ error }, 'Transaction failed');
      throw error;
    }
  });
}

/**
 * Deep check for connectivity at service startup.
 */
export async function checkConnectivity(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info('Database health check passed');
  } catch (error) {
    logger.fatal('Database connectivity failed');
    process.exit(1);
  }

  try {
    await redis.ping();
    logger.info('Redis health check passed');
  } catch (error) {
    logger.fatal('Redis connectivity failed');
    process.exit(1);
  }
}
