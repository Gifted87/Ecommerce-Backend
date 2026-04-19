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
} from '../../../services/user/auth_mfa_module/types';

// Export Domain Services
/**
 * AuthService provides core authentication logic including login, registration, 
 * and token management. It is designed for non-blocking I/O operations.
 */
export { AuthService } from '../../../services/user/auth_mfa_module/services/auth.service';

/**
 * UserService handles the core business logic for user management,
 * including registration, profile updates, and persistence.
 */
export { UserService } from '../../../services/user/auth_mfa_module/services/user.service';

/**
 * MfaService handles Multi-Factor Authentication workflows including secret 
 * generation, verification, and backup code management.
 */
export { MfaService } from '../../../services/user/auth_mfa_module/services/mfa.service';

// Export Controllers
/**
 * RegistrationController manages the user sign-up process.
 */
export { RegistrationController } from './controllers/registration/registration.controller';

/**
 * ProfileController handles user profile lifecycle.
 */
export { ProfileController } from './controllers/profile/profile.controller';

// Export Infrastructure and Middleware
/**
 * AuthMiddleware is the primary security gatekeeper.
 */
export { createAuthMiddleware } from './middleware/security/auth.middleware';
