import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { register, Registry } from 'prom-client';
import { ProactiveHealthAuditor } from '../../../infrastructure/health/proactive_health_auditor';
import { DistributedObservabilityInstrumenter } from '../../../infrastructure/observability/instrumenter';

/**
 * OrderObservabilityController handles health checks and metrics exposure for the order service.
 * It is a stateless, singleton controller designed for high-concurrency environments.
 */
export class OrderObservabilityController {
  private readonly registry: Registry;

  constructor(
    private readonly healthAuditor: ProactiveHealthAuditor,
    private readonly instrumenter: DistributedObservabilityInstrumenter,
    private readonly logger: Logger
  ) {
    this.registry = register;
  }

  /**
   * Health Check endpoint. 
   * Returns:
   * 200 OK: System is UP.
   * 200 OK (with body status DEGRADED): System is DEGRADED.
   * 503 Service Unavailable: System is DOWN.
   */
  public async getHealth(req: Request, res: Response): Promise<void> {
    try {
      const healthStatus = await this.healthAuditor.checkReady();
      
      this.logger.info({ healthStatus }, 'Health check performed');

      let statusCode = 503;
      if (healthStatus.status === 'UP' || healthStatus.status === 'DEGRADED') {
        statusCode = 200;
      }

      res.status(statusCode).json(healthStatus);
    } catch (error) {
      this.logger.error({ error }, 'Health check internal failure');
      res.status(503).json({
        status: 'DOWN',
        components: {},
        timestamp: new Date().toISOString(),
        error: 'Service unavailable'
      });
    }
  }

  /**
   * Metrics endpoint.
   * Exposes Prometheus metrics and custom business-level instrumentation.
   */
  public async getMetrics(req: Request, res: Response): Promise<void> {
    try {
      res.set('Content-Type', this.registry.contentType);
      const metrics = await this.registry.metrics();
      res.status(200).send(metrics);
    } catch (error) {
      this.logger.error({ error }, 'Failed to gather metrics');
      res.status(500).send('Error gathering metrics');
    }
  }

  /**
   * Graceful shutdown handler to be hooked into the application lifecycle.
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down observability instrumentation');
    // Instrumentation shutdown is handled internally by the instrumenter
    // which listens to process signals as required by the spec.
  }
}
