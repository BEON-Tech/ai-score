import { homedir, tmpdir } from "node:os";
import type {
  VerificationKind,
  WorkflowCodeChange,
  WorkflowDelivery,
  WorkflowEvidence,
  WorkflowVerification,
} from "./types.js";

export type ToolOutcome = "success" | "failure" | "not-run" | "unknown";

type EventKind =
  | "mutation"
  | "verification"
  | "delivery"
  | "observation"
  | "unknown-shell"
  | "unknown-tool";

interface WorkflowEvent {
  kind: EventKind;
  outcome: ToolOutcome;
  turn: number | null;
  verificationKind?: VerificationKind;
  name: string;
  /** See {@link Classified.failureMarked}. */
  failureMarked?: boolean;
  /**
   * `pnpm test 2>&1 | tail -8` exits with tail's status, not the test's, so
   * the harness outcome proves nothing. Marked events take their outcome from
   * the runner's own summary line instead of the exit code.
   */
  exitUnreliable?: boolean;
  /**
   * A result arrived, so the completion point is known even when the verdict
   * is not. Unsettled events have no known completion point and are treated
   * as if they may have finished after everything else.
   */
  settled?: boolean;
  /** Verification evidence carried inside a delivery chain; settles with it. */
  companion?: WorkflowEvent;
  /** Excluded from name-based result matching — its carrier settles it. */
  isCompanion?: boolean;
  /** Lines implied by a mutation's arguments, banked when its result succeeds. */
  pendingDiff?: { adds: number; dels: number };
  /** A mutation's target paths, for the distinct-files estimate. Transient. */
  targets?: string[];
}

interface Classified {
  kind: EventKind;
  verificationKind?: VerificationKind;
  exitUnreliable?: boolean;
  /**
   * The command is wrapped by a runner that always prints a recognisable
   * marker when it fails (pnpm/npm's ELIFECYCLE/ERR!, tsc's `error TS`), so
   * non-empty output without any failure marker is itself a pass verdict —
   * provided nothing after it in the pipe truncated the end of the stream.
   */
  failureMarked?: boolean;
  /**
   * A `checks && git commit && git push` chain classifies as delivery, but
   * the checks inside it are the session's verification evidence. This
   * carries them as a second event instead of discarding them.
   */
  chainedVerification?: Classified;
}

interface TrackerOptions {
  sequenceKnown: boolean;
  commandObservation?: boolean;
  deliveryObservation?: boolean;
}

const MUTATION_TOOLS = new Set([
  "apply_patch",
  "applypatch",
  "create_file",
  "edit",
  "edit_file",
  // VS Code Copilot's editing tools, as normalized by the copilot-ide adapter.
  "insert_edit",
  "insert_edit_into_file",
  "multiedit",
  "replace_string",
  "replace_string_in_file",
  "search_replace",
  "str_replace",
  "str_replace_editor",
  "write",
  "write_file",
]);

const SHELL_TOOLS = new Set([
  "bash",
  "exec",
  "exec_command",
  "local_shell",
  "run_command",
  "run_in_terminal",
  "run_terminal_command",
  "run_terminal_cmd",
  "shell",
  "terminal",
]);

const OBSERVATION_TOOLS = new Set([
  // Subagent spawns (Claude Code's Agent, formerly Task; Copilot CLI's task).
  // The subagent's own transcript carries its edits and checks — the adapters
  // merge it into the session — so the spawn itself changes nothing; reading
  // it as an opaque tool made every delegated check end in "unknown".
  "agent",
  "askuserquestion",
  "enterplanmode",
  "enterworktree",
  "exitplanmode",
  // `fetch` and `view` are Copilot CLI's web fetch and file reader; the rest
  // of the copilot names are VS Code's search/read/diagnostics tools.
  "fetch",
  "fetch_webpage",
  "file_search",
  "get_errors",
  "glob",
  "grep",
  "grep_search",
  "list",
  "list_dir",
  "ls",
  "question",
  "read",
  "read_file",
  "search",
  "semantic_search",
  "sendmessage",
  "skill",
  "task",
  "taskcreate",
  "tasklist",
  "taskoutput",
  "taskstop",
  "taskupdate",
  "todos",
  "todowrite",
  "toolsearch",
  "update_plan",
  "view",
  // codex's wait resolves a detached script; the script's own exec event is
  // what carries the uncertainty, so waiting on it observes, not changes.
  "wait",
  "web_search",
  "websearch",
  "webfetch",
  "write_stdin",
]);

const normalizeTool = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_v\d+$/, "");

const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

const MUTATION_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_file",
  "targetFile",
];

/** Target paths of a mutation tool call, or [] when the input names none. */
function mutationTargets(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const targets: string[] = [];
  for (const key of MUTATION_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) targets.push(value.trim());
  }
  if (targets.length === 0) {
    // codex's apply_patch carries its paths inside the patch text.
    const patch = [record["input"], record["patch"], record["content"]].find(
      (value) => typeof value === "string",
    ) as string | undefined;
    for (const match of patch?.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm) ?? []) {
      targets.push(match[1].trim());
    }
  }
  return targets;
}

const lineCount = (value: unknown): number =>
  typeof value === "string" && value.length > 0 ? value.split("\n").length : 0;

const oldString = (record: Record<string, unknown>): unknown =>
  record["old_string"] ?? record["oldString"] ?? record["old_str"];

const newString = (record: Record<string, unknown>): unknown =>
  record["new_string"] ?? record["newString"] ?? record["new_str"];

/**
 * Lines in/out implied by an editing tool's arguments, or null when the call
 * carries nothing to measure. Shape-based rather than name-based so every
 * harness's editing tools qualify: old/new replacement pairs, a `MultiEdit`
 * style `edits` array, whole-file content, or an `apply_patch` body. An
 * estimate (a `replace_all` counts once; a whole-file write can't see what it
 * overwrote), but it turns "how much shipped" from structurally blank into
 * real for harnesses without native diff summaries. Only ever consulted for
 * calls already classified as mutations.
 */
export function editDiff(name: string, input: unknown): { adds: number; dels: number } | null {
  void name;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Array.isArray(record["edits"])) {
    let adds = 0;
    let dels = 0;
    for (const edit of record["edits"]) {
      if (!edit || typeof edit !== "object") continue;
      adds += lineCount(newString(edit as Record<string, unknown>));
      dels += lineCount(oldString(edit as Record<string, unknown>));
    }
    return adds > 0 || dels > 0 ? { adds, dels } : null;
  }
  if (oldString(record) !== undefined || newString(record) !== undefined) {
    const adds = lineCount(newString(record));
    const dels = lineCount(oldString(record));
    return adds > 0 || dels > 0 ? { adds, dels } : null;
  }
  // codex's apply_patch: the diff body itself, so count its +/- lines.
  const patch = [record["input"], record["patch"]].find((value) => typeof value === "string") as
    | string
    | undefined;
  if (patch && /^\*\*\* (?:Add|Update|Delete) File: /m.test(patch)) {
    let adds = 0;
    let dels = 0;
    for (const line of patch.split("\n")) {
      if (/^\+(?!\+\+)/.test(line)) adds++;
      else if (/^-(?!--)/.test(line)) dels++;
    }
    return adds > 0 || dels > 0 ? { adds, dels } : null;
  }
  // A whole-file write: the new content is countable, what it replaced is not.
  const content = [record["content"], record["file_text"], record["contents"]].find(
    (value) => typeof value === "string",
  ) as string | undefined;
  if (content !== undefined) {
    const adds = lineCount(content);
    return adds > 0 ? { adds, dels: 0 } : null;
  }
  return null;
}

/**
 * Agent state — memory notes under `~/.claude/`, scratchpads under the OS
 * temp dir, harness config in home dot-directories — is not project code.
 * The project's checks can never verify those writes, so classifying them as
 * mutations both turned note-taking sessions into "unverified coding
 * sessions" and let an end-of-session memory note invalidate checks that had
 * already passed. A path inside the session's own working directory is never
 * agent state: a dotfiles project under `~/.config` is still a project.
 * Relative paths cannot be judged and keep the conservative mutation reading.
 */
function isAgentStatePath(path: string, projectDir: string | null): boolean {
  const normalized = normalizePath(path);
  if (!/^(?:[A-Za-z]:)?\//.test(normalized)) return false;
  if (projectDir) {
    const project = normalizePath(projectDir);
    if (project && (normalized === project || normalized.startsWith(project + "/"))) return false;
  }
  const home = normalizePath(homedir());
  if (home && normalized.startsWith(home + "/.")) return true;
  return [normalizePath(tmpdir()), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
    .filter((root) => root.length > 1)
    .some((root) => normalized === root || normalized.startsWith(root + "/"));
}

function commandFromInput(value: unknown, depth = 0): string | null {
  if (depth > 2) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 1_000_000) {
      try {
        return commandFromInput(JSON.parse(trimmed), depth + 1) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string") return record[key].trim();
  }
  for (const key of ["input", "arguments", "args", "params"]) {
    const command = commandFromInput(record[key], depth + 1);
    if (command) return command;
  }
  return null;
}

/**
 * A heredoc body is stdin data, not commands — `git commit -F - <<'EOF'` is
 * how agents commit, and its body must not read as opaque chained commands.
 * With a quoted delimiter the shell expands nothing, so the body is provably
 * inert; an unquoted delimiter expands `$(…)` and backticks, so those bodies
 * only drop when they contain neither.
 */
function stripHeredocs(raw: string): string {
  return raw.replace(
    /<<-?\s*(["']?)(\w+)\1[^\S\n]*(\n[\s\S]*?)\n\2(?=\n|$)/g,
    (match, quote, _delimiter, body) => (quote || !/[$`]/.test(body) ? "" : match),
  );
}

const RUNNER_PREFIX =
  /^(?:npx|bunx|uvx|(?:npm|pnpm|yarn)\s+(?:exec|dlx|x)|bun\s+x|(?:uv|poetry|pipenv|hatch)\s+run|bundle\s+exec)(?=\s|$)/;
const VALUE_FLAG = /^(?:--extra|--with|--group|--directory|--project|--package|-p|--cwd|--python)$/;
const TASK_TARGET =
  /^(?:(?:(?:pnpm|npm|yarn|bun)\s+)?(?:nx|turbo)\s+(?:run\s+)?(?:[\w.-]+[:])?|(?:just|task|invoke)\s+)(typecheck|type-check|check-types|vitest|jest|mocha|test|spec|lint|build|t)(?:[:._-][a-z0-9:._-]*)?(?:\s|$)/;

function stripCommandPrefixes(raw: string): string {
  let command = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z_][a-z0-9_]*=[^\s]+\s+)*/, "")
    .replace(/^py(?:thon)?\s+-\d+(?:\.\d+)?\s+/, "python ")
    .replace(/^py\s+/, "python ")
    .replace(/\bpython3\.\d+\b/g, "python3")
    .replace(/^(?:bash|sh|zsh|fish|cmd|pwsh|powershell)(?=\s+[^-\s])\s+/, "");
  for (;;) {
    const prefix = command.match(RUNNER_PREFIX);
    if (!prefix) break;
    command = command.slice(prefix[0].length).trimStart();
    while (true) {
      const token = command.match(/^(\S+)(?:\s+|$)/);
      if (!token || !token[1].startsWith("-")) break;
      const rawFlag = token[1];
      command = command.slice(token[0].length);
      const flag = rawFlag.replace(/=[\s\S]*$/, "");
      if (rawFlag !== "--" && !rawFlag.includes("=") && VALUE_FLAG.test(flag)) {
        const value = command.match(/^\S+(?:\s+|$)/);
        if (value && !value[0].startsWith("-")) command = command.slice(value[0].length);
      }
    }
  }
  return (
    command
      .replace(/^(?:python3?\s+-m\s+)?coverage\s+run(?:\s+-+[^\s]+)*\s+(?:-m\s+)?/, "")
      // Each repeated unit ends at exactly one separator ([^\s/\\]* cannot
      // cross it), so a non-matching path fails in linear time. The previous
      // (?:\S+?[/\\])* let \S eat separators too, and a long slash-filled token
      // that never reaches bin/ or scripts/ backtracked exponentially — codex
      // desktop's JS exec cells froze whole scans on it.
      .replace(/^(?:[a-z]:)?[/\\]?(?:[^\s/\\]*[/\\])*(?:\.?bin|scripts)[/\\]/i, "")
      .replace(/^(\S+)\.exe\b/i, "$1")
  );
}

function targetKind(name: string): VerificationKind {
  if (name === "lint") return "lint";
  if (name === "build") return "build";
  if (name === "typecheck" || name === "type-check" || name === "check-types") return "typecheck";
  return "test";
}

function namedCheck(command: string): Classified | null {
  const task = command.match(TASK_TARGET);
  if (task) return { kind: "verification", verificationKind: targetKind(task[1]) };
  const token = (command.split(/\s+/, 1)[0] ?? "").replace(/\.exe$/i, "");
  const base = token
    .replace(/^.*[/\\]/, "")
    .replace(/\.(?:sh|bash|zsh|fish|ps1|cmd|bat|py|rb|js|mjs|cjs|ts)$/i, "");
  const pathed = /[/\\]/.test(token) || token !== base;
  if (/^(?:run[-_])?(?:tests?|specs?)$/.test(base)) {
    if (/^(?:tests?|specs?)$/.test(base) && !pathed) return null;
    return { kind: "verification", verificationKind: "test" };
  }
  if (!pathed) return null;
  if (/^(?:typecheck|type-check|check-types)$/.test(base)) {
    return { kind: "verification", verificationKind: "typecheck" };
  }
  if (base === "lint") return { kind: "verification", verificationKind: "lint" };
  if (base === "build") return { kind: "verification", verificationKind: "build" };
  return null;
}

/** Test-runner summaries only — not build/lint banners, so ./deploy.sh stays opaque. */
function looksLikeTestRunner(text: string): boolean {
  const tail = text.slice(-20_000);
  return (
    /\b\d+\s+(?:fail(?:ed|ing|ures?)?|pass(?:ed|ing)?)\b/i.test(tail) ||
    /\b(?:fail|pass)(?:ed)?\s+\d+\b/i.test(tail) ||
    /\bfailed\s+\(failures?=/i.test(tail) ||
    /\bran\s+\d+\s+tests?\b/i.test(tail) ||
    /\b\d+ (?:examples?|tests?), \d+ failures\b/.test(tail) ||
    /\b\d+ runs, \d+ assertions,/.test(tail) ||
    /\btest result: ok\b/i.test(tail) ||
    /\b(?:passed|failed):\s*\d+/i.test(tail) ||
    /\ball specs passed\b/i.test(tail)
  );
}

function classifyCommand(rawInput: string): Classified | null {
  const raw = stripHeredocs(rawInput);
  // Separators inside quotes (`grep -E "a|b"`, heredoc commit messages) are
  // argument text, not chain structure, so quoted spans are blanked before
  // looking for separators. Classification only ever reads command prefixes
  // and flags, which never legitimately live inside quotes.
  const masked = raw.replace(/"[^"]*"|'[^']*'/g, (quoted) => quoted[0] + quoted.slice(-1));
  // A newline outside quotes chains commands exactly like `;`. Unquoted
  // heredoc bodies land here too and classify as opaque segments, which is
  // the conservative outcome.
  if (masked.includes("||")) {
    const alternatives = masked.split("||").map((segment) => classifyCommand(segment));
    if (alternatives.every((part) => part?.kind === "observation")) {
      return { kind: "observation" };
    }
    // `pytest || echo failed` / `pnpm test || true`: the fallback consumes
    // the exit code, but the check ran and its own summary line still carries
    // the verdict — the same exit-unreliable footing as a trailing `| tail`.
    const active = alternatives.filter((part) => part?.kind !== "observation");
    if (active.length === 1 && active[0]?.kind === "verification") {
      return { ...active[0], exitUnreliable: true };
    }
    return null;
  }
  // `cd app && pnpm build && pnpm test 2>&1 | tail -8` is how agents actually
  // run checks. A chain classifies as its strongest classifiable segment —
  // but only when every segment is classifiable; one opaque segment hides
  // arbitrary effects and poisons the whole chain. The chain's exit code is
  // only meaningful when nothing follows the classifying segment except `&&`
  // hops (a `;`, `|`, or newline afterwards replaces or hides its exit).
  if (/[;|\n\r]|&&/.test(masked)) {
    const segments = masked.split(/&&|;|\||\r?\n/);
    const separators = [...masked.matchAll(/&&|;|\||\r?\n/g)].map((match) =>
      match[0] === "&&" ? "&&" : match[0] === "|" ? "|" : ";",
    );
    const parts = segments.map((segment) => classifyCommand(segment));
    if (parts.some((part) => part === null)) return null;
    // Whether a segment's verdict survives to the chain's end: its exit code
    // is only meaningful when nothing but `&&` hops follow it, and a failure
    // marker only survives the pipe when every filter after the segment keeps
    // the end of the stream: `tail` and `cat` do, `head`/`grep`/`wc` may cut
    // or drop the very lines that carry it.
    const finalize = (part: Classified): Classified => {
      const index = parts.lastIndexOf(part);
      const exitUnreliable =
        separators.slice(index).some((separator) => separator !== "&&") ||
        part.exitUnreliable === true;
      if (!exitUnreliable) return part;
      let endPreserved = part.failureMarked === true;
      for (let position = index; position < separators.length && endPreserved; position++) {
        if (
          separators[position] === "|" &&
          !/^\s*(?:tail|cat)\b/.test(segments[position + 1] ?? "")
        ) {
          endPreserved = false;
        }
      }
      return { ...part, exitUnreliable, failureMarked: endPreserved };
    };
    const delivery = parts.findLast((part) => part?.kind === "delivery");
    const verification = parts.findLast((part) => part?.kind === "verification");
    if (!delivery && !verification) return { kind: "observation" };
    if (!delivery) return finalize(verification!);
    if (!verification) return finalize(delivery);
    // Checks and a ship in one chain: the delivery is the chain's strongest
    // claim, but the checks are the verification evidence. Certifying them
    // needs every check in the chain to be provable — one unmarkable check
    // could fail without stopping the ship, so its silence proves nothing.
    const chained = finalize(verification);
    if (chained.exitUnreliable) {
      chained.failureMarked = parts
        .filter((part) => part?.kind === "verification")
        .every((part) => finalize(part!).failureMarked === true);
    }
    return { ...finalize(delivery), chainedVerification: chained };
  }
  const command = stripCommandPrefixes(raw);
  if (!command) return null;
  const optionCommand = command.replace(/"[^"]*"|'[^']*'/g, "Q");
  if (
    /(?:^|\s)(?:--help|-h|--version|--dry-run|--dryrun|--if-present|--listtests|--list-tests|--collect-only|--fixtures|--showconfig|--show-config|--no-run|-co|-list)(?:\s|$)/.test(
      optionCommand,
    ) ||
    /^(?:npx\s+)?vitest\s+list(?:\s|$)/.test(optionCommand)
  ) {
    return { kind: "observation" };
  }

  if (
    (/^git\s+(?:commit|push)(?:\s|$)/.test(command) &&
      !/\s--(?:dry-run|help)(?:\s|$)|\s-[h](?:\s|$)/.test(command)) ||
    (/^gh\s+pr\s+create(?:\s|$)/.test(command) && !/\s--help(?:\s|$)/.test(command))
  ) {
    return { kind: "delivery" };
  }
  if (/^git\s+diff\s+--check(?:\s|$)/.test(command)) {
    return { kind: "verification", verificationKind: "lint" };
  }
  if (
    // `t` is npm's built-in alias for `test`; `[:._-]` suffixes cover the
    // test:e2e / test-unit / test.watch script-naming conventions alike.
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:test|t|vitest|jest)(?:[:._-][a-z0-9:._-]+)?(?:\s|$)/.test(
      command,
    ) ||
    /^(?:(?:npx|pnpm|yarn|bun)\s+(?:exec\s+)?)?(?:vitest|jest|mocha|pytest|phpunit|pest|rspec|tox)(?:\s|$)/.test(
      command,
    ) ||
    /^(?:uv\s+pytest|hatch\s+test)(?:\s|$)/.test(command) ||
    /^(?:(?:react-scripts|playwright)\s+test|cypress\s+run)(?:\s|$)/.test(command) ||
    /^(?:\.\/)?vendor\/bin\/(?:phpunit|pest)(?:\s|$)/.test(command) ||
    /^python(?:3)?\s+-m\s+(?:pytest|unittest|django\s+test)(?:\s|$)/.test(command) ||
    // Django's canonical runners, standalone or via `python`.
    /^(?:(?:python3?\s+)?(?:\.\/)?manage\.py|django-admin)\s+test(?:\s|$)/.test(command) ||
    /^(?:go|cargo|mix|deno|dart|flutter|swift)\s+test(?:\s|$)/.test(command) ||
    /^dotnet\s+(?:watch\s+)?(?:test|vstest)(?:\s|$)/.test(command) ||
    /^zig\s+(?:build\s+)?test(?:\s|$)/.test(command) ||
    /^(?:rails|rake)\s+(?:test|spec)(?::[a-z0-9:_-]+)?(?:\s|$)/.test(command) ||
    /^(?:composer|php\s+artisan)\s+test(?::[a-z0-9:_-]+)?(?:\s|$)/.test(command) ||
    /^(?:make\s+(?:test|check)|ctest)(?:\s|$)/.test(command) ||
    /^(?:\.\/)?(?:mvn|mvnw)(?:\s+[^\s]+)*\s+test(?:\s|$)/.test(command) ||
    /^(?:\.\/)?(?:gradle|gradlew)(?:\s+[^\s]+)*\s+test(?:\s|$)/.test(command) ||
    /^node\s+--test(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "test",
      failureMarked:
        /^(?:pnpm|npm|yarn)(?:\s+run)?\s|^make\s|^(?:\.\/)?(?:mvn|mvnw|gradle|gradlew)\b/.test(
          command,
        ),
    };
  }
  if (
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:typecheck|type-check|check-types)(?:[:._-][a-z0-9:._-]+)?(?:\s|$)/.test(
      command,
    ) ||
    /^(?:npx\s+)?(?:tsc|vue-tsc)(?:\s|$)/.test(command) ||
    /^(?:mypy|pyright|go\s+vet|cargo\s+check|deno\s+check|phpstan|psalm)(?:\s|$)/.test(command) ||
    /^python(?:3)?\s+-m\s+(?:mypy|pyright)(?:\s|$)/.test(command) ||
    /^(?:dart|flutter)\s+analyze(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "typecheck",
      failureMarked: /^(?:pnpm|npm|yarn)(?:\s+run)?\s|^(?:npx\s+)?(?:tsc|vue-tsc)(?:\s|$)/.test(
        command,
      ),
    };
  }
  if (
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+build(?:[:._-][a-z0-9:._-]+)?(?:\s|$)/.test(command) ||
    /^(?:go|cargo|dotnet|swift|flutter)\s+build(?:\s|$)/.test(command) ||
    // The JS framework CLIs agents call directly (usually via a stripped npx).
    /^(?:next|vite|react-scripts|astro|remix)\s+build(?:\s|$)/.test(command) ||
    /^zig\s+build(?!\s+test)(?:\s|$)/.test(command) ||
    /^mix\s+compile(?:\s|$)/.test(command) ||
    /^make(?:\s+(?:build|all))?$/.test(command) ||
    /^(?:\.\/)?(?:mvn|mvnw)(?:\s+[^\s]+)*\s+(?:package|verify)(?:\s|$)/.test(command) ||
    /^(?:\.\/)?(?:gradle|gradlew)(?:\s+[^\s]+)*\s+build(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "build",
      failureMarked:
        /^(?:pnpm|npm|yarn)(?:\s+run)?\s|^make\b|^(?:\.\/)?(?:mvn|mvnw|gradle|gradlew)\b/.test(
          command,
        ),
    };
  }
  if (
    // plain `fmt`/`format` rewrites files; only the check variants verify.
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:lint(?:[:._-][a-z0-9:._-]+)?|(?:fmt|format):check)(?:\s|$)/.test(
      command,
    ) ||
    /^(?:npx\s+)?oxfmt\s+--check(?:\s|$)/.test(command) ||
    /^(?:npx\s+)?(?:eslint|oxlint)(?:\s|$)/.test(command) ||
    /^next\s+lint(?:\s|$)/.test(command) ||
    // Django's system check verifies configuration without touching files.
    /^(?:(?:python3?\s+)?(?:\.\/)?manage\.py|django-admin)\s+check(?:\s|$)/.test(command) ||
    /^(?:ruff\s+check|biome\s+check|cargo\s+clippy|golangci-lint|staticcheck)(?:\s|$)/.test(
      command,
    ) ||
    /^(?:flake8|pylint|rubocop|swiftlint|deno\s+lint)(?:\s|$)/.test(command) ||
    /^(?:black|ruff\s+format)\b(?=.*--check(?:\s|$))/.test(command) ||
    /^prettier\b(?=.*(?:--check|-c)(?:\s|$))/.test(command) ||
    /^(?:deno\s+fmt|cargo\s+fmt)\b(?=.*--check(?:\s|$))/.test(command) ||
    /^mix\s+(?:format\s+--check-formatted|credo)(?:\s|$)/.test(command) ||
    /^dotnet\s+format\b(?=.*--verify-no-changes(?:\s|$))/.test(command) ||
    /^terraform\s+(?:validate|fmt\s+-check)(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "lint",
      failureMarked: /^(?:pnpm|npm|yarn)(?:\s+run)?\s/.test(command),
    };
  }
  const custom = namedCheck(command);
  if (custom) return custom;
  // Descriptor redirects and /dev/null do not touch project files. Other `>`
  // targets can turn even `echo` into a write, so they stay unclassified.
  const observationCommand = command
    .replace(/"[^"]*"|'[^']*'/g, "Q")
    .replace(/\s+[012]?>\s*\/dev\/null(?=\s|$)/g, "")
    .replace(/\s+[012]?>&[012](?=\s|$)/g, "")
    .replace(/^git(?:\s+(?:--no-pager|-C\s+\S+|-c\s+\S+))+\s+/, "git ");
  if (!observationCommand.includes(">")) {
    if (
      /^(?:pwd|ls|cd|echo|cat|head|tail|which|sleep|true|env|nl|wc|jq|tree|date|rg|grep|diff|sort|uniq|cut|tr|column|basename|dirname|stat|du|file)(?:\s|$)/.test(
        observationCommand,
      ) ||
      /^git\s+(?:status|diff|log|show|rev-parse|rev-list|branch|remote|fetch|blame|ls-files|ls-remote|describe|shortlog|grep|add|merge-base|check-ignore|reflog|config)(?:\s|$)/.test(
        observationCommand,
      ) ||
      /^git\s+(?:checkout\s+-b|switch\s+-c)\s+\S+$/.test(observationCommand) ||
      /^(?:git|gh|npm|pnpm|yarn|bun|node|python3?|go|cargo)\s+--version(?:\s|$)/.test(
        observationCommand,
      ) ||
      // Remote gh calls change GitHub, never this working tree. `pr checkout`
      // and `repo clone` are the tree-touching exceptions and stay out.
      /^gh\s+(?:api|auth\s+status|repo\s+view|pr\s+(?!checkout\b)[a-z-]+|issue\s+[a-z-]+|run\s+(?:view|list|watch|rerun|cancel)|release\s+(?:view|list)|workflow\s+[a-z-]+)(?:\s|$)/.test(
        observationCommand,
      ) ||
      /^(?:npm|pnpm|yarn)\s+(?:view|info|why|ls|list|outdated)(?:\s|$)/.test(observationCommand) ||
      // A bare install syncs node_modules to the lockfile; naming packages
      // would rewrite package.json, so any non-flag argument disqualifies.
      /^(?:pnpm|npm|yarn|bun)\s+(?:install|i)(?:\s+-+[a-z-]+)*$/.test(observationCommand) ||
      /^ctx7(?:@[^\s]*)?(?:\s|$)/.test(observationCommand)
    ) {
      return { kind: "observation" };
    }
    // sed only reads with -n and no in-place flag; find only reads until
    // -delete or -exec appears.
    if (
      /^sed\s+-n(?:\s|$)/.test(observationCommand) &&
      !/\s-i\b|--in-place/.test(observationCommand)
    ) {
      return { kind: "observation" };
    }
    if (
      /^find(?:\s|$)/.test(observationCommand) &&
      !/\s-(?:delete|exec|execdir|ok|okdir)\b/.test(observationCommand)
    ) {
      return { kind: "observation" };
    }
  }
  return null;
}

function classifyTool(name: string, input: unknown, projectDir: string | null): Classified | null {
  const normalized = normalizeTool(name);
  if (MUTATION_TOOLS.has(normalized)) {
    const targets = mutationTargets(input);
    if (targets.length > 0 && targets.every((target) => isAgentStatePath(target, projectDir))) {
      return { kind: "observation" };
    }
    return { kind: "mutation" };
  }
  if (/^(?:create_)?pull_request$/.test(normalized) || normalized === "create_pr") {
    return { kind: "delivery" };
  }
  if (/^(?:run_)?tests?$/.test(normalized)) {
    return { kind: "verification", verificationKind: "test" };
  }
  if (/^(?:run_)?(?:typecheck|type_check)$/.test(normalized)) {
    return { kind: "verification", verificationKind: "typecheck" };
  }
  if (/^(?:run_)?build$/.test(normalized)) {
    return { kind: "verification", verificationKind: "build" };
  }
  if (/^(?:run_)?lint$/.test(normalized)) {
    return { kind: "verification", verificationKind: "lint" };
  }
  // MCP tools and codex connector calls (leading underscore) run against a
  // remote service, so whatever they change, it is not this working tree —
  // unless the name itself says it handles files, which is what filesystem
  // MCP servers look like.
  if (/^mcp[_:]|^_/.test(normalized)) {
    if (
      /(?:write|edit|create|save|delete|remove|move|copy|update)_?(?:file|files|dir)/.test(
        normalized,
      )
    ) {
      return null;
    }
    if (/(?:create|open)_?(?:pull_request|pr)\b/.test(normalized)) return { kind: "delivery" };
    return { kind: "observation" };
  }
  if (!SHELL_TOOLS.has(normalized)) return null;
  const command = commandFromInput(input);
  return command ? classifyCommand(command) : null;
}

/**
 * Reads a check's verdict from the runner's own summary line — the part a
 * trailing `| tail -n` keeps — for commands whose exit code was replaced by a
 * filter's. Inspected transiently: only the derived outcome survives.
 * Failure patterns win over pass patterns, and an unrecognised summary stays
 * unknown rather than becoming a claim in either direction.
 */
export function verificationVerdict(text: string): ToolOutcome {
  // Summaries print at the end; bounding the scan keeps huge logs cheap.
  const tail = text.slice(-20_000);
  if (
    /\b(?!0+\b)\d+\s+fail(?:ed|ing|ures?)?\b/i.test(tail) || // vitest/jest/pytest/mocha
    /\bfail(?:ed)?\s+(?!0+\b)\d+\b/i.test(tail) || // node --test "fail 1"
    /\bFAILED\b/.test(tail) || // cargo/pytest banners
    /^FAIL\b/m.test(tail) || // go test / jest per-file
    /\berror TS\d+/.test(tail) || // tsc
    /\bELIFECYCLE\b/.test(tail) || // pnpm script exited non-zero
    /\bnpm ERR!/.test(tail) || // npm script exited non-zero
    /\berror Command failed\b/.test(tail) || // yarn script exited non-zero
    /✖ \d+ problems?\b/.test(tail) || // eslint
    /\bfound \d+ warnings? and (?!0\b)\d+ errors?\b/i.test(tail) || // oxlint
    /\bBUILD FAIL(?:ED|URE)\b/.test(tail) || // gradle / maven
    /\bBuild FAILED\b/.test(tail) || // dotnet build / msbuild
    /\bfailed:\s*[1-9]\d*\b/i.test(tail) || // dotnet test "Failed: 2"
    /\b\d+ runs, \d+ assertions, \d+ failures, [1-9]\d* errors\b/.test(tail) || // minitest errors
    /^make: \*\*\*/m.test(tail) // make target exited non-zero
  ) {
    return "failure";
  }
  if (
    /\b(?!0+\b)\d+\s+pass(?:ed|ing)?\b/i.test(tail) || // "9 passed"
    /\bpass\s+(?!0+\b)\d+\b/i.test(tail) || // node --test "pass 97"
    /\btest result: ok\b/.test(tail) || // cargo
    /^ok\s+\S+/m.test(tail) || // go test
    /\bfound \d+ warnings? and 0 errors?\b/i.test(tail) || // oxlint (exit 0 with warnings)
    /\ball matched files use the correct format\b/i.test(tail) || // oxfmt --check
    /\bBUILD SUCCESS(?:FUL)?\b/.test(tail) || // maven / gradle
    /\b\d+ (?:examples?|tests?), 0 failures\b/.test(tail) || // rspec / exunit
    /\b\d+ runs, \d+ assertions, 0 failures, 0 errors\b/.test(tail) || // minitest / rails test
    /^OK(?: \(skipped=\d+\))?\s*$/m.test(tail) || // unittest / django (FAILED caught above)
    /\bpassed:\s*[1-9]\d*\b/i.test(tail) || // dotnet test "Passed: 5" (Failed > 0 caught above)
    /\bBuild succeeded\b/.test(tail) || // dotnet build / msbuild
    /\ball specs passed\b/i.test(tail) || // cypress
    /\ball checks passed\b/i.test(tail) // ruff
  ) {
    return "success";
  }
  return "unknown";
}

/** Reads status metadata only. Raw output is never retained or returned. */
export function toolOutcome(value: unknown, depth = 0): ToolOutcome {
  if (depth > 5 || value === null || value === undefined) return "unknown";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 1_000_000) {
      try {
        const nested = toolOutcome(JSON.parse(trimmed), depth + 1);
        if (nested !== "unknown") return nested;
      } catch {
        // Native tools also return arbitrary text beginning with braces.
      }
    }
    const exit = value.match(
      /(?:process\s+exited\s+with(?:\s+code)?|exit(?:ed)?(?:\s+with)?(?:\s+code)?[: ]+)\s*(-?\d+)/i,
    );
    return exit ? (Number(exit[1]) === 0 ? "success" : "failure") : "unknown";
  }
  if (Array.isArray(value)) {
    const outcomes = value.map((entry) => toolOutcome(entry, depth + 1));
    if (outcomes.includes("failure")) return "failure";
    if (outcomes.includes("not-run")) return "not-run";
    if (outcomes.includes("success")) return "success";
    return "unknown";
  }
  if (typeof value !== "object") return "unknown";
  const record = value as Record<string, unknown>;
  if (record["userDecision"] === "rejected") return "not-run";
  const status = typeof record["status"] === "string" ? record["status"].toLowerCase() : "";
  if (["cancelled", "canceled", "rejected", "aborted"].includes(status)) return "not-run";
  if (["error", "failed", "failure"].includes(status)) return "failure";
  if (record["isError"] === true) return "failure";
  if (record["is_error"] === true) return "failure";
  if (record["success"] === false) return "failure";
  for (const key of ["exitCode", "exit_code", "exit", "code"]) {
    if (typeof record[key] === "number") return record[key] === 0 ? "success" : "failure";
  }
  if (record["error"]) return "failure";
  const nestedOutcomes = ["state", "result", "output", "metadata", "value", "content", "text"]
    .map((key) => toolOutcome(record[key], depth + 1))
    .filter((outcome) => outcome !== "unknown");
  if (nestedOutcomes.includes("failure")) return "failure";
  if (nestedOutcomes.includes("not-run")) return "not-run";
  if (record["isError"] === false) return "success";
  if (record["is_error"] === false) return "success";
  if (record["success"] === true) return "success";
  if (nestedOutcomes.includes("success")) return "success";
  if (["completed", "success", "succeeded"].includes(status)) return "success";
  return "unknown";
}

export class WorkflowTracker {
  private readonly events: WorkflowEvent[] = [];
  private readonly callIds = new Map<string, WorkflowEvent>();
  private readonly changedFiles = new Set<string>();
  private turn = -1;
  private unknownShellCall = false;
  private sessionChanged = false;
  private sequenceKnown: boolean;
  private projectDirValue: string | null = null;
  private estimatedAdds: number | null = null;
  private estimatedDels: number | null = null;

  constructor(private readonly options: TrackerOptions) {
    this.sequenceKnown = options.sequenceKnown;
  }

  /**
   * First-seen session working directory. Scopes the agent-state exclusion:
   * a write under this directory is always a project mutation.
   */
  projectDir(dir: string): void {
    if (!this.projectDirValue && dir) this.projectDirValue = dir;
  }

  humanTurn(): void {
    this.turn++;
  }

  uncertainSequence(): void {
    this.sequenceKnown = false;
  }

  toolCall(
    name: string,
    input?: unknown,
    id?: string | null,
    outcome: ToolOutcome = "unknown",
    resultText?: string | null,
  ): void {
    const normalized = normalizeTool(name);
    let classified = classifyTool(name, input, this.projectDirValue);
    if (!classified) {
      if (SHELL_TOOLS.has(normalized)) {
        // An opaque command can hide arbitrary effects on files, but it can
        // only deliver if it invokes git/gh at all. A `curl` or a `python
        // script.py` says nothing about delivery, so it must not erase the
        // session's negative delivery evidence — only a command that names a
        // git tool (or one whose text is unreadable) keeps that uncertainty.
        const command = commandFromInput(input);
        if (command === null || /(?:^|[\s;&|(`$])(?:git|gh|glab)(?:\s|$)/.test(command)) {
          this.unknownShellCall = true;
        }
        classified = { kind: "unknown-shell" };
      } else if (OBSERVATION_TOOLS.has(normalized)) classified = { kind: "observation" };
      else classified = { kind: "unknown-tool" };
    }
    const { chainedVerification, ...bare } = classified;
    const turn = this.turn >= 0 ? this.turn : null;
    const event: WorkflowEvent = { ...bare, outcome: "unknown", turn, name: normalized };
    if (event.kind === "mutation") {
      const diff = editDiff(name, input);
      if (diff) event.pendingDiff = diff;
      const targets = mutationTargets(input);
      if (targets.length > 0) event.targets = targets.map(normalizePath);
    }
    if (chainedVerification) {
      const companion: WorkflowEvent = {
        ...chainedVerification,
        outcome: "unknown",
        turn,
        name: normalized,
        isCompanion: true,
      };
      this.events.push(companion);
      event.companion = companion;
    }
    this.events.push(event);
    if (id) this.callIds.set(id, event);
    if (outcome !== "unknown") this.settle(event, outcome, resultText);
  }

  toolResult(
    outcome: ToolOutcome,
    id?: string | null,
    name?: string | null,
    resultText?: string | null,
  ): void {
    let event = id ? this.callIds.get(id) : undefined;
    if (!event && name) {
      const normalized = normalizeTool(name);
      const candidates = this.events.filter(
        (candidate) =>
          candidate.name === normalized &&
          candidate.outcome === "unknown" &&
          candidate.isCompanion !== true,
      );
      if (candidates.length === 1) event = candidates[0];
    }
    if (event) this.settle(event, outcome, resultText);
  }

  /**
   * Records an arrived result: replaces exit-based outcomes with the runner's
   * own verdict where the exit code was consumed by a filter, and re-appends
   * the event so the list stays ordered by completion.
   */
  private settle(event: WorkflowEvent, outcome: ToolOutcome, resultText?: string | null): void {
    if (event.companion) {
      const companion = event.companion;
      event.companion = undefined;
      this.settle(companion, outcome, resultText);
    }
    if (
      event.kind === "unknown-shell" &&
      typeof resultText === "string" &&
      looksLikeTestRunner(resultText) &&
      verificationVerdict(resultText) !== "unknown"
    ) {
      event.kind = "verification";
      event.verificationKind = "test";
      event.exitUnreliable = true;
    }
    if (event.exitUnreliable) {
      let verdict: ToolOutcome =
        event.kind === "verification" && typeof resultText === "string"
          ? verificationVerdict(resultText)
          : "unknown";
      if (
        verdict === "unknown" &&
        event.failureMarked === true &&
        outcome !== "failure" &&
        typeof resultText === "string" &&
        resultText.trim().length > 0
      ) {
        // The runner always prints a marker on failure and the pipe kept the
        // end of the stream, so non-empty marker-free output is a pass.
        verdict = "success";
      }
      event.outcome = verdict;
      event.settled = true;
    } else {
      event.outcome = outcome;
      event.settled = outcome !== "unknown";
    }
    // A mutation's implied diff is banked exactly once, and only when the
    // result confirms it ran — a denied or failed edit changed nothing.
    if (event.kind === "mutation" && event.outcome === "success") {
      if (event.pendingDiff) {
        this.estimatedAdds = (this.estimatedAdds ?? 0) + event.pendingDiff.adds;
        this.estimatedDels = (this.estimatedDels ?? 0) + event.pendingDiff.dels;
        event.pendingDiff = undefined;
      }
      for (const target of event.targets ?? []) this.changedFiles.add(target);
    }
    const index = this.events.indexOf(event);
    if (index >= 0) {
      this.events.splice(index, 1);
      this.events.push(event);
    }
  }

  delivery(outcome: ToolOutcome = "success"): void {
    this.events.push({
      kind: "delivery",
      outcome,
      turn: this.turn >= 0 ? this.turn : null,
      name: "delivery",
    });
  }

  /** Session-level diff evidence proves a change, but not where it happened. */
  changedSession(): void {
    this.sessionChanged = true;
  }

  /**
   * The diff the session's successful mutations imply, for harnesses without
   * a native summary. Null parts mean "nothing measured", never "zero": line
   * counts stay null until an edit with measurable arguments succeeds, and
   * the file count until a successful mutation names its target.
   */
  estimatedOutcome(): {
    filesChanged: number | null;
    additions: number | null;
    deletions: number | null;
  } {
    return {
      filesChanged: this.changedFiles.size > 0 ? this.changedFiles.size : null,
      additions: this.estimatedAdds,
      deletions: this.estimatedDels,
    };
  }

  finish(): WorkflowEvidence {
    // `settle` re-appends events as their results arrive, so by now the list
    // is completion-ordered. An event that never settled has no known
    // completion point — it may have finished after everything else — so it
    // moves to the end, where the boundary logic below treats it as a possible
    // last change and refuses to certify checks that ran before it.
    const events = [
      ...this.events.filter((event) => event.kind === "observation" || event.settled === true),
      ...this.events.filter((event) => event.kind !== "observation" && event.settled !== true),
    ];
    const mutations = events.filter((event) => event.kind === "mutation");
    const successfulMutations = mutations.filter((event) => event.outcome === "success");
    let codeChange: WorkflowCodeChange = "none";
    if (successfulMutations.length > 0 || this.sessionChanged) codeChange = "success";
    else if (mutations.some((event) => event.outcome === "failure")) codeChange = "failure";
    else if (mutations.some((event) => event.outcome === "unknown")) codeChange = "unknown";

    let finalVerification: WorkflowVerification = "unknown";
    let stalePass: boolean | null = null;
    let autonomousVerifiedChange: boolean | null = null;
    let recoveredFromFailure: boolean | null = null;
    let failedChecks: number | null = null;
    // A denied or cancelled check never ran, so it is not evidence a check
    // ran — `verificationKinds` answers "did any check run?" downstream.
    const verificationKinds = [
      ...new Set(
        events
          .filter((event) => event.kind === "verification" && event.outcome !== "not-run")
          .map((event) => event.verificationKind)
          .filter((kind): kind is VerificationKind => kind !== undefined),
      ),
    ].sort();

    const lastSuccessfulMutation = events.findLastIndex(
      (event) => event.kind === "mutation" && event.outcome === "success",
    );
    // A denied or cancelled call never ran, so whatever it might have changed,
    // it didn't — `not-run` events cannot be the last change.
    const lastUncertainChange = events.findLastIndex(
      (event) =>
        event.outcome !== "not-run" &&
        ((event.kind === "mutation" && event.outcome === "unknown") ||
          event.kind === "unknown-shell" ||
          event.kind === "unknown-tool"),
    );
    const lastChangeBoundary = Math.max(lastSuccessfulMutation, lastUncertainChange);

    if (
      codeChange === "success" &&
      this.sequenceKnown &&
      lastSuccessfulMutation >= 0 &&
      lastChangeBoundary >= 0
    ) {
      const firstSuccessfulMutation = events.findIndex(
        (event) => event.kind === "mutation" && event.outcome === "success",
      );
      const allChecks = events
        .map((event, index) => ({ event, index }))
        .filter(
          ({ event, index }) => index > firstSuccessfulMutation && event.kind === "verification",
        );
      const checks = allChecks.filter(
        ({ event, index }) => index > lastChangeBoundary && event.kind === "verification",
      );
      const latestByKind = new Map<VerificationKind, (typeof checks)[number]>();
      for (const check of allChecks) {
        const kind = check.event.verificationKind!;
        if (check.event.outcome !== "not-run" || !latestByKind.has(kind)) {
          latestByKind.set(kind, check);
        }
      }
      const latestChecks = [...latestByKind.values()];
      const finalSuccessfulCheck = checks.findLast(({ event }) => event.outcome === "success");
      if (checks.length === 0) {
        finalVerification =
          this.options.commandObservation && lastChangeBoundary === lastSuccessfulMutation
            ? "not-run"
            : "unknown";
      } else if (latestChecks.some(({ event }) => event.outcome === "unknown")) {
        finalVerification = "unknown";
      } else if (latestChecks.some(({ event }) => event.outcome === "failure")) {
        finalVerification = "failed";
        autonomousVerifiedChange = false;
      } else if (
        finalSuccessfulCheck &&
        latestChecks.some(({ event }) => event.outcome === "success")
      ) {
        finalVerification = "passed";
        const change = events[lastChangeBoundary];
        autonomousVerifiedChange =
          change?.turn != null && finalSuccessfulCheck?.event.turn != null
            ? change?.turn === finalSuccessfulCheck?.event.turn
            : null;
      } else {
        finalVerification = "not-run";
        autonomousVerifiedChange = false;
      }

      // The edit → tests pass → tweak → stop pattern: the final change is
      // honestly unverified, but the work was not unchecked — a check passed
      // after an earlier change. Reported separately so the scorer can price
      // it between "verified at the end" and "never verified". Also reported
      // when a trailing opaque command leaves the final verdict "unknown":
      // the earlier pass is measured evidence either way.
      if (finalVerification === "not-run" || finalVerification === "unknown") {
        stalePass = allChecks.some(({ event }) => event.outcome === "success");
      }

      const failures = allChecks.filter(({ event }) => event.outcome === "failure");
      // Counted, not just flagged: `recoveredFromFailure: false` alone cannot
      // tell "nothing failed" from "a failure was left unresolved".
      failedChecks = failures.length;
      if (failures.length > 0) {
        recoveredFromFailure = failures.some((failed) => {
          const laterPass = allChecks.find(
            ({ event, index }) =>
              index > failed.index &&
              event.verificationKind === failed.event.verificationKind &&
              event.outcome === "success",
          );
          return (
            laterPass !== undefined &&
            events.some(
              (event, index) =>
                index > failed.index &&
                index < laterPass.index &&
                event.kind === "mutation" &&
                event.outcome === "success",
            )
          );
        });
      }
    }

    const deliveryEvents = events.filter((event) => event.kind === "delivery");
    let delivery: WorkflowDelivery = "unknown";
    if (deliveryEvents.some((event) => event.outcome === "success")) delivery = "observed";
    else if (deliveryEvents.some((event) => event.outcome === "unknown")) delivery = "unknown";
    else if (this.options.deliveryObservation && !this.unknownShellCall) delivery = "not-observed";

    return {
      // v2: agent-state writes (memory notes, scratchpads, harness config)
      // classify as observation instead of mutation.
      // v3: stack coverage for Django/Rails/.NET/React (manage.py, rails
      // test, binstubs, framework CLIs), `check || fallback` chains, denied
      // checks no longer count as run, and dotnet/minitest/unittest verdicts.
      // Wrappers (venv, versioned python, coverage, nx/turbo) and custom
      // test scripts (safe names + test-runner banners) classify as checks.
      // v4: versioned Cursor tools (`edit_file_v2`,
      // `run_terminal_command_v2`) classify like their stable names.
      // CLI 0.3.15 (still v4 — the server's wire schema pins ≤ 4 and no
      // scoring rule needs to tell the two apart): subagent spawns classify as
      // observation now that the claude-code adapter merges the subagent
      // transcript into the session, so a delegated check is a real check.
      classifierVersion: 4,
      codeChange,
      sequenceKnown: this.sequenceKnown,
      finalVerification,
      stalePass,
      autonomousVerifiedChange,
      recoveredFromFailure,
      failedChecks,
      delivery,
      verificationKinds,
    };
  }
}
