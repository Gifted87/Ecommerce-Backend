import pino, { Logger, LoggerOptions } from 'pino';

/**
 * Sensitive fields to be redacted from log payloads.
 */
const REDACT_PATHS = [
  'paymentToken',
  'passwordHash',
  'emailAddress',
  '*.paymentToken',
  '*.passwordHash',
  '*.emailAddress'
];

/**
 * Configuration for the production logger instance.
 * Ensures structured JSON logging, asynchronous operation, and sensitive data redaction.
 */
const pinoConfig: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  // Ensure logs are serialized as JSON
  messageKey: 'msg',
  base: {
    env: process.env.NODE_ENV || 'production',
    service: 'messaging-engine',
  },
};

/**
 * Main logger instance for the messaging engine.
 */
export const logger: Logger = pino(pinoConfig);

/**
 * Interface for correlation ID aware logging.
 */
export interface CorrelationLogger {
  info(obj: object, msg?: string, ...args: any[]): void;
  warn(obj: object, msg?: string, ...args: any[]): void;
  error(obj: object, msg?: string, ...args: any[]): void;
  debug(obj: object, msg?: string, ...args: any[]): void;
}

/**
 * Creates a child logger context associated with a specific correlation ID.
 * 
 * @param correlationId - The unique identifier for the distributed trace.
 * @returns A logger instance that automatically includes the correlationId in all logs.
 */
export const createCorrelationLogger = (correlationId: string): Logger => {
  return logger.child({ correlationId });
};

/**
 * Handles fatal exit scenarios by flushing remaining log buffers before terminating.
 */
export const handleFatalError = (error: Error): void => {
  logger.fatal({ err: error }, 'Fatal system error encountered. Flushing logs and terminating.');
  
  // Attempt to flush synchronously if necessary
  const stream = (logger as any).stream;
  if (stream && typeof stream.flushSync === 'function') {
    stream.flushSync();
  }
  
  process.exit(1);
};

/**
 * Diagnostic logger specifically for Circuit Breaker events.
 * 
 * @param state - The state of the circuit (e.g., 'OPEN', 'HALF_OPEN', 'CLOSED').
 * @param remainingTime - Time until the next state transition in milliseconds.
 * @param metadata - Additional diagnostic information.
 */
export const logCircuitBreakerEvent = (
  state: 'OPEN' | 'HALF_OPEN' | 'CLOSED',
  remainingTime: number,
  metadata: Record<string, any>
): void => {
  logger.warn({
    circuitState: state,
    retryAfterMs: remainingTime,
    ...metadata,
    msg: 'Circuit breaker event detected'
  });
};
