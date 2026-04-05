import { z } from 'zod';

/**
 * @fileoverview User domain data schemas and validation logic for high-concurrency authentication and profile management.
 * Provides strictly enforced Zod schemas for user lifecycle management to ensure data integrity,
 * security compliance, and type safety across the distributed microservices architecture.
 */

/**
 * Password complexity requirements:
 * - Minimum 12 characters: Ensures resistance against brute-force and dictionary attacks.
 * - At least one uppercase letter: Increases entropy.
 * - At least one lowercase letter: Increases entropy.
 * - At least one digit: Required for compliance with modern security standards.
 * - At least one special character: Ensures resilience against common password cracking patterns.
 */
const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters long')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one digit')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

/**
 * Zod schema for user registration inputs.
 * Strictly enforces structure and format for incoming sign-up requests.
 * Uses .toLowerCase() on email to ensure uniqueness and normalization in database lookups.
 */
export const UserRegistrationSchema = z.object({
  email: z.string().email('Invalid email format').trim().toLowerCase(),
  password: passwordSchema,
  username: z.string().min(3, 'Username must be at least 3 characters long').max(50, 'Username cannot exceed 50 characters').trim(),
  first_name: z.string().min(1, 'First name is required').max(100, 'First name too long').trim(),
  last_name: z.string().min(1, 'Last name is required').max(100, 'Last name too long').trim(),
});

/**
 * Zod schema for profile updates.
 * Implements partial update capability for mutable fields.
 * Excludes sensitive or immutable internal fields like user_id, password_hash, and created_at.
 */
export const UserUpdateSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters long').max(50).trim().optional(),
  first_name: z.string().min(1, 'First name is required').max(100).trim().optional(),
  last_name: z.string().min(1, 'Last name is required').max(100).trim().optional(),
  email: z.string().email('Invalid email format').trim().toLowerCase().optional(),
});

/**
 * Internal database user model.
 * Represents the source of truth for the User entity within the application.
 */
export interface UserModel {
  user_id: string; // UUID v4
  email: string;
  username: string;
  password_hash: string;
  salt: string;
  first_name: string;
  last_name: string;
  mfa_secret: string | null;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Publicly exposed user profile.
 * Strips sensitive fields (password_hash, salt, mfa_secret) from the database model
 * to safely expose profile data to the API consumers.
 */
export type PublicUser = Omit<UserModel, 'password_hash' | 'salt' | 'mfa_secret'>;

/**
 * Transforms the internal database model into a public-facing user profile.
 * Purges sensitive credentials to prevent unauthorized exposure.
 * 
 * @param user The full internal user database model.
 * @returns {PublicUser} The safe public representation of the user.
 */
export function toPublicUser(user: UserModel): PublicUser {
  const { password_hash, salt, mfa_secret, ...publicUser } = user;
  return publicUser;
}

/**
 * Validates registration data against the UserRegistrationSchema.
 * Optimized for high-throughput environments using safeParse to avoid exception overhead.
 * 
 * @param data The raw input data from the request.
 * @returns The validation result containing success or error details.
 */
export const validateRegistration = (data: unknown) => {
  return UserRegistrationSchema.safeParse(data);
};

/**
 * Validates update data against the UserUpdateSchema.
 * 
 * @param data The raw input data from the request.
 * @returns The validation result containing success or error details.
 */
export const validateUpdate = (data: unknown) => {
  return UserUpdateSchema.safeParse(data);
};

/**
 * Type definitions for validated inputs.
 */
export type UserRegistration = z.infer<typeof UserRegistrationSchema>;
export type UserUpdate = z.infer<typeof UserUpdateSchema>;
