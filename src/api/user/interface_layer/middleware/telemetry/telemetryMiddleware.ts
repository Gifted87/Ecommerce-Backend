import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pino, { Logger } from 'pino';
import os from 'os';

/**
 * @fileoverview Telemetry Middleware for the complex ecommerce backend.
 * Enforces distributed tracing via x-correlation-id, structured logging via Pino,
 * and PII redaction for security compliance.
 */

// Configuration loaded from environment variables
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const REDACTED_KEYS = (process.env.REDACTED_KEYS || 'password,authorization,token,cookie,set-cookie,secret,cvv').split(',');

/**
 * Root logger instance configured for asynchronous, structured JSON output.
 */
const rootLogger: Logger = pino({
  level: LOG_LEVEL,
  redact: {
    paths: REDACTED_KEYS,
    censor: '[REDACTED]',
  },
  base: {
    pid: process.pid,
    hostname: os.hostname(),
    service: 'ecommerce-backend',
  },
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Middleware function for request telemetry.
 * Captures request ingress, assigns correlation IDs, and logs exit points with performance metrics.
 */
export const telemetryMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = process.hrtime();

  // 1. Correlation ID management
  const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
  req.headers['x-correlation-id'] = correlationId;

  // 2. Child logger with correlation metadata
  const reqLogger = rootLogger.child({
    correlationId,
    method: req.method,
    url: req.url,
  });

  // Attach logger to request object for downstream usage
  (req as any).log = reqLogger;

  // 3. Response header injection
  res.setHeader('x-correlation-id', correlationId);

  // 4. Capture exit point (Response completion)
  res.on('finish', () => {
    const diff = process.hrtime(startTime);
    const durationMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(3);

    const logMetadata = {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs,
      userId: (req as any).user?.id,
    };

    if (res.statusCode >= 400) {
      reqLogger.warn(logMetadata, 'Request Completed with Error/Warning');
    } else {
      reqLogger.info(logMetadata, 'Request Processed Successfully');
    }
  });

  // Handle unexpected request termination
  res.on('error', (err: Error) => {
    reqLogger.error({ err }, 'Request Stream Error');
  });

  next();
};
