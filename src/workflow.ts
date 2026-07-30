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
  "multiedit",
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
  "run_terminal_cmd",
  "shell",
  "terminal",
]);

const OBSERVATION_TOOLS = new Set([
  "askuserquestion",
  "exitplanmode",
  "glob",
  "grep",
  "list",
  "ls",
  "question",
  "read",
  "read_file",
  "search",
  "skill",
  "taskcreate",
  "tasklist",
  "taskoutput",
  "taskupdate",
  "todowrite",
  "toolsearch",
  "update_plan",
  // codex's wait resolves a detached script; the script's own exec event is
  // what carries the uncertainty, so waiting on it observes, not changes.
  "wait",
  "web_search",
  "webfetch",
]);

const normalizeTool = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

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

function classifyCommand(raw: string): Classified | null {
  // Separators inside quotes (`grep -E "a|b"`, heredoc commit messages) are
  // argument text, not chain structure, so quoted spans are blanked before
  // looking for separators. Classification only ever reads command prefixes
  // and flags, which never legitimately live inside quotes.
  const masked = raw.replace(/"[^"]*"|'[^']*'/g, (quoted) => quoted[0] + quoted.slice(-1));
  // A newline outside quotes chains commands exactly like `;`. Unquoted
  // heredoc bodies land here too and classify as opaque segments, which is
  // the conservative outcome.
  if (masked.includes("||")) return null;
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
    const strongest =
      parts.findLast((part) => part?.kind === "delivery") ??
      parts.findLast((part) => part?.kind === "verification");
    if (!strongest) return { kind: "observation" };
    const index = parts.lastIndexOf(strongest);
    const exitUnreliable =
      separators.slice(index).some((separator) => separator !== "&&") ||
      strongest.exitUnreliable === true;
    if (!exitUnreliable) return strongest;
    // A failure marker only survives the pipe when every filter after the
    // classifying segment keeps the end of the stream: `tail` and `cat` do,
    // `head`/`grep`/`wc` may cut or drop the very lines that carry it.
    let endPreserved = strongest.failureMarked === true;
    for (let position = index; position < separators.length && endPreserved; position++) {
      if (
        separators[position] === "|" &&
        !/^\s*(?:tail|cat)\b/.test(segments[position + 1] ?? "")
      ) {
        endPreserved = false;
      }
    }
    return { ...strongest, exitUnreliable, failureMarked: endPreserved };
  }
  const command = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z_][a-z0-9_]*=[^\s]+\s+)*/, "")
    // `pnpm exec tsc` and `npx vitest` are the same check as `tsc` and
    // `vitest`; the runner adds nothing to the classification.
    .replace(/^(?:npx|bunx|(?:pnpm|yarn)\s+(?:exec|dlx)|bun\s+x)(?:\s+-+[a-z-]+)*\s+/, "");
  if (!command) return null;
  if (
    /(?:^|\s)(?:--help|-h|--version|--dry-run|--dryrun|--if-present|--listtests|--list-tests|--collect-only|--fixtures|--showconfig|--show-config|--no-run|-co|-list)(?:\s|$)/.test(
      command,
    ) ||
    /^(?:npx\s+)?vitest\s+list(?:\s|$)/.test(command)
  ) {
    return null;
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
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:test|vitest|jest)(?::[a-z0-9:_-]+)?(?:\s|$)/.test(
      command,
    ) ||
    /^(?:(?:npx|pnpm|yarn|bun)\s+(?:exec\s+)?)?(?:vitest|jest|pytest|phpunit|rspec)(?:\s|$)/.test(
      command,
    ) ||
    /^python(?:3)?\s+-m\s+pytest(?:\s|$)/.test(command) ||
    /^(?:go|cargo|dotnet)\s+test(?:\s|$)/.test(command) ||
    /^(?:mvn|mvnw)(?:\s+[^\s]+)*\s+test(?:\s|$)/.test(command) ||
    /^(?:gradle|gradlew)(?:\s+[^\s]+)*\s+test(?:\s|$)/.test(command) ||
    /^node\s+--test(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "test",
      failureMarked: /^(?:pnpm|npm|yarn)(?:\s+run)?\s/.test(command),
    };
  }
  if (
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:typecheck|type-check|check-types)(?::[a-z0-9:_-]+)?(?:\s|$)/.test(
      command,
    ) ||
    /^(?:npx\s+)?tsc(?:\s|$)/.test(command) ||
    /^(?:mypy|pyright|go\s+vet)(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "typecheck",
      failureMarked: /^(?:pnpm|npm|yarn)(?:\s+run)?\s|^(?:npx\s+)?tsc(?:\s|$)/.test(command),
    };
  }
  if (
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+build(?::[a-z0-9:_-]+)?(?:\s|$)/.test(command) ||
    /^(?:go|cargo|dotnet)\s+build(?:\s|$)/.test(command) ||
    /^(?:mvn|mvnw)(?:\s+[^\s]+)*\s+(?:package|verify)(?:\s|$)/.test(command) ||
    /^(?:gradle|gradlew)(?:\s+[^\s]+)*\s+build(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "build",
      failureMarked: /^(?:pnpm|npm|yarn)(?:\s+run)?\s/.test(command),
    };
  }
  if (
    // plain `fmt`/`format` rewrites files; only the check variants verify.
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:lint(?::[a-z0-9:_-]+)?|(?:fmt|format):check)(?:\s|$)/.test(
      command,
    ) ||
    /^(?:npx\s+)?(?:eslint|oxlint)(?:\s|$)/.test(command) ||
    /^(?:ruff\s+check|biome\s+check|cargo\s+clippy|golangci-lint)(?:\s|$)/.test(command)
  ) {
    return {
      kind: "verification",
      verificationKind: "lint",
      failureMarked: /^(?:pnpm|npm|yarn)(?:\s+run)?\s/.test(command),
    };
  }
  // `>` can turn even `echo` into a file write, so redirects stay unclassified.
  if (!command.includes(">")) {
    if (
      /^(?:pwd|ls|cd|echo|cat|head|tail|which|sleep|true|nl|wc|jq|tree|date|rg|grep|diff|sort|uniq|cut|tr|column|basename|dirname|stat|du|file)(?:\s|$)/.test(
        command,
      ) ||
      /^git\s+(?:status|diff|log|show|rev-parse|rev-list|branch|remote|fetch|blame|ls-files|ls-remote|describe|shortlog|grep|add)(?:\s|$)/.test(
        command,
      ) ||
      // Remote gh calls change GitHub, never this working tree. `pr checkout`
      // and `repo clone` are the tree-touching exceptions and stay out.
      /^gh\s+(?:api|auth\s+status|repo\s+view|pr\s+(?!checkout\b)[a-z-]+|issue\s+[a-z-]+|run\s+(?:view|list|watch|rerun|cancel)|release\s+(?:view|list)|workflow\s+[a-z-]+)(?:\s|$)/.test(
        command,
      ) ||
      /^(?:npm|pnpm|yarn)\s+(?:view|info|why|ls|list|outdated)(?:\s|$)/.test(command) ||
      // A bare install syncs node_modules to the lockfile; naming packages
      // would rewrite package.json, so any non-flag argument disqualifies.
      /^(?:pnpm|npm|yarn|bun)\s+(?:install|i)(?:\s+-+[a-z-]+)*$/.test(command) ||
      /^ctx7(?:@[^\s]*)?(?:\s|$)/.test(command)
    ) {
      return { kind: "observation" };
    }
    // sed only reads with -n and no in-place flag; find only reads until
    // -delete or -exec appears.
    if (/^sed\s+-n(?:\s|$)/.test(command) && !/\s-i\b|--in-place/.test(command)) {
      return { kind: "observation" };
    }
    if (/^find(?:\s|$)/.test(command) && !/\s-(?:delete|exec|execdir|ok|okdir)\b/.test(command)) {
      return { kind: "observation" };
    }
  }
  return null;
}

function classifyTool(name: string, input: unknown): Classified | null {
  const normalized = normalizeTool(name);
  if (MUTATION_TOOLS.has(normalized)) return { kind: "mutation" };
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
    /✖ \d+ problems?\b/.test(tail) // eslint
  ) {
    return "failure";
  }
  if (
    /\b(?!0+\b)\d+\s+pass(?:ed|ing)?\b/i.test(tail) || // "9 passed"
    /\bpass\s+(?!0+\b)\d+\b/i.test(tail) || // node --test "pass 97"
    /\btest result: ok\b/.test(tail) || // cargo
    /^ok\s+\S+/m.test(tail) // go test
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
  private turn = -1;
  private unknownShellCall = false;
  private sessionChanged = false;
  private sequenceKnown: boolean;

  constructor(private readonly options: TrackerOptions) {
    this.sequenceKnown = options.sequenceKnown;
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
    let classified = classifyTool(name, input);
    if (!classified) {
      if (SHELL_TOOLS.has(normalized)) {
        this.unknownShellCall = true;
        classified = { kind: "unknown-shell" };
      } else if (OBSERVATION_TOOLS.has(normalized)) classified = { kind: "observation" };
      else classified = { kind: "unknown-tool" };
    }
    const event: WorkflowEvent = {
      ...classified,
      outcome: "unknown",
      turn: this.turn >= 0 ? this.turn : null,
      name: normalized,
    };
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
        (candidate) => candidate.name === normalized && candidate.outcome === "unknown",
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
    let autonomousVerifiedChange: boolean | null = null;
    let recoveredFromFailure: boolean | null = null;
    const verificationKinds = [
      ...new Set(
        events
          .filter((event) => event.kind === "verification")
          .map((event) => event.verificationKind)
          .filter((kind): kind is VerificationKind => kind !== undefined),
      ),
    ].sort();

    const lastSuccessfulMutation = events.findLastIndex(
      (event) => event.kind === "mutation" && event.outcome === "success",
    );
    const lastUncertainChange = events.findLastIndex(
      (event) =>
        (event.kind === "mutation" && event.outcome === "unknown") ||
        event.kind === "unknown-shell" ||
        event.kind === "unknown-tool",
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

      const failedChecks = allChecks.filter(({ event }) => event.outcome === "failure");
      if (failedChecks.length > 0) {
        recoveredFromFailure = failedChecks.some((failed) => {
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
      classifierVersion: 1,
      codeChange,
      sequenceKnown: this.sequenceKnown,
      finalVerification,
      autonomousVerifiedChange,
      recoveredFromFailure,
      delivery,
      verificationKinds,
    };
  }
}
