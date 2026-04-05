import { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * @fileoverview Schema-based input validation middleware.
 * Provides a high-performance, secure gatekeeper for user-related endpoints
 * using Zod for strict type enforcement and structured observability.
 */

// Production-ready logger configuration with PII redaction
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['email', 'password', 'token', 'secret', 'authorization', 'cookie'],
    censor: '[REDACTED]',
  },
  base: {
    service: 'user-lifecycle-middleware',
  },
});

/**
 * Higher-order function that generates an Express middleware for Zod schema validation.
 * Ensures atomicity, security, and traceability for incoming HTTP requests.
 * 
 * @param schema The Zod schema to validate req.body against.
 * @returns An Express RequestHandler.
 */
export const validateInput = <T extends z.ZodTypeAny>(schema: T): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Establish Traceability
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    const logContext = {
      correlationId,
      path: req.path,
      method: req.method,
    };

    try {
      // 2. Perform Schema Validation
      // Use safeParseAsync to handle potentially complex async refinements
      const result = await schema.safeParseAsync(req.body);

      if (!result.success) {
        // Log the failure for security auditing (PII redacted)
        logger.warn({ ...logContext, error: 'Validation failed' }, 'Input validation error occurred');

        // 3. Opaque Error Response
        // Mitigates enumeration attacks by returning a uniform error
        res.status(400).json({
          status: 400,
          message: 'Invalid request parameters',
          correlationId,
        });
        return;
      }

      // 4. Inject validated data back into the request object
      // This pattern avoids re-parsing downstream
      req.body = result.data;

      next();
    } catch (error) {
      // 5. Fatal Error Handling
      // Catches unforeseen issues (e.g., circular payloads, unexpected runtime exceptions)
      logger.error({ ...logContext, err: error }, 'Unexpected validation middleware exception');

      res.status(500).json({
        status: 500,
        message: 'Internal server error during request processing',
        correlationId,
      });
    }
  };
};
