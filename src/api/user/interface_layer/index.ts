/**
 * @fileoverview Public API surface for the User Interface Layer.
 * This module serves as the central facade for the user management domain,
 * orchestrating the export of controllers, services, middleware, and schemas
 * to ensure a type-safe, secure, and high-performance API boundary.
 */

// Export Domain Schemas and Types
export { 
  UserRegistrationSchema, 
  UserUpdateSchema, 
  UserModel, 
  PublicUser, 
  toPublicUser, 
  validateRegistration 
} from './domain';

// Export Domain Services
/**
 * AuthService provides core authentication logic including login, registration, 
 * and token management. It is designed for non-blocking I/O operations.
 */
export { AuthService } from './services/auth_service';

/**
 * MfaService handles Multi-Factor Authentication workflows including secret 
 * generation, verification, and backup code management.
 */
export { MfaService } from './services/mfa_service';

// Export Controllers
/**
 * AuthController manages request orchestration for authentication-related endpoints,
 * integrating with AuthService and providing structured JSON responses.
 */
export { AuthController } from './controllers/auth_controller';

/**
 * MfaController orchestrates MFA lifecycle requests, ensuring all interactions
 * are secured by appropriate authentication middleware.
 */
export { MfaController } from './controllers/mfa_controller';

// Export Infrastructure and Middleware
/**
 * AuthMiddleware is the primary security gatekeeper. It must be applied to 
 * all protected routes to enforce session/JWT validation, rate limiting, 
 * and correlation ID tracking.
 */
export { AuthMiddleware } from './middleware/auth_middleware';

/**
 * Provides a central hook for initialization, such as setting up 
 * distributed tracing, logger instances, or dependency injection 
 * container configuration.
 */
export * from './init';
