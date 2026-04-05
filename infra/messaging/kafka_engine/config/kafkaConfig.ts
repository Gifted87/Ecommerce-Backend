import { z } from 'zod';
import fs from 'fs';
import path from 'path';

/**
 * Configuration schema enforcing strict validation for Kafka connectivity.
 */
const kafkaEnvSchema = z.object({
  BROKERS: z.string().min(1, 'BROKERS must be a comma-separated list of broker addresses'),
  SASL_USERNAME: z.string().min(1, 'SASL_USERNAME must be provided'),
  SASL_PASSWORD: z.string().min(1, 'SASL_PASSWORD must be provided'),
  SSL_CA_FILE_PATH: z.string().min(1, 'SSL_CA_FILE_PATH must be provided'),
  KAFKA_CLIENT_ID: z.string().min(1, 'KAFKA_CLIENT_ID must be provided'),
  SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
});

/**
 * Configuration structure for the Kafka Engine.
 */
export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  sasl: {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
  };
  ssl: {
    ca: Buffer;
  };
}

let cachedConfig: KafkaConfig | null = null;

/**
 * Loads and validates environment variables into a secure, immutable configuration object.
 * Throws an error if validation fails or if the CA certificate file is inaccessible.
 */
export function loadConfig(): KafkaConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const result = kafkaEnvSchema.safeParse(process.env);

  if (!result.success) {
    const errorMessages = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    throw new Error(`Kafka Configuration Validation Failed: ${errorMessages}`);
  }

  const env = result.data;

  // Validate CA file existence
  const caFilePath = path.resolve(env.SSL_CA_FILE_PATH);
  if (!fs.existsSync(caFilePath)) {
    throw new Error(`SSL CA file not found at path: ${caFilePath}`);
  }

  let caBuffer: Buffer;
  try {
    caBuffer = fs.readFileSync(caFilePath);
  } catch (err) {
    throw new Error(`Failed to read SSL CA file at ${caFilePath}: ${(err as Error).message}`);
  }

  const config: KafkaConfig = {
    brokers: env.BROKERS.split(',').map((broker) => broker.trim()),
    clientId: env.KAFKA_CLIENT_ID,
    sasl: {
      mechanism: env.SASL_MECHANISM,
      username: env.SASL_USERNAME,
      password: env.SASL_PASSWORD,
    },
    ssl: {
      ca: caBuffer,
    },
  };

  // Ensure immutability for concurrency safety
  cachedConfig = Object.freeze(config);
  return cachedConfig;
}
