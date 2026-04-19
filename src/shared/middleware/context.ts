import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Middleware for providing request context (correlation ID).
 */
export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || (req.headers['x-request-id'] as string) || uuidv4();
  
  // Normalize both headers
  req.headers['x-correlation-id'] = correlationId;
  req.headers['x-request-id'] = correlationId;
  
  // Attach to request object for easy access in controllers/services
  (req as any).correlationId = correlationId;
  
  // Set header in response
  res.setHeader('x-correlation-id', correlationId);
  res.setHeader('x-request-id', correlationId);
  
  next();
};
