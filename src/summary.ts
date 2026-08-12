import type { HarnessReport, Payload, Score, TokenUsage } from "./types.js";
import {
  bar,
  blockText,
  c,
  compact,
  cols,
  grouped,
  money,
  padEnd,
  padStart,
  type Paint,
  shortDate,
  track,
  WORDMARK,
} from "./ui.js";

/**
 * The report is set like a statement of account: hairline rules and negative
 * space instead of boxes, letterspaced labels, figures right-aligned in tabular
 * columns, and exactly one accent colour. It prints once, top to bottom, so it
 * survives pipes, `tee`, CI logs and scrollback unchanged.
 */

const PAD = "  ";

function width(): number {
  return cols(84);
}

function rule(): string {
  return PAD + c.faint("─".repeat(width() - 4));
}

// ─── aggregation ─────────────────────────────────────────────────────────────

interface Totals {
  sessions: number;
  prompts: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
}

function aggregate(report: HarnessReport): Omit<Totals, "sessions"> & { totals: TokenUsage } {
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
  return {
    prompts,
    toolCalls,
    tokensIn: totals.input + totals.cacheRead,
    tokensOut: totals.output,
    cost: hasCost ? cost : null,
    totals,
  };
}

/**
 * One-line summary of a finished harness, shown transiently by the scan
 * spinner. Deliberately not the same shape as the table row: this is a progress
 * note, not a record.
 */
export function scanDetail(report: HarnessReport): string {
  if (!report.detected) return "not installed";
  if (report.skippedReason) return `skipped — ${report.skippedReason}`;
  const agg = aggregate(report);
  const parts = [
    `${grouped(report.sessionsIncluded)} sessions`,
    `${compact(agg.prompts)} prompts`,
    `${compact(agg.toolCalls)} tools`,
  ];
  return parts.join(" · ");
}

// ─── header ──────────────────────────────────────────────────────────────────

export interface HeaderInfo {
  version: string;
  days: number;
  start: string;
  end: string;
  /** Resolved offline; null when this machine is not signed in. */
  account: string | null;
  machineId: string;
}

/**
 * Printed before the scan starts, so the brand and the parameters of the run
 * are on screen while the slow part happens.
 */
export function renderHeader(info: HeaderInfo): string {
  const lines: string[] = [""];

  const beside = [
    `${c.text("ai-score")} ${c.faint(info.version)}`,
    c.muted("overall score report"),
    "",
  ];
  for (const [i, row] of WORDMARK.entries()) {
    // ".tech" sits on the wordmark's baseline — the mark is BEON.tech, not BEON.
    const suffix = i === 2 ? c.muted(".tech") : "     ";
    lines.push(`${PAD}${c.blue(row)}${suffix}   ${beside[i] ?? ""}`.trimEnd());
  }
  lines.push("");

  const facts: [string, string][] = [
    [
      "window",
      `${info.days} ${info.days === 1 ? "day" : "days"} ${c.faint("·")} ${shortDate(info.start, info.end)} → ${shortDate(info.end)}`,
    ],
    [
      "account",
      info.account
        ? c.text(info.account)
        : c.warn("not signed in") + c.faint(" — run 'ai-score login'"),
    ],
    ["machine", c.muted(info.machineId)],
  ];
  const labelWidth = Math.max(...facts.map(([label]) => track(label).length));
  for (const [label, value] of facts) {
    lines.push(`${PAD}${c.faint(padEnd(track(label), labelWidth))}   ${value}`);
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

// ─── the ledger ──────────────────────────────────────────────────────────────

interface Column {
  head: string;
  align: "left" | "right";
}

const COLUMNS: Column[] = [
  { head: "", align: "left" },
  { head: "sessions", align: "right" },
  { head: "prompts", align: "right" },
  { head: "tool calls", align: "right" },
  { head: "tokens in", align: "right" },
  { head: "tokens out", align: "right" },
  { head: "cost", align: "right" },
];

interface Cell {
  text: string;
  paint: Paint;
}

const cell = (text: string, paint: Paint): Cell => ({ text, paint });

/** The report table, notes, and totals. */
export function renderReport(payload: Payload): string {
  const rows: { cells: Cell[]; suffix: string }[] = [];
  const totals: Totals = {
    sessions: 0,
    prompts: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: null,
  };

  for (const report of payload.harnesses) {
    // An absent harness stays in the ledger — a missing row is information —
    // but recedes to the faintest tier so the eye skips it.
    if (!report.detected || report.skippedReason) {
      rows.push({
        cells: [
          cell(report.harness, c.faint),
          ...Array.from({ length: 6 }, () => cell("—", c.faint)),
        ],
        suffix: c.faint(`   ${report.detected ? "skipped" : "not found"}`),
      });
      continue;
    }

    const agg = aggregate(report);
    totals.sessions += report.sessionsIncluded;
    totals.prompts += agg.prompts;
    totals.toolCalls += agg.toolCalls;
    totals.tokensIn += agg.tokensIn;
    totals.tokensOut += agg.tokensOut;
    if (agg.cost !== null) totals.cost = (totals.cost ?? 0) + agg.cost;

    rows.push({
      cells: [
        cell(report.harness, c.text),
        cell(grouped(report.sessionsIncluded), c.text),
        cell(grouped(agg.prompts), c.text),
        cell(grouped(agg.toolCalls), c.text),
        cell(compact(agg.tokensIn), c.muted),
        cell(compact(agg.tokensOut), c.muted),
        agg.cost === null ? cell("—", c.faint) : cell(money(agg.cost), c.text),
      ],
      suffix: "",
    });
  }

  const totalRow: Cell[] = [
    cell(track("total"), c.faint),
    cell(grouped(totals.sessions), (s) => c.bold(c.text(s))),
    cell(grouped(totals.prompts), (s) => c.bold(c.text(s))),
    cell(grouped(totals.toolCalls), (s) => c.bold(c.text(s))),
    cell(compact(totals.tokensIn), (s) => c.bold(c.text(s))),
    cell(compact(totals.tokensOut), (s) => c.bold(c.text(s))),
    totals.cost === null ? cell("—", c.faint) : cell(money(totals.cost), (s) => c.bold(c.text(s))),
  ];

  // Width from the unpainted text, so escape codes can never skew a column.
  const widths = COLUMNS.map((col, i) =>
    Math.max(
      col.head.length,
      ...rows.map((r) => (r.cells[i] as Cell).text.length),
      (totalRow[i] as Cell).text.length,
    ),
  );

  const line = (cells: Cell[]): string =>
    PAD +
    cells
      .map((cl, i) => {
        const painted = cl.paint(cl.text);
        const w = (widths[i] as number) + (i === 0 ? 2 : 3);
        return COLUMNS[i]?.align === "left" ? padEnd(painted, w) : padStart(painted, w);
      })
      .join("")
      .trimEnd();

  const out: string[] = [];
  out.push(line(COLUMNS.map((col) => cell(col.head, c.faint))));
  for (const row of rows) out.push(line(row.cells) + row.suffix);
  out.push(rule());
  out.push(line(totalRow));

  const notes: string[] = [];
  for (const report of payload.harnesses) {
    if (report.skippedReason) notes.push(`${report.harness} skipped — ${report.skippedReason}`);
    if (report.parseErrors > 0) {
      notes.push(
        `${report.harness} — ${grouped(report.parseErrors)} unreadable records, skipped and counted`,
      );
    }
    // A detected harness whose sessions all fell outside the window used to
    // show a bare zero and read as a parser bug — this is the note that would
    // have answered that support thread before it started.
    const outside = report.sessionsScanned - report.sessionsIncluded - report.parseErrors;
    if (report.detected && !report.skippedReason && outside > 0) {
      notes.push(
        `${report.harness} — ${grouped(outside)} sessions not counted: older than the ${payload.window.days}-day window, or empty`,
      );
    }
  }
  if (notes.length > 0) {
    out.push("");
    for (const note of notes) out.push(`${PAD}${c.faint("⌐")} ${c.muted(note)}`);
  }
  out.push("");
  return out.join("\n") + "\n";
}

/**
 * The privacy promise, compressed to the ledger's voice. The full contract lives
 * in WIRE_FORMAT.md; this is the reminder, not the document.
 */
export function renderPrivacy(): string {
  const label = track("privacy");
  const indent = " ".repeat(label.length);
  return (
    [
      rule(),
      "",
      `${PAD}${c.faint(label)}   ${c.muted("counts, workflow states, timestamps and one-way hashes only.")}`,
      `${PAD}${indent}   ${c.muted("No raw commands, outputs, code, prompts, paths or message text.")}`,
      `${PAD}${indent}   ${c.faint("--audit prints the exact payload before anything is sent.")}`,
      "",
    ].join("\n") + "\n"
  );
}

// ─── score ───────────────────────────────────────────────────────────────────

/** Shared vocabulary so a given total always reads the same way. */
function band(total: number, max: number): { label: string; tone: Paint } {
  const pct = max > 0 ? total / max : 0;
  if (pct >= 0.85) return { label: "exceptional", tone: c.ok };
  if (pct >= 0.7) return { label: "strong", tone: c.blue };
  if (pct >= 0.5) return { label: "developing", tone: c.warn };
  return { label: "early", tone: c.faint };
}

/** What each dimension actually measures, in the engineer's terms. */
const DIMENSION_COPY: Record<string, string> = {
  leverage: "how much work per prompt",
  completion: "final check passed",
  craft: "clean runs, few retries",
  output: "shipped, not just chatted",
  verification: "checks after code changes",
  customization: "MCP, hooks, subagents",
  efficiency: "cache reuse, multi-harness",
  autonomy: "changed and checked in one turn",
};

/**
 * Replaces what used to be `body.slice(0, 200)` of the raw JSON response — the
 * server already returns a per-dimension breakdown, so there is no reason to
 * show it as a truncated object.
 */
function renderScoreCard(
  score: Score,
  submissionId: string | null,
  title: string,
  copy: Record<string, string>,
  notes: string[] = [],
  url: string | null = null,
): string {
  const entries = Object.entries(score.dimensions);
  const outOf = entries.reduce((sum, [, d]) => sum + d.max, 0);
  const { label, tone } = band(score.total, outOf);
  const digits = blockText(formatScore(score.total));

  const out: string[] = [rule(), ""];

  // The figure and its meaning sit side by side: one glance, not two.
  const beside = [
    c.faint(track(title)),
    `${c.bold(tone(formatScore(score.total)))} ${c.faint(`of ${outOf || 100}`)}   ${tone(label)}`,
    score.version > 0 ? c.faint(`scoring v${score.version}`) : "",
  ];
  for (const [i, row] of digits.entries()) {
    out.push(`${PAD}${tone(row)}    ${beside[i] ?? ""}`.trimEnd());
  }

  if (entries.length > 0) {
    out.push("");
    const nameWidth = Math.max(...entries.map(([name]) => name.length));
    const copyWidth = Math.max(...entries.map(([name]) => (copy[name] ?? "").length));
    const figureWidth = Math.max(
      ...entries.map(([, d]) => `${formatScore(d.score)}/${d.max}`.length),
    );
    // Keep the meter inside the terminal even on a narrow window.
    const meterWidth = Math.max(
      8,
      Math.min(18, width() - 4 - nameWidth - copyWidth - figureWidth - 8),
    );

    for (const [name, d] of entries) {
      const ratio = d.max > 0 ? d.score / d.max : 0;
      const tint = ratio >= 0.9 ? c.ok : ratio >= 0.6 ? c.blue : c.warn;
      const figure = c.text(formatScore(d.score)) + c.faint(`/${d.max}`);
      out.push(
        PAD +
          padEnd(c.text(name), nameWidth + 2) +
          padEnd(c.faint(copy[name] ?? ""), copyWidth + 3) +
          padStart(figure, figureWidth + 1) +
          "  " +
          tint(bar(d.score, d.max, meterWidth)),
      );
    }
  }

  if (notes.length > 0) {
    out.push("");
    for (const note of notes) out.push(`${PAD}${c.faint("⌐")} ${c.muted(note)}`);
  }

  if (url) {
    out.push("");
    // The server said where this submission can be viewed, and the id is part
    // of that URL — one line serves as both the link and the support reference.
    out.push(`${PAD}${c.faint("⌐")} ${c.muted("full report")}  ${c.under(c.muted(url))}`);
  } else if (submissionId) {
    out.push("");
    // Set as a note rather than a labelled field: it is a support reference,
    // not a headline. An older server sends no view URL, and printing a URL
    // that 404s is worse than printing none — so the bare id it is.
    out.push(`${PAD}${c.faint("⌐")} ${c.muted(`submission ${submissionId}`)}`);
  }
  out.push("");
  return out.join("\n") + "\n";
}

const WORKFLOW_REASON_COPY: Record<string, string> = {
  NO_CODING_SESSIONS: "no observable coding sessions in this run",
  MISSING_WORKFLOW_EVIDENCE: "some sessions need the latest supported classifier",
  MIN_OBSERVABLE_SESSIONS: "at least 5 observable coding sessions are required",
  LOW_OBSERVABILITY: "at least 30% of coding sessions must carry reliable evidence",
};

export function renderScore(
  score: Score,
  submissionId: string | null,
  url: string | null = null,
): string {
  // The evidence behind the workflow dimensions, set as the card's notes. An
  // insufficient result explains the confidence discount — thin evidence
  // earns proportionally fewer workflow points until a scan carries more.
  const notes: string[] = [];
  if (score.workflow) {
    const evidence = score.workflow.evidence;
    const evidenceSessions = evidence.codingSessions + evidence.unclassifiedSessions;
    const coverage = `${(evidence.coverage * 100).toFixed(1)}% coverage`;
    notes.push(
      `${evidence.observableSessions} observable / ${evidenceSessions} evidence candidates · ${coverage}`,
    );
    if (score.workflow.status === "scored") {
      notes.push(
        `${evidence.recoveredFailures} failures recovered · ${evidence.deliveriesObserved} deliveries observed`,
      );
    } else {
      const confidence = score.workflow.confidence;
      notes.push(
        confidence === null
          ? "workflow evidence too thin — workflow points discounted"
          : `workflow evidence too thin — workflow points scored at ${Math.round(confidence * 100)}% confidence`,
      );
      for (const reason of score.workflow.reasonCodes) {
        notes.push(WORKFLOW_REASON_COPY[reason] ?? reason);
      }
    }
  }
  return renderScoreCard(score, submissionId, "overall score", DIMENSION_COPY, notes, url);
}

/** Trims a trailing ".0" so whole scores read as "92", not "92.0". */
function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Shown when the upload succeeded but the response was not a score we
 * recognise — the submission still landed, and saying so beats printing JSON.
 */
export function renderUploaded(
  status: number,
  id: string | null,
  url: string | null = null,
): string {
  // The URL embeds the id, so show whichever is the most useful single detail.
  const detail = url ? ` ${c.under(c.muted(url))}` : id ? c.faint(` · ${id}`) : "";
  return `${PAD}${c.ok("✓")} ${c.text("report uploaded")} ${c.faint(`(HTTP ${status})`)}${detail}\n`;
}
