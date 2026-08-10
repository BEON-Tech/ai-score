import { stat } from "node:fs/promises";
import { basename } from "node:path";
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
  usageBucket,
} from "../util.js";
import { toolOutcome, WorkflowTracker } from "../workflow.js";
import type { ToolOutcome } from "../workflow.js";

/** Flattens codex's string-or-text-block output for transient inspection. */
export function codexText(output: unknown): string {
  return Array.isArray(output)
    ? output.map((entry: any) => (typeof entry?.text === "string" ? entry.text : "")).join("\n")
    : typeof output === "string"
      ? output
      : "";
}

/**
 * Codex wraps exec output in prose rather than a structured status: the first
 * line reads "Script completed", "Script failed", "aborted by user…", or
 * "Script running with cell ID…" for a call that is still detached. Only the
 * wrapper's own verdict is read; the command output below it is never kept.
 */
export function codexOutcome(output: unknown): ToolOutcome {
  const structured = toolOutcome(output);
  if (structured !== "unknown") return structured;
  const first = codexText(output).trimStart().slice(0, 200);
  if (/^Script completed\b/.test(first)) return "success";
  if (/^(?:Script failed|exec_command failed|apply_patch verification failed)\b/.test(first)) {
    return "failure";
  }
  if (/^aborted by user\b/.test(first)) return "not-run";
  return "unknown";
}

export function codexDetachedIdFromInput(input: unknown): string | null {
  try {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const id = record["session_id"] ?? record["sessionId"] ?? record["cell_id"] ?? record["cellId"];
    return typeof id === "string" || typeof id === "number" ? String(id) : null;
  } catch {
    return null;
  }
}

export function codexDetachedIdFromOutput(output: unknown): string | null {
  return codexText(output).match(/\b(?:session|cell) ID\s+([^\s.]+)/i)?.[1] ?? null;
}

async function parseSession(
  file: string,
  report: HarnessReport,
  ctx: CollectContext,
): Promise<SessionRecord | null> {
  const s = newSessionRecord(hash16(basename(file)), "unknown");
  const models = new Set<string>();
  const efforts = new Set<string>();
  const approvalPolicies = new Set<string>();
  const collaborationModes = new Set<string>();
  let currentModel = "unknown";
  let lastTokenTotals: any = null;
  let mcpCalls = 0;
  let errors = 0;
  let gitRepo = false;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let turnStart: number | null = null;
  let turnTools = 0;
  // Desktop returns long-running exec results through later wait/write_stdin calls.
  const detachedCalls = new Map<string, string>();
  const detachedPolls = new Map<string, { processId: string; callId: string }>();
  const workflow = new WorkflowTracker({
    sequenceKnown: true,
    commandObservation: true,
    deliveryObservation: true,
  });

  const closeTurn = (endTs: number | null) => {
    if (turnStart === null) return;
    s.agentic.maxToolCallsPerTurn = Math.max(s.agentic.maxToolCallsPerTurn, turnTools);
    if (endTs !== null && endTs > turnStart) {
      s.agentic.longestTurnMs = Math.max(s.agentic.longestTurnMs ?? 0, endTs - turnStart);
    }
    turnStart = null;
    turnTools = 0;
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
    const p: any = r.payload ?? {};

    switch (r.type) {
      case "session_meta": {
        const nativeId = p.id ?? p.session_id;
        if (nativeId) s.id = hash16(String(nativeId));
        if (typeof p.cwd === "string") {
          s.projectId = hash16(p.cwd);
          workflow.projectDir(p.cwd);
        }
        if (typeof p.cli_version === "string") report.latestVersion = p.cli_version;
        if (p.git) gitRepo = true;
        if (p.parent_thread_id) s.isSubagent = true;
        break;
      }
      case "turn_context": {
        if (typeof p.model === "string") {
          currentModel = p.model;
          models.add(p.model);
        }
        if (typeof p.effort === "string") efforts.add(p.effort);
        if (typeof p.approval_policy === "string") approvalPolicies.add(p.approval_policy);
        const collab = p.collaboration_mode;
        if (typeof collab === "string") collaborationModes.add(collab);
        else if (collab && typeof collab.kind === "string") collaborationModes.add(collab.kind);
        break;
      }
      case "response_item": {
        switch (p.type) {
          case "message":
            if (p.role === "assistant") s.counts.assistantMessages++;
            break;
          case "function_call":
          case "custom_tool_call": {
            const name = typeof p.name === "string" ? p.name : "unknown";
            const callId =
              typeof p.call_id === "string" ? p.call_id : typeof p.id === "string" ? p.id : null;
            s.counts.toolCalls++;
            s.tools[name] = (s.tools[name] ?? 0) + 1;
            workflow.toolCall(name, p.arguments ?? p.input, callId);
            if (callId && ["wait", "write_stdin"].includes(name.toLowerCase())) {
              const processId = codexDetachedIdFromInput(p.arguments ?? p.input);
              const originalCallId = processId ? detachedCalls.get(processId) : null;
              if (processId && originalCallId) {
                detachedPolls.set(callId, { processId, callId: originalCallId });
              }
            }
            turnTools++;
            break;
          }
          case "function_call_output":
          case "custom_tool_call_output": {
            const output = p.output ?? p.result ?? p;
            const text = codexText(p.output ?? p.result);
            const outcome = codexOutcome(output);
            const callId =
              typeof p.call_id === "string" ? p.call_id : typeof p.id === "string" ? p.id : null;
            workflow.toolResult(outcome, callId, null, text);
            if (callId) {
              const poll = detachedPolls.get(callId);
              if (poll) {
                workflow.toolResult(outcome, poll.callId, null, text);
                if (outcome !== "unknown") {
                  detachedCalls.delete(poll.processId);
                  detachedPolls.delete(callId);
                }
              } else {
                const processId = codexDetachedIdFromOutput(output);
                if (processId) detachedCalls.set(processId, callId);
              }
            }
            break;
          }
        }
        break;
      }
      case "event_msg": {
        switch (p.type) {
          case "user_message":
            closeTurn(ts);
            s.counts.userPrompts++;
            s.agentic.turns++;
            workflow.humanTurn();
            turnStart = ts;
            break;
          case "token_count":
            if (p.info?.total_token_usage) lastTokenTotals = p.info.total_token_usage;
            break;
          case "task_complete":
            if (typeof p.duration_ms === "number") {
              s.agentic.longestTurnMs = Math.max(s.agentic.longestTurnMs ?? 0, p.duration_ms);
            }
            break;
          case "turn_aborted":
            s.counts.interruptions++;
            closeTurn(ts);
            break;
          case "error":
            errors++;
            break;
          case "mcp_tool_call_end": {
            mcpCalls++;
            const name = p.action_name ?? p.app_name ?? "unknown";
            s.counts.toolCalls++;
            s.tools[`mcp:${name}`] = (s.tools[`mcp:${name}`] ?? 0) + 1;
            turnTools++;
            break;
          }
        }
        break;
      }
    }
  }
  closeTurn(lastTs);

  if (lastTokenTotals) {
    const bucket = usageBucket(s.models, currentModel);
    bucket.input += Number(lastTokenTotals.input_tokens) || 0;
    bucket.output += Number(lastTokenTotals.output_tokens) || 0;
    bucket.cacheRead += Number(lastTokenTotals.cached_input_tokens) || 0;
    bucket.cacheWrite += Number(lastTokenTotals.cache_write_input_tokens) || 0;
    bucket.reasoning += Number(lastTokenTotals.reasoning_output_tokens) || 0;
  }

  if (lastTs !== null && lastTs < ctx.since.getTime()) return null;
  if (s.counts.userPrompts === 0 && s.counts.assistantMessages === 0) return null;

  s.startedAt = toIso(firstTs);
  s.endedAt = toIso(lastTs);
  s.flags = {
    models: [...models].sort(),
    efforts: [...efforts].sort(),
    approvalPolicies: [...approvalPolicies].sort(),
    collaborationModes: [...collaborationModes].sort(),
    mcpCalls,
    errors,
    gitRepo,
  };
  s.workflow = workflow.finish();
  return s;
}

export const codex: Adapter = {
  harness: "codex",
  async collect(ctx) {
    const roots = [home(".codex", "sessions"), home(".codex", "archived_sessions")];
    const report = emptyReport("codex", displayPath(roots[0]));
    const files = (await Promise.all(roots.map((r) => listFilesRecursive(r, ".jsonl")))).flat();
    if (files.length === 0) return report;
    report.detected = true;
    for (const file of files) {
      report.sessionsScanned++;
      try {
        const info = await stat(file);
        if (info.mtimeMs < ctx.since.getTime()) continue;
        ctx.verbose(`codex: parsing ${displayPath(file)}`);
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
