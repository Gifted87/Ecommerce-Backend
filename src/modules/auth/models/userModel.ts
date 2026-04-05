import { z } from 'zod';

/**
 * @fileoverview User domain data schemas and validation logic for authentication and profile management.
 * Provides strictly enforced Zod schemas for user lifecycle management.
 */

/**
 * Password complexity requirements:
 * - Minimum 12 characters.
 * - At least one uppercase letter.
 * - At least one lowercase letter.
 * - At least one digit.
 * - At least one special character.
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
 */
export const UserRegistrationSchema = z.object({
  email: z.string().email('Invalid email format').toLowerCase(),
  password: passwordSchema,
  username: z.string().min(3, 'Username must be at least 3 characters long').max(50),
  first_name: z.string().min(1, 'First name is required').max(100),
  last_name: z.string().min(1, 'Last name is required').max(100),
});

/**
 * Zod schema for profile updates.
 * Excludes immutable fields like user_id and created_at.
 */
export const UserUpdateSchema = z.object({
  username: z.string().min(3).max(50).optional(),
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  email: z.string().email().toLowerCase().optional(),
});

/**
 * Internal database user structure.
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
 * Publicly exposed user profile (sensitive fields omitted).
 */
export type PublicUser = Omit<UserModel, 'password_hash' | 'salt' | 'mfa_secret'>;

/**
 * Creates a public-facing user profile from the internal database model.
 * @param user The full user database model.
 * @returns The safe public user representation.
 */
export function toPublicUser(user: UserModel): PublicUser {
  const { password_hash, salt, mfa_secret, ...publicUser } = user;
  return publicUser;
}

/**
 * Validates registration data against the UserRegistrationSchema.
 * Optimized for high-throughput environments.
 */
export const validateRegistration = (data: unknown) => {
  return UserRegistrationSchema.safeParse(data);
};

/**
 * Validates update data against the UserUpdateSchema.
 */
export const validateUpdate = (data: unknown) => {
  return UserUpdateSchema.safeParse(data);
};
