import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Adapter, CollectContext, HarnessReport, SessionRecord } from "../types.js";
import {
  displayPath,
  emptyReport,
  hash16,
  home,
  jsonlRecords,
  listFilesRecursive,
  newSessionRecord,
  toIso,
  toMs,
  TurnClock,
  usageBucket,
} from "../util.js";
import { toolOutcome, WorkflowTracker } from "../workflow.js";
import type { ToolOutcome } from "../workflow.js";

/**
 * The GitHub Copilot CLI appends every session event to
 * `~/.copilot/session-state/<session-id>/events.jsonl`, one JSON object per
 * line: `{type, data, id, parentId, timestamp}` with dotted type names
 * (`user.message`, `tool.execution_start`, `session.shutdown`, …).
 *
 * Ephemeral events are never persisted — and `assistant.usage`, the per-request
 * token report, is ephemeral. The only token counts on disk are the per-model
 * totals inside `session.shutdown`, so a session that crashed or is still open
 * reports an empty usage bucket. The same shutdown event carries the session's
 * diff stats (`codeChanges`), with the same caveat.
 *
 * Subagents run inside the parent's event log with an `agentId` stamp rather
 * than as separate sessions: their tool calls count (they really ran against
 * the tree), but their prompts and replies are machine traffic, not the
 * engineer's.
 */

/** `success` is authoritative when present; otherwise sniff the result body. */
export function copilotOutcome(data: any): ToolOutcome {
  if (data?.success === true) return "success";
  if (data?.success === false) return "failure";
  return toolOutcome(data?.result ?? data?.error ?? null);
}

/** Folds one `events.jsonl` into a session record. Exported for the tests. */
export async function parseSession(
  file: string,
  report: HarnessReport,
  ctx: CollectContext,
): Promise<SessionRecord | null> {
  const s = newSessionRecord(hash16(basename(dirname(file))), "unknown");
  const models = new Set<string>();
  const modes = new Set<string>();
  const branches = new Set<string>();
  let currentModel = "unknown";
  let mcpCalls = 0;
  let errors = 0;
  let subagentRuns = 0;
  let hookEvents = 0;
  let skillCalls = 0;
  let gitRepo = false;
  let cwd: string | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const turnClock = new TurnClock();
  let turnTools = 0;
  const workflow = new WorkflowTracker({
    sequenceKnown: true,
    commandObservation: true,
    deliveryObservation: true,
  });

  const closeTurn = () => {
    const activeMs = turnClock.stop();
    if (activeMs === null) return;
    s.agentic.maxToolCallsPerTurn = Math.max(s.agentic.maxToolCallsPerTurn, turnTools);
    if (activeMs > 0) {
      s.agentic.longestTurnMs = Math.max(s.agentic.longestTurnMs ?? 0, activeMs);
    }
    turnTools = 0;
  };

  const readContext = (context: any) => {
    if (!context || typeof context !== "object") return;
    if (context.gitRoot || context.repository) gitRepo = true;
    if (typeof context.branch === "string" && context.branch) branches.add(context.branch);
    if (typeof context.cwd === "string" && s.projectId === "unknown") {
      cwd = context.cwd;
      s.projectId = hash16(context.cwd);
      workflow.projectDir(context.cwd);
    }
  };

  for await (const parsed of jsonlRecords(file)) {
    if (!parsed.ok) {
      report.parseErrors++;
      workflow.uncertainSequence();
      continue;
    }
    const r: any = parsed.value;
    if (!r || typeof r !== "object") {
      report.parseErrors++;
      workflow.uncertainSequence();
      continue;
    }
    const ts = toMs(r.timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    const d: any = r.data ?? {};
    const fromSubagent = typeof r.agentId === "string" && r.agentId.length > 0;

    switch (r.type) {
      case "session.start":
      case "session.resume": {
        if (typeof d.sessionId === "string") s.id = hash16(d.sessionId);
        if (typeof d.copilotVersion === "string") report.latestVersion = d.copilotVersion;
        if (typeof d.selectedModel === "string") {
          currentModel = d.selectedModel;
          models.add(d.selectedModel);
        }
        readContext(d.context);
        break;
      }
      case "session.model_change": {
        if (typeof d.newModel === "string") {
          currentModel = d.newModel;
          models.add(d.newModel);
        }
        break;
      }
      case "session.mode_changed": {
        if (typeof d.mode === "string") modes.add(d.mode);
        break;
      }
      case "user.message": {
        // `source`-stamped and autopilot-continuation messages are injected by
        // the machine; only what the engineer actually typed is a prompt.
        if (fromSubagent || d.source || d.isAutopilotContinuation === true) break;
        closeTurn();
        s.counts.userPrompts++;
        s.agentic.turns++;
        workflow.humanTurn();
        turnClock.start(ts);
        break;
      }
      case "assistant.message": {
        if (!fromSubagent && typeof d.content === "string" && d.content.trim().length > 0) {
          s.counts.assistantMessages++;
        }
        break;
      }
      case "tool.execution_start": {
        const isMcp = typeof d.mcpServerName === "string" && d.mcpServerName.length > 0;
        const name = isMcp
          ? `mcp:${typeof d.mcpToolName === "string" ? d.mcpToolName : d.toolName}`
          : typeof d.toolName === "string"
            ? d.toolName
            : "unknown";
        if (isMcp) mcpCalls++;
        s.counts.toolCalls++;
        s.tools[name] = (s.tools[name] ?? 0) + 1;
        workflow.toolCall(
          name,
          d.arguments,
          typeof d.toolCallId === "string" ? d.toolCallId : null,
        );
        turnTools++;
        break;
      }
      case "tool.execution_complete": {
        if (d.success === false) s.counts.toolErrors++;
        workflow.toolResult(
          copilotOutcome(d),
          typeof d.toolCallId === "string" ? d.toolCallId : null,
          null,
          typeof d.result?.content === "string" ? d.result.content : (d.error?.message ?? null),
        );
        break;
      }
      case "permission.completed": {
        const kind = d.result?.kind;
        if (typeof kind === "string" && kind.startsWith("denied")) s.counts.toolDenials++;
        break;
      }
      case "abort": {
        s.counts.interruptions++;
        closeTurn();
        break;
      }
      case "session.error":
        errors++;
        break;
      case "subagent.started":
        subagentRuns++;
        break;
      case "skill.invoked":
        skillCalls++;
        break;
      case "hook.start":
        hookEvents++;
        break;
      case "session.shutdown": {
        for (const [model, metric] of Object.entries<any>(d.modelMetrics ?? {})) {
          const usage = metric?.usage;
          if (!usage) continue;
          const bucket = usageBucket(s.models, model);
          bucket.input += Number(usage.inputTokens) || 0;
          bucket.output += Number(usage.outputTokens) || 0;
          bucket.cacheRead += Number(usage.cacheReadTokens) || 0;
          bucket.cacheWrite += Number(usage.cacheWriteTokens) || 0;
          bucket.reasoning += Number(usage.reasoningTokens) || 0;
        }
        const changes = d.codeChanges;
        if (changes && typeof changes === "object") {
          const files = Array.isArray(changes.filesModified) ? changes.filesModified.length : 0;
          const added = Number(changes.linesAdded) || 0;
          const removed = Number(changes.linesRemoved) || 0;
          s.outcome.filesChanged = files;
          s.outcome.additions = added;
          s.outcome.deletions = removed;
          if (files > 0 || added > 0 || removed > 0) workflow.changedSession();
        }
        break;
      }
    }
    turnClock.tick(ts);
  }
  closeTurn();

  if (lastTs !== null && lastTs < ctx.since.getTime()) return null;
  if (s.counts.userPrompts === 0 && s.counts.assistantMessages === 0) return null;

  if (currentModel !== "unknown") models.add(currentModel);
  s.startedAt = toIso(firstTs);
  s.endedAt = toIso(lastTs);
  s.outcome.distinctGitBranches = branches.size > 0 ? branches.size : null;
  s.flags = {
    models: [...models].sort(),
    modes: [...modes].sort(),
    mcpCalls,
    errors,
    gitRepo,
    subagentRuns,
    hookEvents,
    skillCalls,
  };
  s.workflow = workflow.finish();
  // `session.shutdown` carries the real diff stats, but a session that
  // crashed or is still open never wrote one — fall back to the estimate the
  // successful edit calls imply rather than reporting nothing.
  const estimated = workflow.estimatedOutcome();
  s.outcome.additions ??= estimated.additions;
  s.outcome.deletions ??= estimated.deletions;
  s.outcome.filesChanged ??= estimated.filesChanged;
  if (cwd) ctx.recordProjectDir?.(s.id, cwd);
  return s;
}

export const copilotCli: Adapter = {
  harness: "copilot-cli",
  async collect(ctx) {
    const root = home(".copilot", "session-state");
    const report = emptyReport("copilot-cli", displayPath(root));
    const files = (await listFilesRecursive(root, "events.jsonl")).filter(
      (file) => basename(file) === "events.jsonl",
    );
    if (files.length === 0) return report;
    report.detected = true;
    for (const file of files) {
      report.sessionsScanned++;
      try {
        const info = await stat(file);
        if (info.mtimeMs < ctx.since.getTime()) continue;
        ctx.verbose(`copilot-cli: parsing ${displayPath(file)}`);
        const session = await parseSession(file, report, ctx);
        if (session) {
          report.sessions.push(session);
          report.sessionsIncluded++;
        }
      } catch {
        report.parseErrors++;
      }
    }
    return report;
  },
};
