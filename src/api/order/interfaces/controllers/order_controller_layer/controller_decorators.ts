import { v4 as uuidv4 } from 'uuid';
import logger from '../../../../../../infrastructure/logging/logger';

/**
 * Sensitive keys to redact from logs.
 */
const REDACTED_KEYS = [
  'password',
  'credit_card',
  'authorization',
  'token',
  'cookie',
  'set-cookie',
  'secret',
  'cvv',
];

/**
 * Recursively redacts PII from an object.
 */
function redactPII(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactPII);
  }

  const redacted: any = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (REDACTED_KEYS.includes(key.toLowerCase())) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactPII(obj[key]);
      }
    }
  }
  return redacted;
}

/**
 * Decorator to log controller method execution, track duration, and redact PII.
 */
export function LogExecution(moduleName: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const requestId = uuidv4();
      const childLogger = logger.child({
        module: moduleName,
        method: propertyKey,
        requestId,
      });

      const start = process.hrtime.bigint();
      
      // Extract Request object from args if present for context
      const request = args.find((arg) => arg && typeof arg === 'object' && 'headers' in arg);
      
      childLogger.info(
        { args: redactPII(args) },
        `Executing ${moduleName}.${propertyKey}`
      );

      try {
        const result = await originalMethod.apply(this, args);
        
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;

        childLogger.info(
          { durationMs, status: 'success' },
          `Completed ${moduleName}.${propertyKey}`
        );

        return result;
      } catch (error: any) {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1_000_000;

        childLogger.error(
          { 
            durationMs, 
            status: 'error', 
            error: {
              message: error.message,
              stack: error.stack,
              code: error.code
            } 
          },
          `Failed ${moduleName}.${propertyKey}`
        );

        throw error;
      }
    };

    return descriptor;
  };
}
