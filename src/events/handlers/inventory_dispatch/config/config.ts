import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * @fileoverview Central configuration management for the Inventory Dispatch Handler.
 * Provides a strictly validated, immutable, and type-safe configuration object.
 * Loads variables from the environment and ensures system integrity at boot time.
 * 
 * This module follows the Singleton pattern, ensuring that the application environment
 * is validated exactly once upon initialization.
 */

// Initialize dotenv to load .env files if present.
dotenv.config();

/**
 * Zod schema defining the strict environment configuration requirements for the
 * Inventory Dispatcher, including Kafka, Security, and Circuit Breaker settings.
 */
const envSchema = z.object({
  // Application & Logging
  APP_ENV: z.enum(['development', 'staging', 'production']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Kafka Configuration
  KAFKA_BROKER_URL: z.string().transform((val) => val.split(',').map(s => s.trim())),
  KAFKA_CLIENT_ID: z.string().min(1),
  KAFKA_GROUP_ID: z.string().min(1),
  KAFKA_CONSUMER_TOPIC: z.string().min(1),
  
  // Security Configuration
  HMAC_SECRET: z.string().min(64, 'HMAC_SECRET must be at least 64 characters long'),
  
  // Opossum Circuit Breaker Settings
  CB_TIMEOUT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(100)),
  CB_THRESHOLD: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1).max(100)),
  CB_RESET_TIMEOUT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1000)),
}).refine((data) => data.CB_THRESHOLD >= 1 && data.CB_THRESHOLD <= 100, {
  message: "CB_THRESHOLD must be a percentage between 1 and 100",
  path: ["CB_THRESHOLD"],
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

/**
 * The validated, immutable configuration object.
 * Acts as the singular source of truth for the inventory dispatch handler.
 */
export const config: Readonly<AppConfig> = Object.freeze(parseEnv());
