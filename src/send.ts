import type { DimensionScore, Payload, Score, SubmissionResult } from "./types.js";

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
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseDimension(value: unknown): DimensionScore | null {
  if (!isRecord(value) || !isFiniteNumber(value["score"]) || !isFiniteNumber(value["max"])) {
    return null;
  }
  const signals: Record<string, number> = {};
  if (isRecord(value["signals"])) {
    for (const [key, raw] of Object.entries(value["signals"])) {
      if (isFiniteNumber(raw)) signals[key] = raw;
    }
  }
  return { score: value["score"], max: value["max"], signals };
}

/**
 * Reads `{ id, score }` out of the upload response, tolerating anything else.
 *
 * The scoring service versions independently of this CLI, so an unrecognised
 * body has to degrade to "uploaded, no score shown" rather than throw — the
 * submission already succeeded by the time we get here, and failing now would
 * report a false negative.
 */
export function parseSubmission(body: string): SubmissionResult {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return { id: null, score: null };
  }
  if (!isRecord(root)) return { id: null, score: null };

  const id = typeof root["id"] === "string" ? root["id"] : null;
  const raw = root["score"];
  if (!isRecord(raw) || !isFiniteNumber(raw["total"]) || !isRecord(raw["dimensions"])) {
    return { id, score: null };
  }

  const dimensions: Record<string, DimensionScore> = {};
  for (const [name, value] of Object.entries(raw["dimensions"])) {
    const parsed = parseDimension(value);
    if (parsed) dimensions[name] = parsed;
  }

  const score: Score = {
    total: raw["total"],
    version: isFiniteNumber(raw["version"]) ? raw["version"] : 0,
    dimensions,
  };
  return { id, score };
}

export async function send(
  endpoint: string,
  payload: Payload,
  token: string,
): Promise<{ status: number; body: string; result: SubmissionResult }> {
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
  return { status: res.status, body, result: parseSubmission(body) };
}
