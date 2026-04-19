import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/**
 * Middleware factory for validating request schema using Zod.
 * 
 * @param schema - The Zod schema to validate against.
 * @returns An Express middleware function.
 */
export const validateSchema = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        code: 'VALIDATION_FAILED',
        errors: result.error.format(),
        correlationId: (req.headers['x-correlation-id'] as string) || (req as any).correlationId
      });
    }

    // Replace req.body with validated and potentially transformed data
    req.body = result.data;
    next();
  };
};
