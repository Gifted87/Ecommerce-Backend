import pino, { Logger, LoggerOptions } from 'pino';
import os from 'os';

/**
 * @fileoverview Centralized logging subsystem for the ecommerce backend.
 * Provides a high-performance, asynchronous, structured JSON logging solution.
 * Enforces PII redaction and hierarchical metadata injection.
 */

/**
 * List of sensitive keys that must be redacted from all log streams.
 */
const REDACTED_KEYS = [
  'password',
  'credit_card',
  'authorization',
  'token',
  'cookie',
  'secret'
];

/**
 * Pino configuration with production-ready defaults.
 * Uses high-speed async serialization and PII redaction.
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
 */
export interface LogContext {
  module: string;
  requestId?: string;
  userId?: string;
  [key: string]: any;
}

/**
 * Creates a child logger with injected hierarchical context.
 * Useful for distributed tracing and module-level debugging.
 * 
 * @param context - The metadata object to enrich logs with.
 * @returns A pino logger instance containing the injected context.
 */
export const createLogger = (context: LogContext): Logger => {
  if (!context || typeof context.module !== 'string') {
    throw new Error('Logger context must include a "module" property.');
  }
  return rootLogger.child(context);
};

/**
 * Default logger instance for global use.
 */
const logger: Logger = rootLogger.child({ module: 'global' });

export default logger;
