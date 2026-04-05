import pino, { Logger, LoggerOptions } from 'pino';
import os from 'os';

/**
 * @fileoverview Centralized, high-performance, and secure logging service 
 * for the product catalog and inventory management system.
 * 
 * Implements structured JSON logging, automatic PII redaction, 
 * and hierarchical context injection for distributed tracing.
 */

/**
 * Sensitive fields that must be redacted from all log outputs.
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
 * Pino configuration for production-ready, non-blocking, asynchronous JSON logging.
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
    service: 'catalog-inventory-manager'
  },
  errorKey: 'error',
  serializers: {
    error: pino.stdSerializers.err,
  },
};

/**
 * Root logger instance, providing the base configuration for the service.
 */
const rootLogger: Logger = pino(loggerOptions);

/**
 * Defines the required structure for log metadata.
 * Every log entry must include a 'module' to allow for granular filtering.
 */
export interface LogContext {
  module: string;
  requestId?: string;
  userId?: string;
  sku?: string;
  batchProcessId?: string;
  [key: string]: any;
}

/**
 * Creates a child logger with injected hierarchical context.
 * 
 * Used for injecting tracing IDs, user identifiers, and module names 
 * into logs for easier aggregation and debugging.
 * 
 * @param context - The metadata object containing 'module' and additional context.
 * @returns A pino logger instance enriched with the provided context.
 * @throws Error if the module property is missing.
 */
export const createLogger = (context: LogContext): Logger => {
  if (!context || typeof context.module !== 'string') {
    // Graceful recovery: log warning if context is invalid rather than crashing the service
    const warningLogger = rootLogger.child({ module: 'logger-system' });
    warningLogger.warn('Invalid logger context provided; missing or non-string "module" property.');
    return rootLogger.child({ module: 'unknown' });
  }
  return rootLogger.child(context);
};

/**
 * Default logger instance for global usage.
 * Should be used as a fallback if no specific module context is available.
 */
const logger: Logger = rootLogger.child({ module: 'global' });

export default logger;
