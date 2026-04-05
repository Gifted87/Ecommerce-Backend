/**
 * @fileoverview Definitive type contract for the Authentication and Multi-Factor Authentication (MFA) sub-system.
 * Provides strictly enforced interfaces for session management, MFA configuration, and JWT payloads
 * to ensure data integrity across the distributed microservices architecture.
 */

/**
 * Defines the current state of the MFA workflow for a user.
 */
export enum MfaStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  DISABLED = 'DISABLED',
  RECOVERY_REQUIRED = 'RECOVERY_REQUIRED',
}

/**
 * Represents the structure of the session object cached in Redis.
 * Used for maintaining user state across service restarts and concurrent login handling.
 */
export interface AuthSession {
  /** Unique session identifier (UUID v4). */
  session_id: string;
  /** Unique user identifier (UUID v4). */
  user_id: string;
  /** Current MFA workflow status. */
  mfa_status: MfaStatus;
  /** ISO 8601 string representing when the session was created. */
  created_at: string;
  /** ISO 8601 string representing the timestamp of the last activity, used for TTL management. */
  last_activity_at: string;
  /** IP address associated with the session creation, for security audit. */
  ip_address: string;
  /** User-Agent string for session fingerprinting. */
  user_agent: string;
}

/**
 * Represents the MFA configuration for a user.
 * Sensitive fields (mfa_secret) must be encrypted at rest.
 */
export interface MfaSecret {
  /** Unique identifier for the MFA record. */
  mfa_id: string;
  /** Unique user identifier (UUID v4). */
  user_id: string;
  /** 
   * Base32 encoded secret for TOTP. 
   * WARNING: SENSITIVE - MUST BE ENCRYPTED AT REST.
   */
  mfa_secret: string;
  /** Method type (e.g., 'TOTP'). */
  mfa_method: 'TOTP' | 'WEBAUTHN';
  /** Array of hashed recovery codes for account access. */
  recovery_codes: string[];
  /** Flag to indicate if MFA is currently active. */
  is_enabled: boolean;
  /** ISO 8601 string for record creation. */
  created_at: string;
  /** ISO 8601 string for record last update. */
  updated_at: string;
}

/**
 * Defines the JWT structure for session management and authorization.
 * Used by API Gateway and downstream services for RBAC/ABAC decisions.
 */
export interface TokenPayload {
  /** User ID (subject). */
  sub: string;
  /** User email address. */
  email: string;
  /** Array of user roles for access control. */
  roles: string[];
  /** MFA verification flag. */
  mfa_verified: boolean;
  /** Expiration timestamp (Unix epoch in seconds). */
  exp: number;
  /** JWT ID, used for token revocation tracking. */
  jti: string;
  /** Session ID linked to this token. */
  sid: string;
}

/**
 * Interface for internal audit event logging.
 * Ensures observability for security-critical operations.
 */
export interface AuthEvent {
  /** Event identifier. */
  event_id: string;
  /** Type of authentication event (e.g., 'LOGIN_ATTEMPT', 'MFA_VERIFIED'). */
  event_type: string;
  /** User ID if available, otherwise 'anonymous'. */
  user_id: string | null;
  /** Correlation ID for distributed tracing. */
  correlation_id: string;
  /** ISO 8601 string for event timestamp. */
  timestamp: string;
  /** Structured metadata regarding the event, PII should be redacted. */
  metadata: Record<string, unknown>;
}
