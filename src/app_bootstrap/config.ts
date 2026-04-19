import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * @fileoverview Central configuration management for the high-concurrency ecommerce backend.
 * Provides a strictly validated, immutable, and type-safe configuration object.
 * Loads variables from the environment and ensures system integrity at boot time.
 * 
 * This module follows the Singleton pattern, ensuring that the application environment
 * is validated exactly once upon initialization.
 */

// Initialize dotenv to load .env files if present.
dotenv.config();

/**
 * Zod schema defining the strict environment configuration requirements.
 * This schema acts as the single source of truth for the environment contract.
 */
const envSchema = z.object({
  // Application Metadata
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1).max(65535)),

  // Database Configuration
  DB_URL: z.string().url().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1)).default('5432'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_NAME: z.string().default('ecommerce'),
  DB_POOL_MIN: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(0)),
  DB_POOL_MAX: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1)),

  // Redis Configuration
  REDIS_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1)).default('6379'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TTL_DEFAULT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(0)),
  REDIS_TIMEOUT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(0)),

  // Kafka Configuration
  KAFKA_BROKER_URL: z.string().transform((val) => val.split(',').map(s => s.trim())),
  KAFKA_CLIENT_ID: z.string().min(1),
  KAFKA_GROUP_ID: z.string().min(1),
  KAFKA_PRODUCER_TIMEOUT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(0)),

  // Security Configuration
  JWT_SECRET: z.string().min(64, 'JWT_SECRET must be at least 64 characters long'),
  JWT_EXPIRATION: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(60)),
  ARGON2_SALT_ROUNDS: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(10).max(20)),
  SECURITY_MASTER_KEY: z.string().min(32, 'SECURITY_MASTER_KEY must be at least 32 characters long'),
  SECURITY_PEPPER: z.string().min(16, 'SECURITY_PEPPER must be at least 16 characters long'),
}).refine((data) => data.DB_POOL_MIN <= data.DB_POOL_MAX, {
  message: "DB_POOL_MIN cannot be greater than DB_POOL_MAX",
  path: ["DB_POOL_MIN"],
});

/**
 * Type-safe interface for the application configuration.
 */
export type AppConfig = z.infer<typeof envSchema>;

/**
 * Parses and validates process.env against the defined schema.
 * If validation fails, it constructs a structured JSON response and terminates the process.
 * 
 * @returns {AppConfig} The validated environment configuration.
 */
const parseEnv = (): AppConfig => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Redaction strategy: Only log the path and error message, never the raw values.
    const errorDetails = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    // Use stderr for critical boot-time failures to ensure logging in observability tools.
    process.stderr.write(
      JSON.stringify({
        level: 'critical',
        message: 'Environment validation failed: System cannot boot with invalid configuration.',
        errors: errorDetails,
        timestamp: new Date().toISOString(),
      }) + '\n'
    );

    // Fail-fast strategy: terminate the process to prevent unstable application state.
    process.exit(1);
  }

  return result.data;
};

/**
 * The validated, immutable configuration object.
 * Acts as the singular source of truth for the entire application.
 */
export const config: Readonly<AppConfig> = Object.freeze(parseEnv());
