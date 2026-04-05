import { z } from 'zod';

/**
 * @fileoverview API Data Transfer Objects (DTOs) and Zod validation schemas for User Management.
 * This file serves as the single source of truth for the API contract between clients and the domain service.
 * All types are strictly typed, immutable, and fully validated at runtime.
 */

/**
 * Common Metadata for API responses.
 */
export interface ApiResponseMeta {
  readonly requestId: string;
  readonly timestamp: string;
}

/**
 * Generic API Response wrapper.
 */
export interface ApiResponse<T = unknown> {
  readonly status: 'success' | 'error';
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly meta: ApiResponseMeta;
}

/**
 * Schema for User Registration.
 */
export const UserRegistrationSchema = z.object({
  email: z.string().email('Invalid email format').trim().toLowerCase(),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .regex(/[A-Z]/, 'Must contain uppercase letter')
    .regex(/[a-z]/, 'Must contain lowercase letter')
    .regex(/[0-9]/, 'Must contain digit')
    .regex(/[^A-Za-z0-9]/, 'Must contain special character'),
  username: z.string().min(3).max(50).trim(),
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().min(1).max(100).trim(),
});

export type RegistrationRequest = z.infer<typeof UserRegistrationSchema>;

/**
 * Schema for Profile Update.
 */
export const ProfileUpdateSchema = z.object({
  username: z.string().min(3).max(50).trim().optional(),
  firstName: z.string().min(1).max(100).trim().optional(),
  lastName: z.string().min(1).max(100).trim().optional(),
  email: z.string().email().trim().toLowerCase().optional(),
});

export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateSchema>;

/**
 * Schema for MFA Setup initiation.
 */
export const MfaSetupSchema = z.object({
  method: z.enum(['TOTP', 'WEBAUTHN']),
});

export type MfaSetupRequest = z.infer<typeof MfaSetupSchema>;

/**
 * Schema for MFA Verification.
 */
export const MfaVerifySchema = z.object({
  code: z.string().length(6, 'MFA code must be 6 digits').regex(/^\d+$/, 'MFA code must be numeric'),
});

export type MfaVerifyRequest = z.infer<typeof MfaVerifySchema>;

/**
 * Public User Profile DTO (Excludes sensitive fields).
 */
export interface PublicUser {
  readonly userId: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly isVerified: boolean;
  readonly createdAt: string;
}

/**
 * Safe Profile DTO (Excludes PII/Internal logic).
 */
export interface SafeProfile {
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}
