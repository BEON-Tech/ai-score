import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "../types.js";
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

export const opencode: Adapter = {
  harness: "opencode",
  async collect(ctx) {
    const dataHome = process.env.XDG_DATA_HOME ?? home(".local", "share");
    const dbPath = join(dataHome, "opencode", "opencode.db");
    const report = emptyReport("opencode", displayPath(dbPath));
    if (!existsSync(dbPath)) return report;
    report.detected = true;

    let DatabaseSync: any;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      report.skippedReason = "reading OpenCode data requires Node.js >= 22.5 (node:sqlite)";
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
      report.sessionsScanned = Number(db.prepare("SELECT count(*) AS c FROM session").get().c);
      const sessionRows = db
        .prepare(
          `SELECT id, parent_id, directory, version, cost,
                  time_created, time_updated,
                  summary_additions, summary_deletions, summary_files
           FROM session
           WHERE time_updated >= ?
           ORDER BY time_updated ASC`,
        )
        .all(ctx.since.getTime());
      const msgStmt = db.prepare("SELECT data FROM message WHERE session_id = ?");
      const partStmt = db.prepare(
        `SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'`,
      );

      for (const row of sessionRows) {
        ctx.verbose(`opencode: session ${String(row.id)}`);
        const s = newSessionRecord(hash16(String(row.id)), hash16(String(row.directory ?? "")));
        s.isSubagent = row.parent_id != null;
        s.startedAt = toIso(toMs(Number(row.time_created)));
        s.endedAt = toIso(toMs(Number(row.time_updated)));
        s.costUsd = Number(row.cost) || 0;
        if (row.version) report.latestVersion = String(row.version);
        s.outcome.additions = row.summary_additions == null ? null : Number(row.summary_additions);
        s.outcome.deletions = row.summary_deletions == null ? null : Number(row.summary_deletions);
        s.outcome.filesChanged = row.summary_files == null ? null : Number(row.summary_files);

        const agents = new Set<string>();
        for (const msgRow of msgStmt.all(String(row.id))) {
          let data: any;
          try {
            data = JSON.parse(String(msgRow.data));
          } catch {
            report.parseErrors++;
            continue;
          }
          if (data.role === "user") {
            s.counts.userPrompts++;
            s.agentic.turns++;
          } else if (data.role === "assistant") {
            s.counts.assistantMessages++;
            if (typeof data.agent === "string") agents.add(data.agent);
            const model = `${data.providerID ?? "unknown"}/${data.modelID ?? "unknown"}`;
            const tokens = data.tokens ?? {};
            const bucket = usageBucket(s.models, model);
            bucket.input += Number(tokens.input) || 0;
            bucket.output += Number(tokens.output) || 0;
            bucket.reasoning += Number(tokens.reasoning) || 0;
            bucket.cacheRead += Number(tokens.cache?.read) || 0;
            bucket.cacheWrite += Number(tokens.cache?.write) || 0;
          }
        }

        for (const partRow of partStmt.all(String(row.id))) {
          let data: any;
          try {
            data = JSON.parse(String(partRow.data));
          } catch {
            report.parseErrors++;
            continue;
          }
          const name = typeof data.tool === "string" ? data.tool : "unknown";
          s.counts.toolCalls++;
          s.tools[name] = (s.tools[name] ?? 0) + 1;
          if (data.state?.status === "error") s.counts.toolErrors++;
        }

        s.flags = { agents: [...agents].sort() };
        report.sessions.push(s);
        report.sessionsIncluded++;
      }
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
