import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, HarnessReport, SessionRecord } from "../types.js";
import {
  databaseSync,
  displayPath,
  emptyReport,
  hash16,
  home,
  NEEDS_SQLITE,
  newSessionRecord,
  resultTextOf,
  toIso,
  toMs,
  usageBucket,
} from "../util.js";
import { toolOutcome, WorkflowTracker } from "../workflow.js";

/**
 * The Cursor desktop app is a VS Code fork, so its chat history lives in the
 * editor's state database rather than in files: `globalStorage/state.vscdb`,
 * table `cursorDiskKV`, one JSON row per composer (`composerData:<id>`) and one
 * per message (`bubbleId:<composerId>:<bubbleId>`).
 *
 * The composer row carries the ordered list of its message ids, so the messages
 * are fetched by primary key instead of scanned — the database routinely runs
 * to hundreds of megabytes, most of it context and diffs this adapter never
 * touches.
 */

/** A composer's project hash plus, for local folders, the folder itself. */
export interface ComposerProject {
  projectId: string;
  /** Raw local path — consulted for git history, never serialized. */
  dir: string | null;
}

/** Composers are workspace-scoped; the mapping only exists in workspaceStorage. */
export function projectsByComposer(
  workspaceRoot: string,
  DatabaseSync: any,
): Map<string, ComposerProject> {
  const map = new Map<string, ComposerProject>();
  let dirs: string[];
  try {
    dirs = readdirSync(workspaceRoot);
  } catch {
    return map;
  }
  for (const dir of dirs) {
    const dbPath = join(workspaceRoot, dir, "state.vscdb");
    if (!existsSync(dbPath)) continue;
    let folder: string | null = null;
    try {
      folder = JSON.parse(readFileSync(join(workspaceRoot, dir, "workspace.json"), "utf8")).folder;
    } catch {
      /* a workspace with no folder — the composers still count, the project does not */
    }
    const path = folder ? workspacePath(folder) : null;
    const project: ComposerProject = {
      projectId: hash16(path ?? dir),
      // Remote workspaces reduce to a URI, not a directory on this disk.
      dir: path && /^(?:[A-Za-z]:)?[\\/]/.test(path) ? path : null,
    };
    let db: any;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("composer.composerData");
      for (const composer of JSON.parse(String(row?.value ?? "{}")).allComposers ?? []) {
        if (typeof composer?.composerId === "string") map.set(composer.composerId, project);
      }
    } catch {
      /* an unreadable workspace costs its composers a project id, nothing more */
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }
  return map;
}

/**
 * Workspace folders are URIs. Local ones reduce to the path, so a project hashes
 * the same here as it would from any harness that sees a plain directory; remote
 * ones have no path to speak of and hash as themselves.
 */
export function workspacePath(folder: string): string {
  try {
    const url = new URL(folder);
    if (url.protocol === "file:") return decodeURIComponent(url.pathname);
  } catch {
    /* not a URI — take it as written */
  }
  return folder;
}

/**
 * Every bubble is a message, but not every message is a reply: Cursor emits a
 * separate bubble for each tool call and each block of thinking, and the
 * majority of them carry no prose at all. Counting those as assistant messages
 * would inflate the count several-fold against harnesses that record one
 * message per API response, so a reply is a bubble that actually says
 * something, and the rest are counted as what they are.
 */
function bubbleKind(b: any): "user" | "tool" | "thought" | "assistant" {
  if (b.type === 1) return "user";
  if (b.toolFormerData) return "tool";
  if (typeof b.text === "string" && b.text.trim().length > 0) return "assistant";
  return "thought";
}

/** The epoch-millisecond fields of a bubble's timing block, oldest first. */
function bubbleTimes(b: any): number[] {
  const timing = b.timingInfo ?? {};
  // `clientStartTime` is a monotonic reading, not a clock — it is not a time.
  return [timing.clientRpcSendTime, timing.clientSettleTime, timing.clientEndTime]
    .map(toMs)
    .filter((t): t is number => t !== null)
    .sort((a, b2) => a - b2);
}

/**
 * Folds a composer and its bubbles, in conversation order, into a session
 * record. Exported for the tests, which pass plain objects.
 */
export function foldComposer(
  composer: any,
  bubbles: any[],
  projectId: string,
  isSubagent: boolean,
  sequenceKnown = true,
): SessionRecord {
  const s = newSessionRecord(hash16(String(composer.composerId)), projectId);
  s.isSubagent = isSubagent;

  const sessionModel = composer.modelConfig?.modelName;
  const models = new Set<string>();
  let mcpCalls = 0;
  let thinking = 0;
  // Turn membership and turn duration are tracked apart on purpose: only some
  // bubbles carry a clock, and a turn whose timings are missing must still
  // contribute its tool count.
  let inTurn = false;
  let turnStart: number | null = null;
  let turnEnd: number | null = null;
  let turnTools = 0;
  const workflow = new WorkflowTracker({
    sequenceKnown,
    commandObservation: true,
    deliveryObservation: true,
  });

  const closeTurn = () => {
    if (!inTurn) return;
    s.agentic.maxToolCallsPerTurn = Math.max(s.agentic.maxToolCallsPerTurn, turnTools);
    if (turnStart !== null && turnEnd !== null && turnEnd > turnStart) {
      s.agentic.longestTurnMs = Math.max(s.agentic.longestTurnMs ?? 0, turnEnd - turnStart);
    }
    inTurn = false;
    turnStart = null;
    turnEnd = null;
    turnTools = 0;
  };

  for (const b of bubbles) {
    const times = bubbleTimes(b);
    const kind = bubbleKind(b);

    if (kind === "user") {
      closeTurn();
      s.counts.userPrompts++;
      s.agentic.turns++;
      workflow.humanTurn();
      inTurn = true;
      turnStart = times[0] ?? null;
    }
    if (times.length > 0) {
      turnStart ??= times[0] as number;
      turnEnd = Math.max(turnEnd ?? 0, times[times.length - 1] as number);
    }
    const pullRequests = Array.isArray(b.pullRequests) ? b.pullRequests.length : 0;
    s.outcome.prLinks += pullRequests;

    const model = b.modelInfo?.modelName ?? sessionModel;
    if (typeof model === "string") models.add(model);
    const tokens = b.tokenCount ?? {};
    const input = Number(tokens.inputTokens) || 0;
    const output = Number(tokens.outputTokens) || 0;
    if (input > 0 || output > 0) {
      const bucket = usageBucket(s.models, typeof model === "string" ? model : "unknown");
      bucket.input += input;
      bucket.output += output;
    }

    if (kind === "assistant") s.counts.assistantMessages++;
    if (kind === "thought") thinking++;
    if (kind !== "tool") continue;

    const tool = b.toolFormerData ?? {};
    const name = typeof tool.name === "string" ? tool.name : "unknown";
    s.counts.toolCalls++;
    s.tools[name] = (s.tools[name] ?? 0) + 1;
    workflow.toolCall(
      name,
      tool.input ?? tool.args ?? tool.params ?? tool,
      typeof tool.callId === "string"
        ? tool.callId
        : typeof tool.toolCallId === "string"
          ? tool.toolCallId
          : null,
      toolOutcome(tool),
      // The recorded result is the only path to a piped check's verdict.
      resultTextOf(tool.result ?? tool.output),
    );
    turnTools++;
    if (name.startsWith("mcp")) mcpCalls++;
    if (tool.status === "error") s.counts.toolErrors++;
    // A cancelled call is the agent being stopped mid-turn — the only place the
    // desktop app records an interruption at all.
    if (tool.status === "cancelled") s.counts.interruptions++;
    if (tool.userDecision === "rejected") s.counts.toolDenials++;
  }
  closeTurn();

  const createdAt = toMs(composer.createdAt);
  const lastUpdatedAt = toMs(composer.lastUpdatedAt);
  s.startedAt = toIso(createdAt);
  s.endedAt = toIso(lastUpdatedAt ?? createdAt);

  // `usageData` covers the requests Cursor billed separately; subscription
  // requests are recorded with no cost at all, so most sessions have none.
  let cents = 0;
  let requests = 0;
  let billed = false;
  for (const entry of Object.values<any>(composer.usageData ?? {})) {
    cents += Number(entry?.costInCents) || 0;
    requests += Number(entry?.amount) || 0;
    billed = true;
  }
  s.costUsd = billed ? cents / 100 : null;

  s.outcome.additions = numberOrNull(composer.totalLinesAdded);
  s.outcome.deletions = numberOrNull(composer.totalLinesRemoved);
  s.outcome.filesChanged = numberOrNull(composer.filesChangedCount);
  if (
    (s.outcome.additions ?? 0) > 0 ||
    (s.outcome.deletions ?? 0) > 0 ||
    (s.outcome.filesChanged ?? 0) > 0
  ) {
    workflow.changedSession();
  }

  s.flags = {
    modes: composer.unifiedMode ? [String(composer.unifiedMode)] : [],
    models: [...models].sort(),
    mcpCalls,
    maxMode: composer.modelConfig?.maxMode === true,
    isAgentic: composer.isAgentic === true,
    billedRequests: requests,
    thinkingBlocks: thinking,
  };
  s.workflow = workflow.finish();
  return s;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Where the fork keeps its user data, per platform. */
function globalStorage(): string {
  if (process.platform === "darwin") {
    return home("Library", "Application Support", "Cursor", "User", "globalStorage");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? home("AppData", "Roaming");
    return join(appData, "Cursor", "User", "globalStorage");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? home(".config");
  return join(configHome, "Cursor", "User", "globalStorage");
}

/** Read alongside the composers; the app does not stamp its version into them. */
function appVersion(db: any): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursor.startupMetrics.lastVersion");
    const value = row?.value === undefined ? null : String(row.value).replace(/^"|"$/g, "");
    return value && /^[\d.]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function collectSessions(
  db: any,
  report: HarnessReport,
  ctx: any,
  projects: Map<string, ComposerProject>,
) {
  const composers: any[] = [];
  const subComposerIds = new Set<string>();
  for (const row of db
    .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
    .all()) {
    let composer: any;
    try {
      composer = JSON.parse(String(row.value));
    } catch {
      report.parseErrors++;
      continue;
    }
    // Deleting a chat leaves its key behind holding `null`. That is a tombstone,
    // not a session and not a parse failure — it belongs in neither count.
    if (composer === null) continue;
    if (typeof composer.composerId !== "string") {
      report.parseErrors++;
      continue;
    }
    report.sessionsScanned++;
    for (const id of composer.subComposerIds ?? []) {
      if (typeof id === "string") subComposerIds.add(id);
    }
    composers.push(composer);
  }

  const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  for (const composer of composers) {
    const touched = toMs(composer.lastUpdatedAt) ?? toMs(composer.createdAt);
    if (touched === null || touched < ctx.since.getTime()) continue;
    ctx.verbose(`cursor-ide: composer ${composer.composerId}`);

    const bubbles: any[] = [];
    let sequenceKnown = true;
    for (const header of composer.fullConversationHeadersOnly ?? []) {
      if (typeof header?.bubbleId !== "string") continue;
      const row = bubbleStmt.get(`bubbleId:${composer.composerId}:${header.bubbleId}`);
      if (!row) {
        sequenceKnown = false;
        continue;
      }
      try {
        const bubble = JSON.parse(String(row.value));
        // The header knows the role even when the bubble has dropped its own.
        if (bubble && typeof bubble === "object") bubbles.push({ type: header.type, ...bubble });
      } catch {
        report.parseErrors++;
        sequenceKnown = false;
      }
    }

    const project = projects.get(composer.composerId);
    const s = foldComposer(
      composer,
      bubbles,
      project?.projectId ?? "unknown",
      subComposerIds.has(composer.composerId),
      sequenceKnown,
    );
    if (
      s.counts.userPrompts === 0 &&
      s.counts.assistantMessages === 0 &&
      s.counts.toolCalls === 0
    ) {
      continue;
    }
    if (project?.dir) ctx.recordProjectDir?.(s.id, project.dir);
    report.sessions.push(s);
    report.sessionsIncluded++;
  }
}

export const cursorIde: Adapter = {
  harness: "cursor-ide",
  async collect(ctx) {
    const storage = globalStorage();
    const dbPath = join(storage, "state.vscdb");
    const report = emptyReport("cursor-ide", displayPath(storage));
    if (!existsSync(dbPath)) return report;
    report.detected = true;

    const DatabaseSync = await databaseSync();
    if (!DatabaseSync) {
      report.skippedReason = `reading Cursor data ${NEEDS_SQLITE}`;
      return report;
    }

    let db: any;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (err) {
      report.skippedReason = `could not open database: ${(err as Error).message}`;
      return report;
    }

    try {
      report.latestVersion = appVersion(db);
      const projects = projectsByComposer(join(dirname(storage), "workspaceStorage"), DatabaseSync);
      collectSessions(db, report, ctx, projects);
    } catch (err) {
      report.skippedReason = `query failed: ${(err as Error).message}`;
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    return report;
  },
};
