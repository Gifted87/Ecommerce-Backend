import { z } from 'zod';

export const PaginationQuerySchema = z.object({
  page: z.string().transform(Number).optional().default('1'),
  limit: z.string().transform(Number).optional().default('10'),
  from: z.string().optional(),
  to: z.string().optional(),
});

export enum ValidationErrorCode {
  INVALID_SCHEMA = 'INVALID_SCHEMA',
}

export class ValidationError extends Error {
  constructor(public details: any[], public correlationId: string) {
    super('Validation failed');
    this.name = 'ValidationError';
  }
}
