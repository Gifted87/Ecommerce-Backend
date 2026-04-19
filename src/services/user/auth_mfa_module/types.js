"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MfaStatus = exports.UserUpdateSchema = exports.UserRegistrationSchema = exports.toPublicUser = exports.UserModelSchema = void 0;
const zod_1 = require("zod");
/**
 * @fileoverview Definitive type contract for the Authentication and Multi-Factor Authentication (MFA) sub-system.
 * Provides strictly enforced interfaces for session management, MFA configuration, and JWT payloads
 * to ensure data integrity across the distributed microservices architecture.
 */
/**
 * User Model Schema
 */
exports.UserModelSchema = zod_1.z.object({
    user_id: zod_1.z.string().uuid(),
    email: zod_1.z.string().email(),
    password_hash: zod_1.z.string(),
    first_name: zod_1.z.string().min(1),
    last_name: zod_1.z.string().min(1),
    roles: zod_1.z.array(zod_1.z.string()),
    is_active: zod_1.z.boolean(),
    mfa_enabled: zod_1.z.boolean(),
    mfa_secret: zod_1.z.string().nullable(),
    created_at: zod_1.z.string(),
    updated_at: zod_1.z.string(),
});
/**
 * Mapper function for public user profile
 */
const toPublicUser = (user) => ({
    user_id: user.user_id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    roles: user.roles,
    mfa_enabled: user.mfa_enabled,
});
exports.toPublicUser = toPublicUser;
/**
 * User Registration Schema
 */
exports.UserRegistrationSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8),
    first_name: zod_1.z.string().min(1),
    last_name: zod_1.z.string().min(1),
});
/**
 * User Profile Update Schema
 */
exports.UserUpdateSchema = zod_1.z.object({
    first_name: zod_1.z.string().min(1).optional(),
    last_name: zod_1.z.string().min(1).optional(),
    email: zod_1.z.string().email().optional(),
});
/**
 * Defines the current state of the MFA workflow for a user.
 */
var MfaStatus;
(function (MfaStatus) {
    MfaStatus["PENDING"] = "PENDING";
    MfaStatus["VERIFIED"] = "VERIFIED";
    MfaStatus["DISABLED"] = "DISABLED";
    MfaStatus["RECOVERY_REQUIRED"] = "RECOVERY_REQUIRED";
})(MfaStatus || (exports.MfaStatus = MfaStatus = {}));
