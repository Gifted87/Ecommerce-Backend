import pino, { Logger, LoggerOptions } from 'pino';

/**
 * @fileoverview Centralized logging subsystem for the ecommerce backend.
 * Utilizes pino for high-performance, asynchronous, structured JSON logging.
 * Implements singleton pattern and redaction for PII protection.
 */

/**
 * Sensitive fields to be redacted from all log entries.
 */
const REDACTED_KEYS = [
  'password',
  'credit_card',
  'authorization',
  'token',
  'cookie',
  'set-cookie',
  'secret'
];

/**
 * Configuration for the Pino logger.
 * Uses environment variables to determine log level.
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
    hostname: require('os').hostname(),
  },
  errorKey: 'error',
  serializers: {
    error: pino.stdSerializers.err,
  },
};

/**
 * The core singleton logger instance configured for the application.
 */
const rootLogger: Logger = pino(loggerOptions);

/**
 * Interface representing the structure of contextual metadata for logs.
 */
interface LogContext {
  module: string;
  requestId?: string;
  userId?: string;
  [key: string]: any;
}

/**
 * Creates a child logger with injected context.
 * 
 * @param context - The metadata object containing 'module' and optional 'requestId' or 'userId'.
 * @returns A logger instance enriched with the provided context.
 */
export const createLogger = (context: LogContext): Logger => {
  if (!context.module) {
    throw new Error('Logger context must include a "module" property.');
  }
  return rootLogger.child(context);
};

/**
 * Main logger singleton to be used across the application.
 * Note: While it is recommended to use `createLogger` for module tracing,
 * this default export provides a fallback for global logging.
 */
const logger: Logger = rootLogger.child({ module: 'global' });

export default logger;
