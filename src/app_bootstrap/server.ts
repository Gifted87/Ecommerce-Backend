import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'pino';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { handleDomainError } from '../middleware/error_handler';
import logger from '../utils/logger';

/**
 * @fileoverview Server Bootstrap Module.
 * Configures and initializes the production-grade Express application with
 * essential security, observability, and infrastructure dependencies.
 */

export interface ServerDependencies {
  redis: Redis;
  db: Pool;
  logger: Logger;
}

/**
 * Configures the Express application pipeline.
 * Ensures security headers, rate limiting, correlation tracing, and error handling.
 * 
 * @param deps - Injected infrastructure dependencies.
 * @returns {Express} The configured Express application.
 */
export const createServer = (deps: ServerDependencies): Express => {
  const app = express();

  // 1. Security: Helmet for standard HTTP headers mitigation
  app.use(helmet());

  // 2. Security: CORS Policy - Restrict origins to production/configured environments
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  }));

  // 3. Security: Global Rate Limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // limit each IP to 1000 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'error', error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later.' } },
  });
  app.use(limiter);

  // Parse JSON bodies with limit to prevent denial-of-service
  app.use(express.json({ limit: '10kb' }));

  // 4. Observability: Correlation ID Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  });

  // Health check endpoint (bypasses business logic, strictly infrastructure)
  app.get('/health', async (req: Request, res: Response) => {
    try {
      await deps.redis.ping();
      await deps.db.query('SELECT 1');
      res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (error) {
      deps.logger.error({ error }, 'Health check failed');
      res.status(503).json({ status: 'error', message: 'Infrastructure unhealthy' });
    }
  });

  // 5. Global Error Handling (Must be defined last)
  app.use(handleDomainError);

  return app;
};

/**
 * Initiates the server and manages graceful shutdown.
 * 
 * @param app - The configured Express application.
 * @param port - Port to listen on.
 * @param deps - Dependencies for finalization.
 */
export const startServer = (app: Express, port: number, deps: ServerDependencies): void => {
  const server = app.listen(port, () => {
    logger.info({ port }, 'Server initiated and listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received. Starting graceful shutdown...');
    
    server.close(async () => {
      try {
        await deps.redis.quit();
        await deps.db.end();
        logger.info('Infrastructure connections closed successfully.');
        process.exit(0);
      } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};
