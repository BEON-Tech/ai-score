import type { HarnessReport, Payload, Score, Standing, TokenUsage } from "./types.js";
import {
  bar,
  blockText,
  c,
  compact,
  cols,
  grouped,
  MARK,
  money,
  padEnd,
  padStart,
  type Paint,
  shortDate,
  tint,
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
 * are on screen while the slow part happens. The product mark and name lead;
 * the BEON.tech wordmark signs as the maker, as the site's footer does.
 */
export function renderHeader(info: HeaderInfo): string {
  const lines: string[] = [""];

  const beside = [
    `${c.bold(c.text("AI Workflow Score"))} ${c.faint(info.version)}`,
    c.muted("your score, from local agent logs"),
    "",
  ];
  // "by" sits on the wordmark's middle row; ".tech" on its baseline — the
  // mark is BEON.tech, not BEON.
  const by = ["   ", c.faint("by "), "   "];
  for (const [i, row] of MARK.entries()) {
    const wordmark = `${by[i]}${c.blue(WORDMARK[i] as string)}${i === 2 ? c.muted(".tech") : ""}`;
    lines.push(`${PAD}${row}   ${padEnd(beside[i] ?? "", 36)}${wordmark}`.trimEnd());
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

/** The report table and totals; the diagnostic notes only under --verbose. */
export function renderReport(payload: Payload, verbose = false): string {
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

  // Diagnostic footnotes (windowing, parse errors, evidence coverage) are for
  // whoever is debugging a surprising score, not the everyday run.
  const notes: string[] = [];
  if (verbose)
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
  if (verbose) notes.push(...evidenceNotes(payload));
  if (notes.length > 0) {
    out.push("");
    for (const note of notes) out.push(`${PAD}${c.faint("⌐")} ${c.muted(note)}`);
  }
  out.push("");
  return out.join("\n") + "\n";
}

/**
 * Why a dimension can read low through no fault of the engineer's. Carlos's
 * rule: nobody should have to download the source and analyze it to learn
 * that their harness never records a signal. Derived entirely locally from
 * the capability manifest and the collected sessions, so it prints on dry
 * runs too. Exported for the tests.
 */
export function evidenceNotes(payload: Payload): string[] {
  const notes: string[] = [];
  const active = payload.harnesses.filter((h) => h.sessionsIncluded > 0);
  if (active.length === 0) return notes;
  const names = (harnesses: HarnessReport[]) => harnesses.map((h) => h.harness).join(", ");
  // Tolerate reports from before the manifest existed rather than crash.
  const declared = active.filter((h) => h.capabilities !== undefined);

  const diffBlind = declared.filter((h) => h.capabilities.additions === "unobservable");
  if (diffBlind.length > 0) {
    notes.push(
      `output — ${names(diffBlind)} never records diff sizes; a blank there is a harness limit, not unshipped work`,
    );
  }
  const diffEstimated = declared.filter((h) => h.capabilities.additions === "estimated");
  if (diffEstimated.length > 0) {
    notes.push(`output — line counts for ${names(diffEstimated)} are estimated from edit calls`);
  }
  const verdictBlind = declared.filter((h) => h.capabilities.checkVerdicts === "unobservable");
  if (verdictBlind.length > 0) {
    notes.push(
      `verification — ${names(verdictBlind)} records no check output; its piped checks read as unknown, never as failed`,
    );
  }
  // A harness that can read verdicts but mostly didn't is worth attributing,
  // so a mixed-harness run shows which one drags coverage down.
  for (const h of declared) {
    if (h.capabilities.checkVerdicts === "unobservable") continue;
    const coding = h.sessions.filter((s) => s.workflow && s.workflow.codeChange !== "none");
    const readable = coding.filter(
      (s) => s.workflow.sequenceKnown && s.workflow.finalVerification !== "unknown",
    );
    if (coding.length >= 5 && readable.length / coding.length < 0.5) {
      notes.push(
        `${h.harness} — only ${readable.length} of ${coding.length} coding sessions carry readable verification evidence`,
      );
    }
  }

  let coding = 0;
  let unknownVerdicts = 0;
  let noChange = 0;
  let localDeliveries = 0;
  for (const h of active) {
    for (const s of h.sessions) {
      if (!s.workflow) continue;
      if (s.workflow.codeChange === "none") noChange++;
      else {
        coding++;
        if (s.workflow.finalVerification === "unknown") unknownVerdicts++;
      }
      if ((s.outcome?.localCommits ?? 0) > 0 && s.workflow.delivery !== "observed") {
        localDeliveries++;
      }
    }
  }
  if (unknownVerdicts > 0) {
    notes.push(
      `${grouped(unknownVerdicts)} of ${grouped(coding)} coding sessions verify as unknown — missing data, not failed checks`,
    );
  }
  if (noChange > 0) {
    notes.push(
      `${grouped(noChange)} sessions changed no code (research, docs, Q&A) — they are not verification candidates`,
    );
  }
  if (localDeliveries > 0) {
    notes.push(
      `${grouped(localDeliveries)} sessions have commits visible only in local git history — reported as localCommits`,
    );
  }
  return notes;
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
      `${PAD}${indent}   ${c.muted("Your name, score and city go on the public board; nothing else is published.")}`,
      `${PAD}${indent}   ${c.faint("--audit prints the exact payload before anything is sent.")}`,
      "",
    ].join("\n") + "\n"
  );
}

// ─── score ───────────────────────────────────────────────────────────────────

/**
 * What each dimension actually measures, in the engineer's terms. The six of
 * scoring v19; a dimension this copy has never heard of prints with no gloss
 * rather than a stale one.
 */
const DIMENSION_COPY: Record<string, string> = {
  leverage: "whole tasks delegated, long runs",
  craft: "clear prompts, failures fixed",
  verification: "checks after code changes",
  delivery: "commits and PRs, not just chat",
  consistency: "steady weekday use",
  customization: "MCP, skills, hooks, subagents",
};

/**
 * One hue per dimension, the same six the site's readout uses, so the
 * terminal and the page tell the same story in the same colours. Unknown
 * dimensions take the brand blue.
 */
const DIMENSION_TINT: Record<string, Paint> = {
  leverage: tint(58, 105, 255, 69, 94),
  craft: tint(116, 50, 255, 99, 95),
  verification: tint(254, 104, 227, 212, 95),
  delivery: tint(217, 47, 176, 163, 95),
  consistency: tint(91, 132, 255, 75, 94),
  customization: tint(157, 125, 255, 141, 95),
};

/** The board extras the server sends with a score; every field optional. */
export interface ScoreExtras {
  board: string | null;
  standing: Standing | null;
  challenge: string | null;
}

/** "AR" → "Argentina", or the code itself where ICU cannot say. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

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
  extras: ScoreExtras | null = null,
): string {
  const entries = Object.entries(score.dimensions);
  const outOf = entries.reduce((sum, [, d]) => sum + d.max, 0);
  const digits = blockText(formatScore(score.total));

  const out: string[] = [rule(), ""];

  // The figure and its scale sit side by side: one glance, not two. No band
  // label — the site prints none, and a word the page never shows would be
  // the CLI's own verdict rather than the score's.
  const beside = [
    c.faint(track(title)),
    `${c.bold(c.blue(formatScore(score.total)))} ${c.faint(`of ${outOf || 100}`)}`,
    score.version > 0 ? c.faint(`scoring v${score.version}`) : "",
  ];
  for (const [i, row] of digits.entries()) {
    out.push(`${PAD}${c.blue(row)}    ${beside[i] ?? ""}`.trimEnd());
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
      const hue = DIMENSION_TINT[name] ?? c.blue;
      const figure = c.text(formatScore(d.score)) + c.faint(`/${d.max}`);
      out.push(
        PAD +
          padEnd(c.text(name), nameWidth + 2) +
          padEnd(c.faint(copy[name] ?? ""), copyWidth + 3) +
          padStart(figure, figureWidth + 1) +
          "  " +
          hue(bar(d.score, d.max, meterWidth)),
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
    out.push(
      `${PAD}${c.faint("⌐")} ${c.muted(padEnd("full report", 12))} ${c.under(c.muted(url))}`,
    );
    // Where the run sits on the public board, and the link to send a friend.
    // Both only from a server that has a board; an older one sends neither.
    if (extras?.standing) {
      const s = extras.standing;
      const place = [`#${s.position} of ${s.of}`];
      if (s.country) {
        place.push(`#${s.country.position} of ${s.country.of} in ${countryName(s.country.code)}`);
      }
      const link = extras.board ? `  ${c.under(c.muted(extras.board))}` : "";
      out.push(
        `${PAD}${c.faint("⌐")} ${c.muted(padEnd("on the board", 12))} ${c.text(place.join(" · "))}${link}`,
      );
    } else if (extras?.board) {
      out.push(
        `${PAD}${c.faint("⌐")} ${c.muted(padEnd("on the board", 12))} ${c.faint("unranked until a scan with more usage")}  ${c.under(c.muted(extras.board))}`,
      );
    }
    if (extras?.challenge) {
      out.push(
        `${PAD}${c.faint("⌐")} ${c.muted(padEnd("challenge", 12))} ${c.under(c.muted(extras.challenge))}  ${c.faint("send it to a friend")}`,
      );
    }
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
  extras: ScoreExtras | null = null,
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
  return renderScoreCard(score, submissionId, "your score", DIMENSION_COPY, notes, url, extras);
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
