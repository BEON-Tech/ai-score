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

export type VerifiedWorkflowResult =
  | {
      status: "scored";
      scoringVersion: number;
      total: number;
      dimensions: Record<string, DimensionScore>;
      evidence: WorkflowEvidenceSummary;
    }
  | {
      status: "insufficient_evidence";
      scoringVersion: number;
      reasonCodes: string[];
      evidence: WorkflowEvidenceSummary;
    };

/** Parsed upload response. Every field is null when the shape is unfamiliar. */
export interface SubmissionResult {
  id: string | null;
  score: Score | null;
  verifiedWorkflow: VerifiedWorkflowResult | null;
  /** Where the submitter can view this run in full — absent on older servers. */
  url: string | null;
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
