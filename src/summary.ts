import type { HarnessReport, Payload, TokenUsage } from "./types.js";

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

interface Row {
  harness: string;
  status: string;
  sessions: string;
  prompts: string;
  toolCalls: string;
  tokensIn: string;
  tokensOut: string;
  cost: string;
}

function aggregate(report: HarnessReport) {
  const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let prompts = 0;
  let toolCalls = 0;
  let cost = 0;
  let hasCost = false;
  for (const s of report.sessions) {
    prompts += s.counts.userPrompts;
    toolCalls += s.counts.toolCalls;
    if (s.costUsd !== null) {
      cost += s.costUsd;
      hasCost = true;
    }
    for (const usage of Object.values(s.models)) {
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.reasoning += usage.reasoning;
    }
  }
  return { totals, prompts, toolCalls, cost: hasCost ? cost : null };
}

export function renderSummary(payload: Payload): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`ai-score v${payload.client.version} — extraction summary`);
  lines.push(
    `window: last ${payload.window.days} days (${payload.window.start.slice(0, 10)} → ${payload.window.end.slice(0, 10)})`,
  );
  lines.push(
    `engineer: ${payload.engineer.email ?? "(no email — pass --email)"} · machine ${payload.engineer.machineId}`,
  );
  lines.push("");

  const rows: Row[] = [];
  for (const report of payload.harnesses) {
    if (!report.detected) {
      rows.push({
        harness: report.harness,
        status: "not found",
        sessions: "—",
        prompts: "—",
        toolCalls: "—",
        tokensIn: "—",
        tokensOut: "—",
        cost: "—",
      });
      continue;
    }
    if (report.skippedReason) {
      rows.push({
        harness: report.harness,
        status: "skipped",
        sessions: "—",
        prompts: "—",
        toolCalls: "—",
        tokensIn: "—",
        tokensOut: "—",
        cost: "—",
      });
      continue;
    }
    const agg = aggregate(report);
    rows.push({
      harness: report.harness,
      status: "ok",
      sessions: String(report.sessionsIncluded),
      prompts: fmt(agg.prompts),
      toolCalls: fmt(agg.toolCalls),
      tokensIn: fmt(agg.totals.input + agg.totals.cacheRead),
      tokensOut: fmt(agg.totals.output),
      cost: agg.cost === null ? "—" : `$${agg.cost.toFixed(2)}`,
    });
  }

  const header: Row = {
    harness: "harness",
    status: "status",
    sessions: "sessions",
    prompts: "prompts",
    toolCalls: "tool calls",
    tokensIn: "tokens in",
    tokensOut: "tokens out",
    cost: "cost",
  };
  const columns = Object.keys(header) as (keyof Row)[];
  const widths = Object.fromEntries(
    columns.map((c) => [c, Math.max(header[c].length, ...rows.map((r) => r[c].length))]),
  ) as Record<keyof Row, number>;
  const renderRow = (r: Row) =>
    "  " +
    columns
      .map((c) => (c === "harness" ? r[c].padEnd(widths[c]) : r[c].padStart(widths[c])))
      .join("  ");
  lines.push(renderRow(header));
  lines.push("  " + columns.map((c) => "-".repeat(widths[c])).join("  "));
  for (const row of rows) lines.push(renderRow(row));

  for (const report of payload.harnesses) {
    if (report.skippedReason)
      lines.push(`  note: ${report.harness} skipped — ${report.skippedReason}`);
    if (report.parseErrors > 0)
      lines.push(
        `  note: ${report.harness} had ${report.parseErrors} unparseable records (skipped, counted)`,
      );
  }

  lines.push("");
  lines.push("privacy: only structural metadata is collected — tool names, model ids, counts,");
  lines.push("timestamps and one-way hashes. No code, prompts, file paths or message text.");
  lines.push("run with --audit to print the exact payload before anything is sent.");
  lines.push("");
  return lines.join("\n");
}
