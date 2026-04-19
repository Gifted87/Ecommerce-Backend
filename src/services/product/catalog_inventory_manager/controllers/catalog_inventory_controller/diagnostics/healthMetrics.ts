import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka, Admin } from 'kafkajs';
import Opossum = require('opossum');
import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import { z } from 'zod';
import pino from 'pino';

/**
 * @fileoverview Health and Metrics Diagnostics Module
 * Implements health probes (liveness, readiness) and metrics instrumentation.
 */

const logger = pino({ name: 'DiagnosticsModule' });

// --- Schemas & Types ---

export const HealthStatusSchema = z.object({
  status: z.enum(['UP', 'DOWN', 'DEGRADED']),
  components: z.record(z.object({
    status: z.enum(['UP', 'DOWN']),
    message: z.string().optional()
  }))
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

// --- Metrics Configuration ---

export const metricsRegistry = new Registry();

export const requestCounter = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry]
});

export const requestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['route'],
  registers: [metricsRegistry]
});

export const eventLoopLag = new Gauge({
  name: 'nodejs_eventloop_lag_seconds',
  help: 'Event loop lag in seconds',
  registers: [metricsRegistry]
});

// --- Diagnostics Service ---

export class HealthMonitorService {
  // Use any to bypass TS namespace issue
  private readonly breakers: Record<string, any>;

  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly kafka: Kafka
  ) {
    const breakerOptions = {
      timeout: 2000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000
    };

    this.breakers = {
      postgres: new Opossum(async () => await this.checkPostgres(), breakerOptions),
      redis: new Opossum(async () => await this.checkRedis(), breakerOptions),
      kafka: new Opossum(async () => await this.checkKafka(), breakerOptions)
    };

    this.startEventLoopMonitor();
  }

  private async checkPostgres(): Promise<void> {
    await this.db.query('SELECT 1');
  }

  private async checkRedis(): Promise<void> {
    await this.redis.ping();
  }

  private async checkKafka(): Promise<void> {
    const admin: Admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.listTopics();
    } finally {
      await admin.disconnect();
    }
  }

  private startEventLoopMonitor(): void {
    let lastTime = Date.now();
    setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - lastTime - 1000) / 1000;
      eventLoopLag.set(lag);
      lastTime = now;
    }, 1000).unref();
  }

  /**
   * Executes deep health check of all infrastructure components.
   * @returns {Promise<HealthStatus>}
   * @throws {Error} If critical health monitoring logic fails.
   */
  public async checkReady(): Promise<HealthStatus> {
    const results = await Promise.allSettled([
      this.breakers.postgres.fire(),
      this.breakers.redis.fire(),
      this.breakers.kafka.fire()
    ]);

    const components: Record<string, { status: 'UP' | 'DOWN', message?: string }> = {
      postgres: results[0].status === 'fulfilled' ? { status: 'UP' } : { status: 'DOWN', message: (results[0] as PromiseRejectedResult).reason.message },
      redis: results[1].status === 'fulfilled' ? { status: 'UP' } : { status: 'DOWN', message: (results[1] as PromiseRejectedResult).reason.message },
      kafka: results[2].status === 'fulfilled' ? { status: 'UP' } : { status: 'DOWN', message: (results[2] as PromiseRejectedResult).reason.message }
    };

    const isAllUp = Object.values(components).every(c => c.status === 'UP');
    const isAnyDown = Object.values(components).some(c => c.status === 'DOWN');

    const status: HealthStatus['status'] = isAllUp ? 'UP' : (isAnyDown ? 'DOWN' : 'DEGRADED');

    return { status, components };
  }

  /**
   * Performs a lightweight check of the process responsiveness.
   */
  public async checkLive(): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      setImmediate(() => {
        const duration = Date.now() - start;
        resolve(duration < 200);
      });
    });
  }
}
