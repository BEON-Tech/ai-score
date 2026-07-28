export type HarnessName = "claude-code" | "codex" | "opencode" | "pi";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface SessionCounts {
  userPrompts: number;
  assistantMessages: number;
  toolCalls: number;
  toolErrors: number;
  toolDenials: number;
  interruptions: number;
}

export interface SessionAgentic {
  turns: number;
  maxToolCallsPerTurn: number;
  longestTurnMs: number | null;
}

export interface SessionOutcome {
  prLinks: number;
  filesChanged: number | null;
  additions: number | null;
  deletions: number | null;
  distinctGitBranches: number | null;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  startedAt: string | null;
  endedAt: string | null;
  isSubagent: boolean;
  counts: SessionCounts;
  tools: Record<string, number>;
  models: Record<string, TokenUsage>;
  costUsd: number | null;
  flags: Record<string, number | boolean | string[]>;
  agentic: SessionAgentic;
  outcome: SessionOutcome;
}

export interface HarnessReport {
  harness: HarnessName;
  detected: boolean;
  dataPath: string | null;
  latestVersion: string | null;
  sessionsScanned: number;
  sessionsIncluded: number;
  parseErrors: number;
  skippedReason: string | null;
  sessions: SessionRecord[];
}

export interface Payload {
  schema: "beon.ai-score.v2";
  client: { name: string; version: string };
  generatedAt: string;
  window: { days: number; start: string; end: string };
  /**
   * v2 removed `email`: identity is resolved server-side from the submitter's
   * access token, so the client no longer asserts who it is.
   */
  engineer: { machineId: string };
  platform: { os: string; arch: string; node: string };
  harnesses: HarnessReport[];
}

export interface DimensionScore {
  score: number;
  max: number;
  signals: Record<string, number>;
}

/**
 * The score the server computes and returns on upload.
 *
 * `dimensions` is deliberately an open record rather than the five keys the
 * server ships today: the scoring service deploys independently of this CLI, so
 * a new dimension must render as an extra row, not crash an old client.
 */
export interface Score {
  total: number;
  version: number;
  dimensions: Record<string, DimensionScore>;
}

/** Parsed upload response. Both fields are null when the shape is unfamiliar. */
export interface SubmissionResult {
  id: string | null;
  score: Score | null;
}

export interface CollectContext {
  since: Date;
  now: Date;
  verbose: (message: string) => void;
}

export interface Adapter {
  harness: HarnessName;
  collect(ctx: CollectContext): Promise<HarnessReport>;
}
