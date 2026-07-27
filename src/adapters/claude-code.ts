import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, CollectContext, HarnessReport, SessionRecord } from "../types.js";
import {
  displayPath,
  emptyReport,
  hash16,
  home,
  jsonlRecords,
  newSessionRecord,
  toIso,
  toMs,
  usageBucket,
} from "../util.js";

const INTERRUPT_MARKERS = ["[Request interrupted by user", "[Request cancelled by user"];

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

function isToolResultCarrier(record: any): boolean {
  if (record.toolUseResult !== undefined) return true;
  const content = record.message?.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b: any) => b?.type === "tool_result")
  );
}

async function parseSession(
  file: string,
  projectSlug: string,
  nativeId: string,
  report: HarnessReport,
  ctx: CollectContext,
): Promise<SessionRecord | null> {
  const s = newSessionRecord(hash16(nativeId), hash16(projectSlug));
  const usageByRequest = new Map<string, { model: string; usage: any }>();
  const branches = new Set<string>();
  const modes = new Set<string>();
  const permissionModes = new Set<string>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let sidechainMessages = 0;
  let hookEvents = 0;
  let compactions = 0;
  let slashCommands = 0;
  let mcpCalls = 0;
  let turnStart: number | null = null;
  let turnTools = 0;

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
      continue;
    }
    const r: any = parsed.value;
    if (!r || typeof r !== "object") {
      report.parseErrors++;
      continue;
    }
    const ts = toMs(r.timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (typeof r.version === "string") report.latestVersion = r.version;
    if (typeof r.gitBranch === "string" && r.gitBranch) branches.add(r.gitBranch);
    if (r.isSidechain === true && (r.type === "user" || r.type === "assistant"))
      sidechainMessages++;

    switch (r.type) {
      case "mode":
        if (typeof r.mode === "string") modes.add(r.mode);
        break;
      case "permission-mode":
        if (typeof r.permissionMode === "string") permissionModes.add(r.permissionMode);
        break;
      case "pr-link":
        s.outcome.prLinks++;
        break;
      case "system":
        if (typeof r.hookCount === "number" && r.hookCount > 0) hookEvents++;
        if (typeof r.subtype === "string" && r.subtype.includes("compact")) compactions++;
        break;
      case "user": {
        if (typeof r.permissionMode === "string") permissionModes.add(r.permissionMode);
        if (r.toolDenialKind !== undefined && r.toolDenialKind !== null) s.counts.toolDenials++;
        if (r.isMeta === true || r.isSidechain === true) break;
        if (isToolResultCarrier(r)) break;
        const text = messageText(r.message);
        if (INTERRUPT_MARKERS.some((m) => text.includes(m))) {
          s.counts.interruptions++;
          closeTurn(ts);
          break;
        }
        if (text.includes("<command-name>")) slashCommands++;
        closeTurn(ts);
        s.counts.userPrompts++;
        s.agentic.turns++;
        turnStart = ts;
        break;
      }
      case "assistant": {
        if (r.isSidechain !== true) s.counts.assistantMessages++;
        const message = r.message ?? {};
        if (message.usage && typeof message.usage === "object") {
          const model = typeof message.model === "string" ? message.model : "unknown";
          const key = String(r.requestId ?? message.id ?? r.uuid ?? usageByRequest.size);
          usageByRequest.set(key, { model, usage: message.usage });
        }
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
          s.counts.toolCalls++;
          s.tools[block.name] = (s.tools[block.name] ?? 0) + 1;
          if (block.name.startsWith("mcp__")) mcpCalls++;
          if (r.isSidechain !== true) turnTools++;
        }
        break;
      }
    }
  }
  closeTurn(lastTs);

  for (const { model, usage } of usageByRequest.values()) {
    const bucket = usageBucket(s.models, model);
    bucket.input += Number(usage.input_tokens) || 0;
    bucket.output += Number(usage.output_tokens) || 0;
    bucket.cacheRead += Number(usage.cache_read_input_tokens) || 0;
    bucket.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
  }

  if (lastTs !== null && lastTs < ctx.since.getTime()) return null;
  if (s.counts.userPrompts === 0 && usageByRequest.size === 0) return null;

  s.startedAt = toIso(firstTs);
  s.endedAt = toIso(lastTs);
  s.outcome.distinctGitBranches = branches.size;
  s.flags = {
    modes: [...modes].sort(),
    permissionModes: [...permissionModes].sort(),
    sidechainMessages,
    subagentRuns: s.tools["Agent"] ?? 0,
    hookEvents,
    compactions,
    slashCommands,
    mcpCalls,
  };
  return s;
}

export const claudeCode: Adapter = {
  harness: "claude-code",
  async collect(ctx) {
    const root = home(".claude", "projects");
    const report = emptyReport("claude-code", displayPath(root));
    let projectDirs: string[];
    try {
      projectDirs = await readdir(root);
    } catch {
      return report;
    }
    report.detected = true;
    for (const project of projectDirs) {
      const projectPath = join(root, project);
      let entries: string[];
      try {
        entries = await readdir(projectPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const file = join(projectPath, entry);
        report.sessionsScanned++;
        try {
          const info = await stat(file);
          if (info.mtimeMs < ctx.since.getTime()) continue;
          ctx.verbose(`claude-code: parsing ${displayPath(file)}`);
          const session = await parseSession(file, project, entry.slice(0, -6), report, ctx);
          if (session) {
            report.sessions.push(session);
            report.sessionsIncluded++;
          }
        } catch {
          report.parseErrors++;
        }
      }
    }
    return report;
  },
};
