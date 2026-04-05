import { Request, Response } from 'express';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { UserRegistrationSchema } from '../../../domain/user.schema';
import { UserRegistrationService } from '../../../application/services/user-registration.service';

/**
 * @fileoverview RegistrationController handles user sign-up requests.
 * It enforces strict schema validation, correlation ID propagation, 
 * and delegates business logic to the UserRegistrationService.
 */

/**
 * @class RegistrationController
 * @description Provides HTTP handlers for the registration lifecycle.
 * Stateless and designed for high-concurrency environments.
 */
export class RegistrationController {
  /**
   * @param registrationService - The service responsible for user creation logic.
   * @param logger - The logger instance for structured output.
   */
  constructor(
    private readonly registrationService: UserRegistrationService,
    private readonly logger: Logger
  ) {}

  /**
   * Handles user registration via POST /register.
   * 
   * @param req - Express Request object containing user registration details.
   * @param res - Express Response object.
   * @returns Promise<void>
   */
  async register(req: Request, res: Response): Promise<void> {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    
    this.logger.info({ 
      correlationId, 
      event: 'REGISTRATION_REQUEST_RECEIVED', 
      path: req.path,
      method: req.method 
    });

    try {
      // 1. Schema Validation
      const validationResult = UserRegistrationSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        this.logger.warn({ 
          correlationId, 
          event: 'REGISTRATION_VALIDATION_FAILED', 
          errors: validationResult.error.format() 
        });
        
        res.status(400).json({ 
          message: 'Invalid registration data', 
          errors: validationResult.error.format() 
        });
        return;
      }

      // 2. Service Coordination
      this.logger.info({ correlationId, event: 'REGISTRATION_PROCESS_STARTED' });
      
      await this.registrationService.registerUser(validationResult.data);

      this.logger.info({ correlationId, event: 'REGISTRATION_SUCCESS' });
      
      res.status(201).json({ 
        message: 'User registered successfully' 
      });

    } catch (error: any) {
      this.handleError(res, error, correlationId);
    }
  }

  /**
   * Centralized error handling strategy.
   * Distinguishes between known domain exceptions and internal system failures.
   * 
   * @param res - Express Response object.
   * @param error - The caught error.
   * @param correlationId - The tracing ID for debugging.
   */
  private handleError(res: Response, error: any, correlationId: string): void {
    // Redact sensitive info before logging
    this.logger.error({ 
      correlationId, 
      event: 'REGISTRATION_INTERNAL_ERROR', 
      message: error.message,
      stack: error.stack 
    });

    // Check if error is a known conflict (e.g., email or username taken)
    if (error.code === 'USER_EXISTS' || error.message.includes('already exists')) {
      res.status(409).json({ 
        message: 'Registration conflict', 
        reason: error.message 
      });
      return;
    }

    // Default 500
    res.status(500).json({ 
      message: 'An unexpected error occurred during registration',
      correlationId 
    });
  }
}
