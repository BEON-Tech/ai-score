import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, HarnessReport, SessionRecord } from "../types.js";
import {
  displayPath,
  emptyReport,
  hash16,
  home,
  newSessionRecord,
  toIso,
  toMs,
  usageBucket,
} from "../util.js";
import { toolOutcome, WorkflowTracker } from "../workflow.js";
import { workspacePath } from "./cursor-ide.js";

/**
 * Copilot in VS Code persists each chat as one JSON file:
 * `User/workspaceStorage/<hash>/chatSessions/<session>.json`, the editor's
 * `ISerializableChatData` — `{version, sessionId, creationDate, requests}`
 * where every request is a user prompt with its full ordered response stream.
 * Tool calls survive as `toolInvocationSerialized` parts; token counts sit on
 * the request (`promptTokens`/`completionTokens`), but cache reads only appear
 * in the rare `modelTotals` shape, so this harness cannot be held to cache
 * evidence.
 *
 * The format never stores tool exit codes — a terminal command's outcome is
 * whatever `resultDetails` happens to reveal, usually nothing. Verification
 * evidence therefore stays `unknown` more often here than in harnesses that
 * record results, and that is the data's ceiling, not a parser gap.
 */

/** `copilot_readFile` → `read_file`, for the workflow classifier only. */
export function classifierName(toolId: string): string {
  return toolId
    .replace(/^copilot_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A serialized URI (`{scheme, path}`) reduced to a stable identity string. */
function uriKey(uri: any): string | null {
  if (typeof uri === "string") return uri;
  if (uri && typeof uri === "object" && typeof uri.path === "string") {
    return `${uri.scheme ?? "file"}:${uri.path}`;
  }
  return null;
}

/** Folds one serialized chat session into a session record. Exported for the tests. */
export function foldChatSession(data: any, projectId: string): SessionRecord | null {
  if (!data || typeof data !== "object" || !Array.isArray(data.requests)) return null;
  const s = newSessionRecord(hash16(String(data.sessionId ?? "")), projectId);
  const models = new Set<string>();
  const editedFiles = new Set<string>();
  let mcpCalls = 0;
  let subagentRuns = 0;
  let firstTs = toMs(data.creationDate);
  let lastTs = firstTs;
  const workflow = new WorkflowTracker({
    sequenceKnown: true,
    commandObservation: true,
    deliveryObservation: true,
  });

  for (const req of data.requests) {
    if (!req || typeof req !== "object") continue;
    // Hidden and system-initiated requests are the editor talking to itself.
    if (req.isHidden === true || req.isSystemInitiated === true) continue;
    const ts = toMs(req.timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    s.counts.userPrompts++;
    s.agentic.turns++;
    workflow.humanTurn();
    if (req.isCanceled === true) s.counts.interruptions++;

    const model = typeof req.modelId === "string" ? req.modelId : "unknown";
    if (model !== "unknown") models.add(model);
    const totals = Array.isArray(req.modelTotals) ? req.modelTotals : [];
    if (totals.length > 0) {
      for (const total of totals) {
        const bucket = usageBucket(
          s.models,
          typeof total?.model === "string" ? total.model : model,
        );
        bucket.input += Number(total?.inputTokens) || 0;
        bucket.output += Number(total?.outputTokens) || 0;
        bucket.cacheRead += Number(total?.cachedTokens) || 0;
      }
    } else if (
      numberOrNull(req.promptTokens) !== null ||
      numberOrNull(req.completionTokens) !== null
    ) {
      const bucket = usageBucket(s.models, model);
      bucket.input += Number(req.promptTokens) || 0;
      bucket.output += Number(req.completionTokens) || 0;
    }

    const elapsed = numberOrNull(req.elapsedMs) ?? numberOrNull(req.result?.timings?.totalElapsed);
    if (elapsed !== null && elapsed > 0) {
      s.agentic.longestTurnMs = Math.max(s.agentic.longestTurnMs ?? 0, elapsed);
      if (ts !== null) lastTs = Math.max(lastTs ?? 0, ts + elapsed);
    }

    let sawText = false;
    let turnTools = 0;
    for (const part of req.response ?? []) {
      if (!part || typeof part !== "object") continue;
      switch (part.kind) {
        case "toolInvocationSerialized": {
          const toolId = typeof part.toolId === "string" ? part.toolId : "unknown";
          s.counts.toolCalls++;
          turnTools++;
          s.tools[toolId] = (s.tools[toolId] ?? 0) + 1;
          const specific = part.toolSpecificData;
          if (specific?.kind === "subagent") subagentRuns++;
          if (specific?.kind === "mcp" || /^mcp[_.]/i.test(toolId)) mcpCalls++;
          // ToolConfirmKind.Denied serializes as {type: 0}; `false` is the
          // pre-1.104 spelling of the same decision.
          const denied = part.isConfirmed === false || part.isConfirmed?.type === 0;
          if (denied) s.counts.toolDenials++;
          const input =
            specific?.kind === "terminal" && typeof specific.commandLine?.original === "string"
              ? { command: specific.commandLine.original }
              : (specific?.rawInput ?? undefined);
          workflow.toolCall(
            classifierName(toolId),
            input,
            typeof part.toolCallId === "string" ? part.toolCallId : null,
            denied ? "not-run" : toolOutcome(part.resultDetails ?? null),
          );
          break;
        }
        // The live edit stream; only kept in older/exported sessions, but a
        // mutation whenever it appears.
        case "textEdit":
        case "textEditGroup": {
          const key = uriKey(part.uri);
          if (key) editedFiles.add(key);
          workflow.toolCall("edit_file", undefined, null, "success");
          break;
        }
        case "pullRequest":
          s.outcome.prLinks++;
          workflow.delivery("success");
          break;
        default:
          if (typeof part.value === "string" && part.value.trim().length > 0) sawText = true;
      }
    }
    if (sawText) s.counts.assistantMessages++;
    s.agentic.maxToolCallsPerTurn = Math.max(s.agentic.maxToolCallsPerTurn, turnTools);

    for (const event of req.editedFileEvents ?? []) {
      // Keep = 1; Undo (2) reverted the change and UserModification (3) was
      // the human, so neither is agent-kept work.
      if (event?.eventKind !== 1) continue;
      const key = uriKey(event.uri);
      if (key) editedFiles.add(key);
    }
  }

  if (editedFiles.size > 0) {
    s.outcome.filesChanged = editedFiles.size;
    workflow.changedSession();
  }
  s.startedAt = toIso(firstTs);
  s.endedAt = toIso(lastTs);
  s.flags = {
    models: [...models].sort(),
    mcpCalls,
    subagentRuns,
  };
  s.workflow = workflow.finish();
  return s;
}

/** VS Code's user-data dirs, stable and Insiders, per platform. */
function userDirs(): string[] {
  const products = ["Code", "Code - Insiders"];
  if (process.platform === "darwin") {
    return products.map((p) => home("Library", "Application Support", p, "User"));
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? home("AppData", "Roaming");
    return products.map((p) => join(appData, p, "User"));
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? home(".config");
  return products.map((p) => join(configHome, p, "User"));
}

/** The workspace folder is beside the sessions, in `workspace.json`. */
function projectFor(workspaceDir: string): { projectId: string; dir: string | null } {
  try {
    const folder = JSON.parse(readFileSync(join(workspaceDir, "workspace.json"), "utf8")).folder;
    if (typeof folder === "string") {
      const path = workspacePath(folder);
      // Remote workspaces reduce to a URI, not a directory on this disk.
      return { projectId: hash16(path), dir: /^(?:[A-Za-z]:)?[\\/]/.test(path) ? path : null };
    }
  } catch {
    /* a workspace with no folder — the sessions still count, the project does not */
  }
  return { projectId: "unknown", dir: null };
}

export const copilotIde: Adapter = {
  harness: "copilot-ide",
  async collect(ctx) {
    const roots = userDirs();
    const report = emptyReport("copilot-ide", displayPath(join(roots[0]!, "workspaceStorage")));
    for (const userDir of roots) {
      const workspaceRoot = join(userDir, "workspaceStorage");
      if (!existsSync(workspaceRoot)) continue;
      let workspaces: string[];
      try {
        workspaces = readdirSync(workspaceRoot);
      } catch {
        continue;
      }
      for (const workspace of workspaces) {
        const workspaceDir = join(workspaceRoot, workspace);
        const sessionsDir = join(workspaceDir, "chatSessions");
        let files: string[];
        try {
          files = (await readdir(sessionsDir)).filter((name) => name.endsWith(".json"));
        } catch {
          continue;
        }
        if (files.length === 0) continue;
        report.detected = true;
        const project = projectFor(workspaceDir);
        for (const name of files) {
          const file = join(sessionsDir, name);
          report.sessionsScanned++;
          try {
            const info = await stat(file);
            if (info.mtimeMs < ctx.since.getTime()) continue;
            ctx.verbose(`copilot-ide: parsing ${displayPath(file)}`);
            const session = foldChatSession(
              JSON.parse(await readFile(file, "utf8")),
              project.projectId,
            );
            if (!session) {
              report.parseErrors++;
              continue;
            }
            if (session.counts.userPrompts === 0 && session.counts.toolCalls === 0) continue;
            if (project.dir) ctx.recordProjectDir?.(session.id, project.dir);
            report.sessions.push(session);
            report.sessionsIncluded++;
          } catch {
            report.parseErrors++;
          }
        }
      }
    }
    return report;
  },
};
