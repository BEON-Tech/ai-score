import type {
  DimensionScore,
  Payload,
  Score,
  SubmissionResult,
  VerifiedWorkflowResult,
  WorkflowEvidenceSummary,
} from "./types.js";

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

function parseEvidence(value: unknown): WorkflowEvidenceSummary | null {
  if (!isRecord(value)) return null;
  const keys = [
    "codingSessions",
    "unclassifiedSessions",
    "observableSessions",
    "coverage",
    "checksAttempted",
    "verifiedCompletions",
    "autonomousCompletions",
    "recoveredFailures",
    "deliveriesObserved",
  ] as const;
  if (keys.some((key) => !isFiniteNumber(value[key]))) return null;
  return Object.fromEntries(
    keys.map((key) => [key, value[key]]),
  ) as unknown as WorkflowEvidenceSummary;
}

function parseWorkflow(value: unknown): VerifiedWorkflowResult | null {
  if (!isRecord(value) || !isFiniteNumber(value["scoringVersion"])) return null;
  const evidence = parseEvidence(value["evidence"]);
  if (!evidence) return null;
  if (value["status"] === "insufficient_evidence" && Array.isArray(value["reasonCodes"])) {
    return {
      status: "insufficient_evidence",
      scoringVersion: value["scoringVersion"],
      reasonCodes: value["reasonCodes"].filter(
        (reason): reason is string => typeof reason === "string",
      ),
      evidence,
    };
  }
  if (
    value["status"] !== "scored" ||
    !isFiniteNumber(value["total"]) ||
    !isRecord(value["dimensions"])
  ) {
    return null;
  }
  const dimensions: Record<string, DimensionScore> = {};
  for (const [name, raw] of Object.entries(value["dimensions"])) {
    const dimension = parseDimension(raw);
    if (dimension) dimensions[name] = dimension;
  }
  return {
    status: "scored",
    scoringVersion: value["scoringVersion"],
    total: value["total"],
    dimensions,
    evidence,
  };
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
  const empty: SubmissionResult = { id: null, score: null, verifiedWorkflow: null, url: null };
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!isRecord(root)) return empty;

  const id = typeof root["id"] === "string" ? root["id"] : null;
  const url = parseViewUrl(root["url"]);
  const verifiedWorkflow = parseWorkflow(root["verifiedWorkflow"]);
  const raw = root["score"];
  if (!isRecord(raw) || !isFiniteNumber(raw["total"]) || !isRecord(raw["dimensions"])) {
    return { id, score: null, verifiedWorkflow, url };
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
  return { id, score, verifiedWorkflow, url };
}

/**
 * The link this CLI will print and offer to open, so it is held to a stricter
 * standard than the rest of the response: it must parse, and it must be
 * http(s) — a server (or proxy) that hands back anything else gets no link
 * rather than a terminal that launches who-knows-what.
 */
function parseViewUrl(value: unknown): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:" ? value : null;
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
  if (res.status === 413) {
    throw new Error(
      "upload rejected: the report is larger than the server accepts (HTTP 413). " +
        "Retry with a narrower window, e.g. --days 90.",
    );
  }
  if (!res.ok) {
    throw new Error(`upload failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return { status: res.status, body, result: parseSubmission(body) };
}
