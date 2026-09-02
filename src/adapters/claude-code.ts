import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapter, CollectContext, HarnessReport, SessionRecord } from "../types.js";
import {
  displayPath,
  emptyReport,
  hash16,
  home,
  type JsonlLine,
  jsonlRecords,
  newSessionRecord,
  PromptGauge,
  toIso,
  toMs,
  TurnClock,
  usageBucket,
} from "../util.js";
import { toolOutcome, WorkflowTracker } from "../workflow.js";

const INTERRUPT_MARKERS = ["[Request interrupted by user", "[Request cancelled by user"];

/**
 * Claude Code running inside the Claude desktop app (agent mode / Cowork)
 * keeps each sandbox's own `.claude/projects` tree here instead of under
 * `~/.claude`, in the identical format:
 * `local-agent-mode-sessions/<account>/<workspace>/local_<id>/.claude/projects/`.
 * One engineer had 85% of their Claude Code activity there; the CLI read none.
 */
const desktopAppSessionRoots = () => [
  home("Library", "Application Support", "Claude", "local-agent-mode-sessions"),
  join(process.env.APPDATA ?? home("AppData", "Roaming"), "Claude", "local-agent-mode-sessions"),
  home(".config", "Claude", "local-agent-mode-sessions"),
];

/** `.claude/projects` trees whose `.claude` sits up to `depth` directories below `dir`. */
async function nestedProjectRoots(dir: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".claude") out.push(join(dir, ".claude", "projects"));
    else if (depth > 0) out.push(...(await nestedProjectRoots(join(dir, entry.name), depth - 1)));
  }
  return out;
}

/**
 * Time-ordered merge of transcripts that are each already in time order. The
 * earliest stream wins ties and a record without a timestamp inherits its
 * predecessor's, so within one file the original order always survives.
 */
async function* mergeByTimestamp(streams: AsyncGenerator<JsonlLine>[]): AsyncGenerator<JsonlLine> {
  const heads = await Promise.all(
    streams.map(async (stream) => ({ stream, next: await stream.next(), ts: -Infinity })),
  );
  const stamp = (head: (typeof heads)[number]) => {
    if (head.next.done || !head.next.value.ok) return;
    const ts = toMs((head.next.value.value as any)?.timestamp);
    if (ts !== null) head.ts = ts;
  };
  heads.forEach(stamp);
  for (;;) {
    let pick: (typeof heads)[number] | null = null;
    for (const head of heads) {
      if (!head.next.done && (pick === null || head.ts < pick.ts)) pick = head;
    }
    if (pick === null || pick.next.done) return;
    yield pick.next.value;
    pick.next = await pick.stream.next();
    stamp(pick);
  }
}

/**
 * The session's records with its subagents' transcripts merged back in.
 * Claude Code used to inline subagent traffic as `isSidechain` records, which
 * the parser below reads; current versions write each subagent to
 * `<project>/<session-id>/subagents/agent-<id>.jsonl` instead. Left out, a
 * delegated test run is invisible and the session that delegated it reads as
 * never having checked — 46 of one engineer's 67 coding sessions.
 */
async function* sessionRecords(file: string, nativeId: string): AsyncGenerator<JsonlLine> {
  const subagentDir = join(dirname(file), nativeId, "subagents");
  let subagentFiles: string[] = [];
  try {
    subagentFiles = (await readdir(subagentDir))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort()
      .map((entry) => join(subagentDir, entry));
  } catch {
    // No subagents directory — the common case.
  }
  if (subagentFiles.length === 0) return yield* jsonlRecords(file);
  yield* mergeByTimestamp([file, ...subagentFiles].map((path) => jsonlRecords(path)));
}

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

export async function parseSession(
  file: string,
  projectSlug: string,
  nativeId: string,
  report: HarnessReport,
  ctx: CollectContext,
): Promise<SessionRecord | null> {
  const s = newSessionRecord(hash16(nativeId), hash16(projectSlug));
  const prompts = new PromptGauge(s.counts);
  const usageByRequest = new Map<string, { model: string; usage: any }>();
  const branches = new Set<string>();
  const modes = new Set<string>();
  const permissionModes = new Set<string>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let sidechainMessages = 0;
  let hookEvents = 0;
  let compactions = 0;
  let autoCompactions = 0;
  let manualCompactions = 0;
  let peakContextTokens = 0;
  let slashCommands = 0;
  let mcpCalls = 0;
  const turnClock = new TurnClock();
  let turnTools = 0;
  let cwd: string | null = null;
  const prSeen = new Set<string>();
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

  for await (const parsed of sessionRecords(file, nativeId)) {
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
    // The newest version seen, not the last one read — files scan in
    // directory order, and the desktop app's sandboxes run ahead of the CLI.
    if (
      typeof r.version === "string" &&
      (report.latestVersion === null ||
        r.version.localeCompare(report.latestVersion, undefined, { numeric: true }) > 0)
    ) {
      report.latestVersion = r.version;
    }
    if (typeof r.cwd === "string" && r.cwd) {
      cwd ??= r.cwd;
      workflow.projectDir(r.cwd);
    }
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
      case "pr-link": {
        // The same PR is re-recorded many times in one session (observed:
        // dozens of records for one URL), so count distinct PRs, not records.
        const prKey =
          typeof r.prUrl === "string" && r.prUrl
            ? r.prUrl
            : r.prNumber != null
              ? `${r.prRepository ?? ""}#${r.prNumber}`
              : null;
        if (prKey === null) s.outcome.prLinks++;
        else if (!prSeen.has(prKey)) {
          prSeen.add(prKey);
          s.outcome.prLinks++;
        }
        break;
      }
      case "system":
        if (typeof r.hookCount === "number" && r.hookCount > 0) hookEvents++;
        if (typeof r.subtype === "string" && r.subtype.includes("compact")) {
          compactions++;
          // A boundary without a trigger counts only into the total, so
          // autoCompactions + manualCompactions ≤ compactions by construction.
          const trigger = r.compactMetadata?.trigger;
          if (trigger === "auto") autoCompactions++;
          else if (trigger === "manual") manualCompactions++;
        }
        break;
      case "user": {
        const content = Array.isArray(r.message?.content) ? r.message.content : [];
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          // `is_error` is optional in Claude Code records and only ever written
          // on failures (denials and interrupts included). A result block that
          // arrives without it is a completed, successful call — most blocks
          // carry no other structured outcome for toolOutcome to read.
          const outcome = toolOutcome(block);
          if (block.is_error === true) s.counts.toolErrors++;
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((entry: any) => (typeof entry?.text === "string" ? entry.text : ""))
                    .join("\n")
                : null;
          const settled = outcome === "unknown" && block.is_error !== true ? "success" : outcome;
          const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
          workflow.toolResult(settled, callId, null, text);
        }
        if (typeof r.permissionMode === "string") permissionModes.add(r.permissionMode);
        if (r.toolDenialKind !== undefined && r.toolDenialKind !== null) s.counts.toolDenials++;
        if (r.isMeta === true || r.isSidechain === true) break;
        if (isToolResultCarrier(r)) break;
        const text = messageText(r.message);
        if (INTERRUPT_MARKERS.some((m) => text.includes(m))) {
          s.counts.interruptions++;
          closeTurn();
          break;
        }
        closeTurn();
        s.counts.userPrompts++;
        // A slash command is harness markup around a skill the engineer
        // described once, elsewhere: it counts as a prompt (Leverage) but not
        // as a description (words, re-sends) — see `describedPrompts`.
        if (text.includes("<command-name>")) slashCommands++;
        else prompts.add(text);
        s.agentic.turns++;
        workflow.humanTurn();
        turnClock.start(ts);
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
          workflow.toolCall(
            block.name,
            block.input,
            typeof block.id === "string" ? block.id : null,
          );
          if (block.name.startsWith("mcp__")) mcpCalls++;
          if (r.isSidechain !== true) turnTools++;
        }
        break;
      }
    }
    // Every record advances the active-time clock while a turn is open —
    // including tool-result carriers, which never reach the switch above.
    turnClock.tick(ts);
  }
  closeTurn();

  for (const { model, usage } of usageByRequest.values()) {
    const bucket = usageBucket(s.models, model);
    const input = Number(usage.input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
    bucket.input += input;
    bucket.output += Number(usage.output_tokens) || 0;
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite += cacheWrite;
    // One request's prompt tokens ≈ the live context at that moment; the max
    // over the session is how close the engineer ran to the window's ceiling.
    peakContextTokens = Math.max(peakContextTokens, input + cacheRead + cacheWrite);
  }

  if (lastTs !== null && lastTs < ctx.since.getTime()) return null;
  if (s.counts.userPrompts === 0 && usageByRequest.size === 0) return null;

  s.startedAt = toIso(firstTs);
  s.endedAt = toIso(lastTs);
  s.workflow = workflow.finish();
  // Null when no edit succeeded — "nothing measured", never "measured zero".
  const estimated = workflow.estimatedOutcome();
  s.outcome.additions = estimated.additions;
  s.outcome.deletions = estimated.deletions;
  s.outcome.filesChanged = estimated.filesChanged;
  s.outcome.distinctGitBranches = branches.size;
  if (cwd) ctx.recordProjectDir?.(s.id, cwd);
  s.flags = {
    modes: [...modes].sort(),
    permissionModes: [...permissionModes].sort(),
    sidechainMessages,
    subagentRuns: s.tools["Agent"] ?? 0,
    hookEvents,
    compactions,
    autoCompactions,
    manualCompactions,
    slashCommands,
    mcpCalls,
    // Absent, not zero, when no usage record exists — the server reads flag
    // absence as "not measured".
    ...(usageByRequest.size > 0 ? { peakContextTokens } : {}),
  };
  return s;
}

export const claudeCode: Adapter = {
  harness: "claude-code",
  async collect(ctx) {
    const root = home(".claude", "projects");
    const report = emptyReport("claude-code", displayPath(root));
    const roots = [
      root,
      ...(
        await Promise.all(desktopAppSessionRoots().map((dir) => nestedProjectRoots(dir, 3)))
      ).flat(),
    ];
    for (const projectsRoot of roots) {
      let projectDirs: string[];
      try {
        projectDirs = await readdir(projectsRoot);
      } catch {
        continue;
      }
      report.detected = true;
      for (const project of projectDirs) {
        const projectPath = join(projectsRoot, project);
        let entries: string[];
        try {
          entries = await readdir(projectPath);
        } catch {
          continue;
        }
        // Only the session transcripts themselves: a session's subagent files
        // live in a sibling directory and are read by parseSession as part of it.
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
    }
    return report;
  },
};
