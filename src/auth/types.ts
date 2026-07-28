/**
 * Types for the browser-based login flow. These are deliberately not in
 * ../types.js — that file is the `beon.ai-score` wire format, and none of this
 * is ever sent in a payload.
 */

/** Who the server says we are. Resolved from the token, never self-asserted. */
export interface Identity {
  name: string | null;
  email: string | null;
}

/** One cached login, keyed by server origin in the credential file. */
export interface Credential {
  token: string;
  /** ISO 8601, or null when the server did not say. */
  expiresAt: string | null;
  identity: Identity | null;
}

/** RFC 8628 device authorization response, as returned by better-auth. */
export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** Successful token exchange. */
export interface DeviceToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Raised when the server answers a device-flow call with an OAuth-style error.
 * `code` is the machine-readable `error` field (`authorization_pending`,
 * `slow_down`, `access_denied`, `expired_token`, …).
 */
export class DeviceFlowError extends Error {
  constructor(
    readonly code: string,
    description: string,
  ) {
    super(description || code);
    this.name = "DeviceFlowError";
  }
}
