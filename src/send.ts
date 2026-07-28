import type { Payload } from "./types.js";

/** The server rejected our token; the caller should drop it and re-login. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * The payload chokepoint: the only place a report leaves the machine. Its
 * sibling auth/client.ts is the only place credentials are exchanged.
 */
export async function send(
  endpoint: string,
  payload: Payload,
  token: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": `beon-ai-score/${payload.client.version}`,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new UnauthorizedError(`upload rejected: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`upload failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return { status: res.status, body };
}
