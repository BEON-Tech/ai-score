import { canOpenBrowser, openBrowser } from "./browser.js";
import { fetchIdentity, requestDeviceCode, requestToken } from "./client.js";
import { clearCredential, credentialPath, readCredential, writeCredential } from "./store.js";
import { type Credential, DeviceFlowError, type Identity } from "./types.js";

export { credentialPath } from "./store.js";
export { DeviceFlowError } from "./types.js";
export type { Credential, Identity } from "./types.js";

/** Env var escape hatch for CI and other places a browser cannot open. */
export const TOKEN_ENV_VAR = "AI_SCORE_TOKEN";

export interface AuthContext {
  /** Origin of the ai-score server, e.g. https://ai-score.beon.tech */
  baseUrl: string;
  /** Never spawn a browser; just print the URL. */
  noBrowser: boolean;
  log: (message: string) => void;
}

/** Cache key: the origin, so dev and production tokens cannot be confused. */
export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Full browser login. Prints the user code, opens the approval page, then polls
 * until the engineer approves. Resolves to the stored credential.
 */
export async function login(ctx: AuthContext): Promise<Credential> {
  const origin = originOf(ctx.baseUrl);
  const device = await requestDeviceCode(origin);
  const url = device.verification_uri_complete ?? device.verification_uri;

  ctx.log("");
  ctx.log(`  Your code:  ${device.user_code}`);
  ctx.log(`  Open:       ${url}`);
  ctx.log("");
  ctx.log("  Approve the request only if the page shows the same code.");
  ctx.log("");

  if (!ctx.noBrowser && canOpenBrowser()) openBrowser(url);
  ctx.log("waiting for approval…");

  const token = await poll(origin, device.device_code, device.interval, device.expires_in);
  const identity = await fetchIdentity(origin, token.access_token).catch(() => null);
  const credential: Credential = {
    token: token.access_token,
    expiresAt:
      token.expires_in > 0 ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
    identity,
  };
  writeCredential(origin, credential);
  ctx.log(`signed in as ${describe(identity)} · token cached in ${credentialPath()}`);
  return credential;
}

async function poll(
  origin: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  // The server rejects polls that arrive faster than its own interval, and
  // clock jitter makes an exact match a coin flip — hence the cushion.
  let waitMs = intervalSeconds * 1000 + 500;
  let consecutiveNetworkErrors = 0;

  while (Date.now() < deadline) {
    await sleep(waitMs);
    try {
      return await requestToken(origin, deviceCode);
    } catch (err) {
      if (!(err instanceof DeviceFlowError)) throw err;
      switch (err.code) {
        case "authorization_pending":
          consecutiveNetworkErrors = 0;
          continue;
        case "slow_down":
          waitMs += 5000;
          continue;
        case "network_error":
          // A blip should not throw away a login the engineer may have already
          // approved; a sustained outage should still fail.
          if (++consecutiveNetworkErrors >= 3) throw err;
          continue;
        default:
          throw err;
      }
    }
  }
  throw new DeviceFlowError("expired_token", "the login request expired — run login again");
}

export function logout(baseUrl: string): boolean {
  return clearCredential(originOf(baseUrl));
}

/** Cached credential for this origin, or null. Does not touch the network. */
export function cached(baseUrl: string): Credential | null {
  return readCredential(originOf(baseUrl));
}

/**
 * Confirms with the server who a stored token belongs to. Returns null when
 * there is no token, or when the server no longer accepts it.
 */
export async function whoami(baseUrl: string): Promise<Identity | null> {
  const origin = originOf(baseUrl);
  const token = process.env[TOKEN_ENV_VAR] ?? readCredential(origin)?.token;
  if (!token) return null;
  return await fetchIdentity(origin, token);
}

/**
 * The token to submit with. Order: env var, cached credential, then an
 * interactive login when allowed. Throws with actionable guidance otherwise.
 */
export async function resolveToken(ctx: AuthContext & { allowLogin: boolean }): Promise<string> {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv) return fromEnv;

  const existing = cached(ctx.baseUrl);
  if (existing) return existing.token;

  if (!ctx.allowLogin) {
    throw new Error(
      `not signed in — run \`ai-score login\`, or set ${TOKEN_ENV_VAR} for non-interactive use`,
    );
  }
  ctx.log("not signed in — starting login.");
  const credential = await login(ctx);
  return credential.token;
}

/** Called after a 401 so the next run does not retry a dead token. */
export function invalidate(baseUrl: string): void {
  clearCredential(originOf(baseUrl));
}

export function describe(identity: Identity | null): string {
  if (!identity) return "(unknown account)";
  if (identity.name && identity.email) return `${identity.name} <${identity.email}>`;
  return identity.email ?? identity.name ?? "(unknown account)";
}
