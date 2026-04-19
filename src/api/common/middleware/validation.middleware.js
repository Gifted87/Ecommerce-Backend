"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSchema = void 0;
/**
 * Middleware factory for validating request schema using Zod.
 *
 * @param schema - The Zod schema to validate against.
 * @returns An Express middleware function.
 */
const validateSchema = (schema) => {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            return res.status(400).json({
                code: 'VALIDATION_FAILED',
                errors: result.error.format(),
                correlationId: req.headers['x-correlation-id'] || req.correlationId
            });
        }
        // Replace req.body with validated and potentially transformed data
        req.body = result.data;
        next();
    };
};
exports.validateSchema = validateSchema;
