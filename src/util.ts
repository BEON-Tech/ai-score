import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HarnessName, HarnessReport, SessionRecord, TokenUsage } from "./types.js";

export function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function home(...segments: string[]): string {
  return join(homedir(), ...segments);
}

export function displayPath(path: string): string {
  const h = homedir();
  return path.startsWith(h) ? `~${path.slice(h.length)}` : path;
}

export function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export type JsonlLine = { ok: true; value: unknown } | { ok: false };

export async function* jsonlRecords(file: string): AsyncGenerator<JsonlLine> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield { ok: true, value: JSON.parse(trimmed) };
      } catch {
        yield { ok: false };
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function listFilesRecursive(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full, suffix)));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

/**
 * `node:sqlite` only exists from Node 22.5, and this package supports 20. The
 * harnesses that keep their sessions in SQLite ask for the driver here and set
 * a `skippedReason` when it is missing, so an old Node loses one harness rather
 * than the whole scan.
 */
export async function databaseSync(): Promise<any | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return DatabaseSync;
  } catch {
    return null;
  }
}

export const NEEDS_SQLITE = "requires Node.js >= 22.5 (node:sqlite)";

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function usageBucket(models: Record<string, TokenUsage>, model: string): TokenUsage {
  return (models[model] ??= emptyUsage());
}

export function emptyReport(harness: HarnessName, dataPath: string | null): HarnessReport {
  return {
    harness,
    detected: false,
    dataPath,
    latestVersion: null,
    sessionsScanned: 0,
    sessionsIncluded: 0,
    parseErrors: 0,
    skippedReason: null,
    sessions: [],
  };
}

export function newSessionRecord(id: string, projectId: string): SessionRecord {
  return {
    id,
    projectId,
    startedAt: null,
    endedAt: null,
    isSubagent: false,
    counts: {
      userPrompts: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolErrors: 0,
      toolDenials: 0,
      interruptions: 0,
    },
    tools: {},
    models: {},
    costUsd: null,
    flags: {},
    agentic: { turns: 0, maxToolCallsPerTurn: 0, longestTurnMs: null },
    outcome: {
      prLinks: 0,
      filesChanged: null,
      additions: null,
      deletions: null,
      distinctGitBranches: null,
    },
  };
}
