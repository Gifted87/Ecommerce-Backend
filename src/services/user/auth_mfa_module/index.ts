/**
 * @fileoverview Public API surface for the Authentication and MFA module.
 * Provides orchestrated access to services, controllers, and middleware,
 * enforcing strict encapsulation and type safety across the microservice.
 */

export * from './types';
export { AuthService } from './services/auth.service';
export { MfaService } from './services/mfa.service';
export { AuthController } from './controllers/auth.controller';
export { MfaController } from './controllers/mfa.controller';
export { createAuthMiddleware } from './middleware/auth.middleware';
