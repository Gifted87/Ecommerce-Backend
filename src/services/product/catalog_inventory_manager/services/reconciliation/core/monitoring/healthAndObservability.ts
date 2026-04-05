import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import Opossum from 'opossum';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';
import logger from '../logging/logger';

/**
 * @fileoverview Health and Observability Module
 * Implements Proactive Health Auditor (PHA) and Distributed Observability Instrumenter (DOI).
 */

// --- Schemas & Types ---

const HealthSchema = z.object({
  status: z.enum(['UP', 'DOWN', 'DEGRADED']),
  components: z.record(z.object({
    status: z.enum(['UP', 'DOWN']),
    message: z.string().optional()
  }))
});

export type HealthStatus = z.infer<typeof HealthSchema>;

// --- Proactive Health Auditor (PHA) ---

export class ProactiveHealthAuditor {
  private readonly breaker: Opossum;

  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
    private readonly kafka: Kafka
  ) {
    const breakerOptions = {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000
    };

    this.breaker = new Opossum(async () => {
      return await this.performDeepCheck();
    }, breakerOptions);
  }

  private async performDeepCheck(): Promise<HealthStatus> {
    const components: Record<string, { status: 'UP' | 'DOWN'; message?: string }> = {};

    // DB Check
    try {
      await this.db.query('SELECT 1');
      components.postgres = { status: 'UP' };
    } catch (e) {
      components.postgres = { status: 'DOWN', message: (e as Error).message };
    }

    // Redis Check
    try {
      await this.redis.ping();
      components.redis = { status: 'UP' };
    } catch (e) {
      components.redis = { status: 'DOWN', message: (e as Error).message };
    }

    // Kafka Check
    try {
      const admin = this.kafka.admin();
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      components.kafka = { status: 'UP' };
    } catch (e) {
      components.kafka = { status: 'DOWN', message: (e as Error).message };
    }

    const allUp = Object.values(components).every(c => c.status === 'UP');
    const anyDown = Object.values(components).some(c => c.status === 'DOWN');

    return {
      status: allUp ? 'UP' : (anyDown ? 'DOWN' : 'DEGRADED'),
      components
    };
  }

  async checkReady(): Promise<HealthStatus> {
    try {
      return await this.breaker.fire();
    } catch (e) {
      logger.error({ module: 'health', error: e }, 'Health readiness check failed');
      return { status: 'DOWN', components: {} };
    }
  }

  async checkLive(): Promise<boolean> {
    // Basic event loop lag check
    const start = Date.now();
    await new Promise(resolve => setImmediate(resolve));
    const duration = Date.now() - start;
    return duration < 100; // If event loop takes > 100ms, mark as unresponsive
  }
}

// --- Distributed Observability Instrumenter (DOI) ---

export class DistributedObservabilityInstrumenter {
  private sdk: NodeSDK;

  constructor(serviceName: string, otlpEndpoint: string) {
    this.sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      }),
      traceExporter: new OTLPTraceExporter({
        url: otlpEndpoint,
      }),
      spanProcessor: new SimpleSpanProcessor(new OTLPTraceExporter({ url: otlpEndpoint })),
    });
  }

  start(): void {
    this.sdk.start();
    process.on('SIGTERM', () => {
      this.sdk.shutdown()
        .then(() => logger.info({ module: 'observability' }, 'Tracing SDK shut down'))
        .catch(err => logger.error({ module: 'observability', error: err }, 'Error shutting down tracing SDK'));
    });
  }
}
