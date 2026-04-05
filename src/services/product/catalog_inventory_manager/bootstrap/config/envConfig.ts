import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * @fileoverview Central configuration management for the Catalog and Inventory Management Service.
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
  APP_ENV: z.enum(['development', 'staging', 'production']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1).max(65535)),

  // Database Configuration
  DB_HOST: z.string().min(1),
  DB_PORT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1).max(65535)),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_POOL_MIN: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(0)),
  DB_POOL_MAX: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1)),

  // Redis Configuration
  REDIS_URL: z.string().url(),
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
}).refine((data) => data.DB_POOL_MIN <= data.DB_POOL_MAX, {
  message: "DB_POOL_MIN cannot be greater than DB_POOL_MAX",
  path: ["DB_POOL_MIN"],
});

/**
 * Parses and validates process.env against the defined schema.
 * If validation fails, it constructs a structured JSON response and terminates the process.
 * 
 * @returns {AppConfig} The validated environment configuration.
 */
const parseEnv = (): AppConfig => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Redaction strategy: Ensure sensitive fields are never logged.
    // Zod issues contain the path, which is safe to log.
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

    // Fail-fast strategy: terminate the process to prevent zombie states.
    process.exit(1);
  }

  return result.data;
};

// Validate and freeze the configuration to ensure runtime immutability.
const validatedEnv = Object.freeze(parseEnv());

/**
 * The validated, immutable configuration object.
 * Acts as the singular source of truth for the entire application.
 */
export const config: Readonly<AppConfig> = validatedEnv;

/**
 * Type-safe interface for the application configuration.
 */
export type AppConfig = z.infer<typeof envSchema>;
