import { type DeviceCode, DeviceFlowError, type DeviceToken, type Identity } from "./types.js";

/**
 * This file is the credential chokepoint: every request that carries or obtains
 * a token is here, and nothing here ever sees a payload. Its sibling
 * ../send.ts is the payload chokepoint and never obtains credentials.
 *
 * Deliberately hand-rolled against better-auth's documented endpoints rather
 * than using better-auth's client, so this package keeps zero runtime
 * dependencies and stays auditable by reading src/.
 */

/** Must match CLI_CLIENT_ID on the server. */
const CLIENT_ID = "ai-score-cli";

const TIMEOUT_MS = 15_000;

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function post(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DeviceFlowError("network_error", `could not reach ${url}: ${(err as Error).message}`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new DeviceFlowError(
      "invalid_response",
      `HTTP ${response.status} from ${url} was not JSON: ${text.slice(0, 200)}`,
    );
  }
  // better-auth reports device-flow errors as 4xx with an OAuth-shaped body,
  // rather than GitHub's 200-with-an-error-field convention.
  if (!response.ok) {
    const record = asRecord(parsed);
    const code = typeof record.error === "string" ? record.error : `http_${response.status}`;
    const description =
      typeof record.error_description === "string" ? record.error_description : text.slice(0, 200);
    throw new DeviceFlowError(code, description);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function authBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/auth`;
}

export async function requestDeviceCode(baseUrl: string): Promise<DeviceCode> {
  const raw = asRecord(await post(`${authBase(baseUrl)}/device/code`, { client_id: CLIENT_ID }));
  if (typeof raw.device_code !== "string" || typeof raw.user_code !== "string") {
    throw new DeviceFlowError("invalid_response", "server did not return a device code");
  }
  return {
    device_code: raw.device_code,
    user_code: raw.user_code,
    verification_uri: String(raw.verification_uri ?? `${baseUrl}/device`),
    verification_uri_complete:
      typeof raw.verification_uri_complete === "string" ? raw.verification_uri_complete : undefined,
    expires_in: typeof raw.expires_in === "number" ? raw.expires_in : 600,
    interval: typeof raw.interval === "number" ? raw.interval : 5,
  };
}

/**
 * One token attempt. Throws DeviceFlowError with `authorization_pending` while
 * the engineer has not decided yet — the caller decides how long to keep going.
 */
export async function requestToken(baseUrl: string, deviceCode: string): Promise<DeviceToken> {
  const raw = asRecord(
    await post(`${authBase(baseUrl)}/device/token`, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: CLIENT_ID,
    }),
  );
  if (typeof raw.access_token !== "string") {
    throw new DeviceFlowError("invalid_response", "server did not return an access token");
  }
  return {
    access_token: raw.access_token,
    token_type: String(raw.token_type ?? "Bearer"),
    expires_in: typeof raw.expires_in === "number" ? raw.expires_in : 0,
  };
}

/**
 * Resolves the identity behind a token. `null` means the server rejected it
 * (expired or revoked), which callers treat as "not logged in".
 */
export async function fetchIdentity(baseUrl: string, token: string): Promise<Identity | null> {
  let response: Response;
  try {
    response = await fetch(`${authBase(baseUrl)}/get-session`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DeviceFlowError(
      "network_error",
      `could not reach ${baseUrl}: ${(err as Error).message}`,
    );
  }
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new DeviceFlowError("invalid_response", `HTTP ${response.status} verifying the token`);
  }
  const body = await response.text();
  if (body === "" || body === "null") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DeviceFlowError("invalid_response", "session response was not JSON");
  }
  const user = asRecord(asRecord(parsed).user);
  if (typeof user.id !== "string") return null;
  return {
    name: typeof user.name === "string" && user.name !== "" ? user.name : null,
    email: typeof user.email === "string" && user.email !== "" ? user.email : null,
  };
}
