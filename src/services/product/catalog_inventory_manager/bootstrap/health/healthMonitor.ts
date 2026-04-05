import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka, Admin } from 'kafkajs';
import Opossum from 'opossum';
import { z } from 'zod';
import pino from 'pino';

/**
 * @fileoverview Central Health Monitoring Module
 * Implements Proactive Health Auditor (PHA) for infrastructure dependency monitoring.
 */

const logger = pino({ name: 'HealthMonitor' });

export const HealthStatusSchema = z.object({
  status: z.enum(['UP', 'DOWN', 'DEGRADED']),
  components: z.record(z.object({
    status: z.enum(['UP', 'DOWN']),
    message: z.string().optional()
  })),
  timestamp: z.string()
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export interface IHealthProbe {
  check(): Promise<void>;
  getName(): string;
}

class PostgresProbe implements IHealthProbe {
  constructor(private db: Pool) {}
  getName() { return 'postgres'; }
  async check(): Promise<void> {
    await this.db.query('SELECT 1');
  }
}

class RedisProbe implements IHealthProbe {
  constructor(private redis: Redis) {}
  getName() { return 'redis'; }
  async check(): Promise<void> {
    await this.redis.ping();
  }
}

class KafkaProbe implements IHealthProbe {
  constructor(private kafka: Kafka) {}
  getName() { return 'kafka'; }
  async check(): Promise<void> {
    const admin: Admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.listTopics();
    } finally {
      await admin.disconnect();
    }
  }
}

export class HealthMonitorService {
  private readonly breakers: Map<string, Opossum> = new Map();
  private readonly probes: IHealthProbe[] = [];
  private eventLoopLag: number = 0;

  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly kafka: Kafka
  ) {
    this.probes.push(new PostgresProbe(this.db));
    this.probes.push(new RedisProbe(this.redis));
    this.probes.push(new KafkaProbe(this.kafka));

    const breakerOptions = {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000
    };

    for (const probe of this.probes) {
      const breaker = new Opossum(async () => await probe.check(), breakerOptions);
      breaker.on('open', () => logger.error({ component: probe.getName() }, 'Circuit breaker opened'));
      breaker.on('close', () => logger.info({ component: probe.getName() }, 'Circuit breaker closed'));
      this.breakers.set(probe.getName(), breaker);
    }

    this.startEventLoopMonitor();
  }

  private startEventLoopMonitor(): void {
    let lastTime = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      const delta = now - lastTime;
      this.eventLoopLag = Math.max(0, delta - 1000);
      lastTime = now;
    }, 1000);
    interval.unref();
  }

  public async checkReady(): Promise<HealthStatus> {
    const componentResults = await Promise.allSettled(
      this.probes.map(async (probe) => {
        const breaker = this.breakers.get(probe.getName());
        if (!breaker) throw new Error(`Breaker not found for ${probe.getName()}`);
        await breaker.fire();
        return { name: probe.getName(), status: 'UP' as const };
      })
    );

    const components: Record<string, { status: 'UP' | 'DOWN', message?: string }> = {};

    componentResults.forEach((result, index) => {
      const name = this.probes[index].getName();
      if (result.status === 'fulfilled') {
        components[name] = { status: 'UP' };
      } else {
        components[name] = { status: 'DOWN', message: result.reason.message };
        logger.error({ component: name, error: result.reason }, 'Health check failed');
      }
    });

    const isAllUp = Object.values(components).every(c => c.status === 'UP');
    const isAnyDown = Object.values(components).some(c => c.status === 'DOWN');

    return {
      status: isAllUp ? 'UP' : (isAnyDown ? 'DOWN' : 'DEGRADED'),
      components,
      timestamp: new Date().toISOString()
    };
  }

  public async checkLive(): Promise<boolean> {
    // If event loop lag is > 200ms, service is effectively deadlocked/unresponsive
    return this.eventLoopLag < 200;
  }
}
