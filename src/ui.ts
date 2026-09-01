/**
 * Terminal presentation primitives. Zero dependencies on purpose: this package
 * promises that auditing it means reading `src/` and nothing else, and a
 * progress spinner is not worth giving that up.
 *
 * Everything here writes to stderr, or returns strings for the caller to write
 * there. stdout stays reserved for `--audit` JSON so the output remains
 * pipeable into `jq`.
 */

// ─── colour support ──────────────────────────────────────────────────────────

/**
 * Truecolor → 256 → basic → none. A CLI gets piped, teed and CI-logged at least
 * as often as it gets watched, so "none" has to be a first-class outcome rather
 * than an afterthought.
 */
export function colorLevel(stream: { isTTY?: boolean } = process.stderr): 0 | 1 | 2 | 3 {
  // https://no-color.org — any non-empty value disables colour.
  if (process.env["NO_COLOR"]) return 0;
  if (process.env["FORCE_COLOR"]) {
    const n = Number(process.env["FORCE_COLOR"]);
    return (Number.isFinite(n) ? Math.min(Math.max(n, 0), 3) : 3) as 0 | 1 | 2 | 3;
  }
  if (!stream.isTTY) return 0;
  const term = process.env["TERM"] ?? "";
  if (term === "dumb") return 0;
  const colorterm = process.env["COLORTERM"] ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return 3;
  if (/-256(color)?$/i.test(term)) return 2;
  return 1;
}

const LEVEL = colorLevel();

/** Picks the richest escape this terminal can actually render. */
function fg(r: number, g: number, b: number, ansi256: number, basic: number): string {
  if (LEVEL >= 3) return `\x1b[38;2;${r};${g};${b}m`;
  if (LEVEL === 2) return `\x1b[38;5;${ansi256}m`;
  if (LEVEL === 1) return `\x1b[${basic}m`;
  return "";
}

const RESET = LEVEL ? "\x1b[0m" : "";
const paint =
  (open: string) =>
  (s: string | number): string =>
    LEVEL && open ? `${open}${String(s)}${RESET}` : String(s);

/**
 * Brand palette from platform/login-page/tailwind.config.js — #3a69ff primary,
 * #7432ff accent. Semantic colours are kept distinct from the brand blue so a
 * "good" score never reads as merely "branded".
 */
export const c = {
  blue: paint(fg(58, 105, 255, 69, 94)),
  violet: paint(fg(116, 50, 255, 99, 95)),
  ok: paint(fg(74, 222, 128, 114, 92)),
  warn: paint(fg(251, 191, 36, 221, 93)),
  bad: paint(fg(255, 58, 58, 203, 91)),
  /** Three neutral tiers carry most of the hierarchy; colour is the accent. */
  text: paint(fg(229, 231, 235, 252, 97)),
  muted: paint(fg(148, 152, 165, 245, 37)),
  faint: paint(fg(92, 96, 110, 240, 90)),
  bold: paint(LEVEL ? "\x1b[1m" : ""),
  under: paint(LEVEL ? "\x1b[4m" : ""),
};

export type Paint = (s: string | number) => string;

// ─── width maths ─────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Visible width, ignoring escape sequences. Every alignment bug in a coloured
 * terminal table comes from padding a string that secretly contains escapes.
 */
export function vlen(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

export function padEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - vlen(s)));
}

export function padStart(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - vlen(s))) + s;
}

/** Terminal width, clamped so the layout never stretches across a huge window. */
export function cols(max = 84): number {
  return Math.max(48, Math.min(process.stderr.columns || 80, max));
}

/** Letterspaced uppercase — the small-caps voice used for every field label. */
export function track(s: string): string {
  return [...s.toUpperCase()].join(" ");
}

// ─── half-block pixel font ───────────────────────────────────────────────────

/**
 * Each glyph is a 4×6 pixel grid rendered into 3 text rows by packing row pairs
 * into ▀ ▄ █ — double the vertical resolution per terminal line. Used for both
 * the wordmark and the score, so brand and data speak in one voice.
 */
const GLYPHS: Record<string, string[]> = {
  B: ["111.", "1..1", "111.", "1..1", "111.", "...."],
  E: ["1111", "1...", "111.", "1...", "1111", "...."],
  O: ["1111", "1..1", "1..1", "1..1", "1111", "...."],
  N: ["1..1", "11.1", "1.11", "1..1", "1..1", "...."],
  "0": ["1111", "1..1", "1..1", "1..1", "1111", "...."],
  "1": [".11.", "..1.", "..1.", "..1.", ".111", "...."],
  "2": ["1111", "...1", "1111", "1...", "1111", "...."],
  "3": ["1111", "...1", "1111", "...1", "1111", "...."],
  "4": ["1..1", "1..1", "1111", "...1", "...1", "...."],
  "5": ["1111", "1...", "1111", "...1", "1111", "...."],
  "6": ["1111", "1...", "1111", "1..1", "1111", "...."],
  "7": ["1111", "...1", "...1", "...1", "...1", "...."],
  "8": ["1111", "1..1", "1111", "1..1", "1111", "...."],
  "9": ["1111", "1..1", "1111", "...1", "1111", "...."],
  ".": ["....", "....", "....", "....", ".11.", "...."],
  " ": ["....", "....", "....", "....", "....", "...."],
};

const BLANK = GLYPHS[" "] as string[];

/** Renders text as exactly 3 rows of half-block art. */
export function blockText(text: string, gap = 1): [string, string, string] {
  const glyphs = [...text.toUpperCase()].map((ch) => GLYPHS[ch] ?? BLANK);
  const rows: [string, string, string] = ["", "", ""];
  for (const [i, glyph] of glyphs.entries()) {
    const spacer = i < glyphs.length - 1 ? " ".repeat(gap) : "";
    for (let r = 0; r < 3; r++) {
      const top = glyph[r * 2] as string;
      const bottom = glyph[r * 2 + 1] as string;
      let line = "";
      for (let x = 0; x < top.length; x++) {
        const t = top[x] === "1";
        const b = bottom[x] === "1";
        line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
      }
      rows[r] += line + spacer;
    }
  }
  return rows;
}

/** The BEON wordmark, 3 rows tall. */
export const WORDMARK = blockText("BEON");

// ─── meters ──────────────────────────────────────────────────────────────────

/**
 * Eighth-block bar, giving a 20-cell meter 160 steps of resolution. Filled and
 * empty cells differ by glyph, not only colour, so the bar still carries its
 * value under NO_COLOR and for colour-blind readers.
 */
export function bar(value: number, max: number, width: number): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const exact = ratio * width;
  const full = Math.floor(exact);
  const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const partial = PARTIALS[Math.floor((exact - full) * 8)] ?? "";
  const filled = "█".repeat(full) + partial;
  return filled + "·".repeat(Math.max(0, width - vlen(filled)));
}

// ─── numbers ─────────────────────────────────────────────────────────────────

/** Compact form for dense cells: 1.0B, 4.2M, 4.1k. */
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Grouped form for figures worth comparing precisely: 16,051. */
export function grouped(n: number): string {
  return n.toLocaleString("en-US");
}

export function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "28 Jun" / "28 Jul 2026" — the year is dropped when a range repeats it. */
export function shortDate(iso: string, sameYearAs?: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-") as [string, string, string];
  const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const year = sameYearAs?.startsWith(y) ? "" : ` ${y}`;
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${year}`;
}

// ─── transient progress ──────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

type RowState = "pending" | "running" | "done";

interface Row {
  name: string;
  state: RowState;
  detail: string;
  startedAt: number;
  elapsedMs: number;
  /** Sessions parsed so far — proof of life on a scan with thousands of files. */
  count: number;
}

/**
 * A block of lines repainted in place while the scan runs, then erased — the
 * ledger below is the permanent record, so leaving the progress rows on screen
 * would just say everything twice.
 *
 * Silent unless stderr is a TTY. `--verbose` also disables it, since arbitrary
 * log lines and a fixed-height repaint region cannot share a cursor.
 */
export class ScanProgress {
  readonly #rows: Row[];
  readonly #live: boolean;
  #timer: NodeJS.Timeout | null = null;
  #frame = 0;
  #painted = 0;
  #cleanup: (() => void) | null = null;

  constructor(names: string[], live: boolean) {
    this.#rows = names.map((name) => ({
      name,
      state: "pending",
      detail: "",
      startedAt: 0,
      elapsedMs: 0,
      count: 0,
    }));
    this.#live = live && Boolean(process.stderr.isTTY);
  }

  /** Marks a harness as in progress and starts animating. */
  begin(name: string): void {
    const row = this.#rows.find((r) => r.name === name);
    if (row) {
      row.state = "running";
      row.startedAt = Date.now();
    }
    if (!this.#live) return;
    if (!this.#timer) {
      process.stderr.write(HIDE_CURSOR);
      // A hidden cursor must be restored even if we die mid-scan, or the user's
      // shell is left without one.
      this.#cleanup = () => process.stderr.write(SHOW_CURSOR);
      process.once("exit", this.#cleanup);
      this.#timer = setInterval(() => {
        this.#frame++;
        this.#paint();
      }, 80);
      // Never let the spinner alone keep the process alive.
      this.#timer.unref();
    }
    this.#paint();
  }

  /**
   * Counts one parsed session. No repaint here — a 10k-session scan would
   * spend more time painting than parsing; the 80ms timer picks it up.
   */
  tick(name: string): void {
    const row = this.#rows.find((r) => r.name === name);
    if (row) row.count++;
  }

  /** Marks a harness finished, with a one-line summary of what was found. */
  end(name: string, detail: string): void {
    const row = this.#rows.find((r) => r.name === name);
    if (row) {
      row.state = "done";
      row.detail = detail;
      row.elapsedMs = row.startedAt ? Date.now() - row.startedAt : 0;
    }
    this.#paint();
  }

  /** Stops animating and erases the block. */
  finish(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#live && this.#painted > 0) {
      // Rewind over the block and clear it; the ledger prints in its place.
      process.stderr.write(`\x1b[${this.#painted}A\x1b[0J`);
      this.#painted = 0;
    }
    if (this.#cleanup) {
      process.stderr.write(SHOW_CURSOR);
      process.removeListener("exit", this.#cleanup);
      this.#cleanup = null;
    }
  }

  #paint(): void {
    if (!this.#live) return;
    const nameWidth = Math.max(...this.#rows.map((r) => r.name.length));
    const lines = this.#rows.map((row) => {
      const mark =
        row.state === "done"
          ? c.ok("✓")
          : row.state === "running"
            ? c.blue(SPINNER[this.#frame % SPINNER.length] as string)
            : c.faint("·");
      const name =
        row.state === "pending"
          ? c.faint(padEnd(row.name, nameWidth))
          : c.text(padEnd(row.name, nameWidth));
      const detail =
        row.state === "done"
          ? `${c.muted(row.detail)} ${c.faint(`${(row.elapsedMs / 1000).toFixed(2)}s`)}`
          : row.state === "running"
            ? c.faint(
                row.count > 0 ? `reading sessions… ${grouped(row.count)}` : "reading sessions…",
              )
            : c.faint("queued");
      return `  ${mark} ${name}   ${detail}`;
    });

    let buffer = this.#painted ? `\x1b[${this.#painted}A` : "";
    // \x1b[2K clears the whole line, so shrinking content cannot leave residue.
    for (const line of lines) buffer += `\x1b[2K${line}\n`;
    process.stderr.write(buffer);
    this.#painted = lines.length;
  }
}
