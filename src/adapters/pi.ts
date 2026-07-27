import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, CollectContext, HarnessReport, SessionRecord } from '../types.js';
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
} from '../util.js';

async function parseSession(
  file: string,
  projectSlug: string,
  report: HarnessReport,
  ctx: CollectContext,
): Promise<SessionRecord | null> {
  const s = newSessionRecord(hash16(file), hash16(projectSlug));
  let cost = 0;
  let hasCost = false;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
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
    if (!r || typeof r !== 'object') {
      report.parseErrors++;
      continue;
    }
    const ts = toMs(r.timestamp);
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    if (r.type === 'session') {
      if (typeof r.id === 'string') s.id = hash16(r.id);
      if (typeof r.cwd === 'string') s.projectId = hash16(r.cwd);
      if (typeof r.version === 'string') report.latestVersion = r.version;
      continue;
    }
    if (r.type !== 'message') continue;
    const m: any = r.message ?? {};
    switch (m.role) {
      case 'user':
        closeTurn(ts);
        s.counts.userPrompts++;
        s.agentic.turns++;
        turnStart = ts;
        break;
      case 'assistant': {
        s.counts.assistantMessages++;
        if (m.stopReason === 'aborted') s.counts.interruptions++;
        const model = `${m.provider ?? 'unknown'}/${m.model ?? 'unknown'}`;
        const usage = m.usage ?? {};
        const bucket = usageBucket(s.models, model);
        bucket.input += Number(usage.input) || 0;
        bucket.output += Number(usage.output) || 0;
        bucket.cacheRead += Number(usage.cacheRead) || 0;
        bucket.cacheWrite += Number(usage.cacheWrite) || 0;
        if (typeof usage.cost === 'number') {
          cost += usage.cost;
          hasCost = true;
        }
        const content = Array.isArray(m.content) ? m.content : [];
        for (const block of content) {
          if (block?.type !== 'toolCall' || typeof block.name !== 'string') continue;
          s.counts.toolCalls++;
          s.tools[block.name] = (s.tools[block.name] ?? 0) + 1;
          turnTools++;
        }
        break;
      }
      case 'toolResult':
        if (m.isError === true) s.counts.toolErrors++;
        break;
    }
  }
  closeTurn(lastTs);

  if (lastTs !== null && lastTs < ctx.since.getTime()) return null;
  if (s.counts.userPrompts === 0 && s.counts.assistantMessages === 0) return null;

  s.startedAt = toIso(firstTs);
  s.endedAt = toIso(lastTs);
  s.costUsd = hasCost ? cost : null;
  return s;
}

export const pi: Adapter = {
  harness: 'pi',
  async collect(ctx) {
    const root = home('.pi', 'agent', 'sessions');
    const report = emptyReport('pi', displayPath(root));
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
        if (!entry.endsWith('.jsonl')) continue;
        const file = join(projectPath, entry);
        report.sessionsScanned++;
        try {
          const info = await stat(file);
          if (info.mtimeMs < ctx.since.getTime()) continue;
          ctx.verbose(`pi: parsing ${displayPath(file)}`);
          const session = await parseSession(file, project, report, ctx);
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
