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
  schema: "beon.ai-score.v1";
  client: { name: string; version: string };
  generatedAt: string;
  window: { days: number; start: string; end: string };
  engineer: { email: string | null; machineId: string };
  platform: { os: string; arch: string; node: string };
  harnesses: HarnessReport[];
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
