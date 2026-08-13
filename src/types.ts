/**
 * Cursor ships two independent products that share a name and nothing else: the
 * `cursor-agent` CLI keeps a content-addressed blob store under `~/.cursor`,
 * the desktop app keeps composers in its VS Code state database. They record
 * different fields, so they report as different harnesses rather than as one
 * blurred row.
 */
export type HarnessName =
  | "claude-code"
  | "codex"
  | "copilot-cli"
  | "copilot-ide"
  | "cursor-cli"
  | "cursor-ide"
  | "opencode"
  | "pi";

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
  /**
   * Commits authored by this machine's git identity in the session's
   * repository between the session's start and shortly after its end, read
   * from local git history (timestamps only — no messages, no hashes). This
   * is how delivery that happens outside the harness — a commit script, a
   * separate terminal — stays visible. Null when the session's directory is
   * unknown, is not a git repository, or git identity is unset.
   */
  localCommits: number | null;
}

export type WorkflowCodeChange = "success" | "failure" | "none" | "unknown";
export type WorkflowVerification = "passed" | "failed" | "not-run" | "unknown";
export type WorkflowDelivery = "observed" | "not-observed" | "unknown";
export type VerificationKind = "test" | "typecheck" | "build" | "lint";

/** Privacy-safe evidence derived locally from ordered tool calls and results. */
export interface WorkflowEvidence {
  classifierVersion: 2;
  codeChange: WorkflowCodeChange;
  sequenceKnown: boolean;
  finalVerification: WorkflowVerification;
  /**
   * True when the session's final change went unchecked (`finalVerification:
   * "not-run"`) but a check *did* pass after an earlier change — the
   * edit → tests pass → tweak → stop pattern. Additive field; servers that
   * predate it ignore it, and old payloads read as null.
   */
  stalePass: boolean | null;
  autonomousVerifiedChange: boolean | null;
  recoveredFromFailure: boolean | null;
  delivery: WorkflowDelivery;
  verificationKinds: VerificationKind[];
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
  workflow: WorkflowEvidence;
}

/**
 * How a harness relates to one evidence signal. A null value in a session is
 * ambiguous by construction — "didn't happen", "couldn't measure", and "this
 * harness never records that" all serialize the same way — so every report
 * declares, per signal, which reading applies:
 *
 * - `measured`: read from the harness's own records.
 * - `estimated`: derived by this CLI from what the harness does record (e.g.
 *   line counts implied by edit-tool arguments). Null when nothing fired.
 * - `unobservable`: the harness never records enough to produce it. The
 *   server must not score its absence against the engineer.
 */
export type SignalCapability = "measured" | "estimated" | "unobservable";

export interface HarnessCapabilities {
  filesChanged: SignalCapability;
  additions: SignalCapability;
  deletions: SignalCapability;
  prLinks: SignalCapability;
  distinctGitBranches: SignalCapability;
  costUsd: SignalCapability;
  /**
   * Whether per-model cache token counts are real. Cursor and Copilot's VS
   * Code surface never record them, so their zero buckets mean "the file
   * doesn't say", not "started cold every time".
   */
  cacheTokens: SignalCapability;
  longestTurnMs: SignalCapability;
  toolErrors: SignalCapability;
  toolDenials: SignalCapability;
  interruptions: SignalCapability;
  /**
   * Whether check output text reaches the workflow classifier, so piped
   * checks (`pnpm test | tail -8`) can settle on the runner's own summary
   * line instead of an exit code a filter replaced. Where unobservable,
   * `finalVerification: "unknown"` is the format's ceiling, not evidence.
   */
  checkVerdicts: SignalCapability;
  localCommits: SignalCapability;
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
  capabilities: HarnessCapabilities;
  sessions: SessionRecord[];
}

export interface Payload {
  schema: "beon.ai-score.v2";
  client: { name: string; version: string; workflowClassifierVersion: 2 };
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

export interface WorkflowEvidenceSummary {
  codingSessions: number;
  unclassifiedSessions: number;
  observableSessions: number;
  coverage: number;
  checksAttempted: number;
  verifiedCompletions: number;
  autonomousCompletions: number;
  recoveredFailures: number;
  deliveriesObserved: number;
}

/**
 * The evidence behind the score's workflow dimensions. "scored" means the
 * evidence earned full confidence; "insufficient_evidence" means the server
 * discounted those dimensions' points by `confidence`, for the listed reasons.
 */
export interface ScoreWorkflow {
  status: "scored" | "insufficient_evidence";
  scoringVersion: number;
  reasonCodes: string[];
  /** Multiplier the workflow points were scored at, 0..1. Null on old servers. */
  confidence: number | null;
  evidence: WorkflowEvidenceSummary;
}

/**
 * The score the server computes and returns on upload — since scoring v3, one
 * Overall Score whose dimensions include the verified-workflow ones.
 *
 * `dimensions` is deliberately an open record rather than the eight keys the
 * server ships today: the scoring service deploys independently of this CLI, so
 * a new dimension must render as an extra row, not crash an old client.
 */
export interface Score {
  total: number;
  version: number;
  dimensions: Record<string, DimensionScore>;
  /** Null when the server predates the merged score. */
  workflow: ScoreWorkflow | null;
}

/** Parsed upload response. Every field is null when the shape is unfamiliar. */
export interface SubmissionResult {
  id: string | null;
  score: Score | null;
  /** Where the submitter can view this run in full — absent on older servers. */
  url: string | null;
}

export interface CollectContext {
  since: Date;
  now: Date;
  verbose: (message: string) => void;
  /**
   * Where an adapter knows a session's working directory, it hands the raw
   * path here so the CLI can consult local git history for out-of-harness
   * delivery. The path itself never enters the payload — sessions carry only
   * its 16-char hash and the resulting commit count.
   */
  recordProjectDir?: (sessionId: string, dir: string) => void;
}

export interface Adapter {
  harness: HarnessName;
  collect(ctx: CollectContext): Promise<HarnessReport>;
}
