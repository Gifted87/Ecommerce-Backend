import { z } from 'zod';
import { Logger } from 'pino';

/**
 * Custom error class for configuration-related issues during bootstrap.
 */
export class ConfigurationError extends Error {
  constructor(message: string, public readonly details?: any) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Strict schema definition for application configuration using Zod.
 * Ensures data integrity and type safety at the boundaries.
 */
const AppConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('production'),
  DATABASE_URL: z.string().url(),
  KAFKA_BROKERS: z.string().transform((val) => val.split(',')),
  KAFKA_CLIENT_ID: z.string().min(1),
  REDIS_URL: z.string().url(),
  RECONCILIATION_FREQUENCY_MS: z.coerce.number().positive().default(60000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * ConfigurationProvider ensures immutable, validated application settings.
 * Implements the Singleton pattern to provide a centralized configuration source.
 */
export class ConfigurationProvider {
  private static instance: ConfigurationProvider;
  private readonly _config: AppConfig;
  private _isReady: boolean = false;

  private constructor(private readonly logger: Logger) {
    const rawConfig = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      KAFKA_BROKERS: process.env.KAFKA_BROKERS,
      KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID,
      REDIS_URL: process.env.REDIS_URL,
      RECONCILIATION_FREQUENCY_MS: process.env.RECONCILIATION_FREQUENCY_MS,
      LOG_LEVEL: process.env.LOG_LEVEL,
    };

    const result = AppConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      const errorMsg = 'Configuration validation failed';
      this.logger.error({ errors: result.error.format() }, errorMsg);
      throw new ConfigurationError(errorMsg, result.error.format());
    }

    this._config = result.data;
    this._isReady = true;
    this.logger.info('Configuration initialized and validated successfully');
  }

  /**
   * Initializes the Singleton ConfigurationProvider. Must be called on boot.
   */
  public static initialize(logger: Logger): ConfigurationProvider {
    if (!ConfigurationProvider.instance) {
      ConfigurationProvider.instance = new ConfigurationProvider(logger);
    }
    return ConfigurationProvider.instance;
  }

  /**
   * Retrieves the current configuration instance.
   */
  public static getInstance(): ConfigurationProvider {
    if (!ConfigurationProvider.instance) {
      throw new ConfigurationError('ConfigurationProvider must be initialized before access.');
    }
    return ConfigurationProvider.instance;
  }

  /**
   * Returns the validated configuration object.
   */
  public get config(): AppConfig {
    if (!this._isReady) {
      throw new ConfigurationError('Attempted to access configuration before initialization.');
    }
    return this._config;
  }

  /**
   * Returns sanitized diagnostic info for logging without exposing secrets.
   */
  public getDiagnostics(): Record<string, any> {
    const { DATABASE_URL, REDIS_URL, ...safeConfig } = this._config;
    return {
      ...safeConfig,
      DB_HOST: new URL(DATABASE_URL).hostname,
      REDIS_HOST: new URL(REDIS_URL).hostname,
    };
  }

  /**
   * Redacts sensitive information from log objects.
   */
  public redact(data: Record<string, any>): Record<string, any> {
    const sensitiveKeys = ['password', 'secret', 'token', 'authorization', 'credential'];
    const redacted = { ...data };

    for (const key in redacted) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
        redacted[key] = this.redact(redacted[key]);
      }
    }
    return redacted;
  }
}
