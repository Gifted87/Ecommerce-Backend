import crypto from 'crypto';

/**
 * Custom error class for security validation failures.
 */
export class SecurityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityValidationError';
  }
}

/**
 * Sensitive fields to be redacted during PII scrubbing.
 */
const SENSITIVE_FIELDS = new Set(['email', 'userId', 'user_id', 'ssn', 'phone_number']);

/**
 * Recursively redacts PII from an object based on a defined set of sensitive keys.
 * 
 * @param obj - The object to scrub.
 * @returns The scrubbed object.
 */
export function redactPII(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactPII);
  }

  const result: Record<string, any> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (SENSITIVE_FIELDS.has(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactPII(obj[key]);
      }
    }
  }
  return result;
}

/**
 * Canonicalizes an object for deterministic signature generation.
 * Sorts keys recursively.
 * 
 * @param obj - The object to canonicalize.
 * @returns A string representation of the object.
 */
function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return JSON.stringify(obj.map(canonicalize));
  }
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, any> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = canonicalize(obj[key]);
  }
  return JSON.stringify(sortedObj);
}

/**
 * Generates an HMAC-SHA256 hexadecimal string for a given payload.
 * 
 * @param payload - The object or string payload to sign.
 * @returns HMAC-SHA256 hex string.
 * @throws SecurityValidationError if HMAC_SECRET is not configured.
 */
export function signMessage(payload: any): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    throw new SecurityValidationError('HMAC_SECRET environment variable not set');
  }

  const data = typeof payload === 'string' ? payload : canonicalize(payload);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(data);
  return hmac.digest('hex');
}

/**
 * Verifies an HMAC-SHA256 signature against a payload using constant-time comparison.
 * 
 * @param payload - The payload to verify.
 * @param signature - The signature to verify against.
 * @throws SecurityValidationError if signature mismatch is detected.
 */
export function verifySignature(payload: any, signature: string): void {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    throw new SecurityValidationError('HMAC_SECRET environment variable not set');
  }

  const expectedSignature = signMessage(payload);
  
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const providedBuffer = Buffer.from(signature, 'hex');

  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    throw new SecurityValidationError('Signature mismatch: potential tampering detected');
  }
}
