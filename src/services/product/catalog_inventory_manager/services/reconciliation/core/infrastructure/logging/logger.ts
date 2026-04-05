import pino, { Logger, LoggerOptions } from 'pino';
import os from 'os';

/**
 * @fileoverview Centralized, high-performance structured logging service
 * for the reconciliation inventory system. Implements PII redaction,
 * asynchronous JSON serialization, and hierarchical context injection.
 */

/**
 * List of sensitive keys that must be redacted from all log outputs
 * to ensure compliance with PII/security requirements.
 */
const REDACTED_KEYS = [
  'password',
  'credit_card',
  'authorization',
  'token',
  'cookie',
  'set-cookie',
  'secret',
  'access_token',
  'refresh_token',
  'cvv'
];

/**
 * Pino configuration with production-ready defaults.
 * Configured for non-blocking, asynchronous JSON output.
 */
const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: REDACTED_KEYS,
    censor: '[REDACTED]'
  },
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    pid: process.pid,
    hostname: os.hostname(),
    service: 'reconciliation-service'
  },
  errorKey: 'error',
  serializers: {
    error: pino.stdSerializers.err,
  },
};

/**
 * Root logger instance singleton.
 */
const rootLogger: Logger = pino(loggerOptions);

/**
 * Interface defining the mandatory and optional metadata for logs.
 * All logs must include a 'module' context for granular filtering.
 */
export interface LogContext {
  module: string;
  requestId?: string;
  sku?: string;
  batchProcessId?: string;
  [key: string]: any;
}

/**
 * Creates a child logger with injected hierarchical context.
 * Useful for distributed tracing and module-level debugging across
 * the reconciliation pipeline.
 *
 * @param context - The metadata object containing 'module' and additional context keys.
 * @returns A pino logger instance containing the injected context.
 * @throws Error if context.module is missing.
 */
export const createLogger = (context: LogContext): Logger => {
  if (!context || typeof context.module !== 'string') {
    throw new Error('Logger context must include a "module" property for structured traceability.');
  }
  return rootLogger.child(context);
};

/**
 * Default logger instance for global usage across the reconciliation service.
 */
const logger: Logger = rootLogger.child({ module: 'global' });

export default logger;
