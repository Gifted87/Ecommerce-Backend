"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistrationController = void 0;
const uuid_1 = require("uuid");
const types_1 = require("../../../../../services/user/auth_mfa_module/types");
/**
 * @fileoverview RegistrationController handles HTTP transport for user registration.
 * Coordinates validation and service delegation while providing observability via correlation IDs.
 */
/**
 * Controller responsible for user registration HTTP endpoints.
 *
 * This class translates incoming HTTP requests into service-layer calls for
 * user registration. It handles initial request validation using Zod schemas,
 * coordinates with the UserService for business logic, and ensures that
 * sensitive information (like password hashes) is redacted from the HTTP response.
 */
class RegistrationController {
    /**
     * @param userService - Service instance for user management logic.
     * @param logger - The application's pino logger instance for request tracing.
     */
    constructor(userService, logger) {
        this.userService = userService;
        this.logger = logger;
    }
    /**
     * Primary entry point for POST /register endpoint.
     *
     * Orchestrates the registration flow:
     * 1. Extracts or generates a correlation ID for request tracing.
     * 2. Performs structural and semantic validation on the request body.
     * 3. Delegates the actual registration to the UserService.
     * 4. Transforms the internal user model into a redacted public representation.
     * 5. Handles error mapping from domain-specific exceptions to standard HTTP status codes.
     *
     * @param req - The Express Request object.
     * @param res - The Express Response object.
     * @param next - The Express NextFunction for error delegation.
     * @returns A promise that resolves when the response has been sent.
     */
    async register(req, res, next) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        this.logger.info({ correlationId, path: req.path }, 'User registration request received');
        // 1. Structural and Semantic Validation
        const validation = types_1.UserRegistrationSchema.safeParse(req.body);
        if (!validation.success) {
            this.logger.warn({ correlationId, errors: validation.error.format() }, 'Registration validation failed');
            res.status(400).json({
                error: 'VALIDATION_FAILED',
                details: validation.error.format(),
                correlationId
            });
            return;
        }
        try {
            // 2. Delegate Business Logic
            const user = await this.userService.register(validation.data);
            // 3. Construct Public Response (Redact sensitive fields)
            const publicUser = (0, types_1.toPublicUser)(user);
            this.logger.info({ correlationId, userId: user.user_id }, 'User registration completed successfully');
            res.status(201).json(publicUser);
        }
        catch (error) {
            this.logger.error({ correlationId, error: error.message, stack: error.stack }, 'Registration process failed');
            // Map domain errors to HTTP status codes
            if (error.message === 'USER_ALREADY_EXISTS') {
                res.status(409).json({ error: 'USER_ALREADY_EXISTS', correlationId });
            }
            else {
                next(error); // Delegate to centralized error handler
            }
        }
    }
}
exports.RegistrationController = RegistrationController;
