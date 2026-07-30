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
  "glob",
  "grep",
  "list",
  "ls",
  "question",
  "read",
  "read_file",
  "search",
  "skill",
  "todowrite",
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

function classifyCommand(
  raw: string,
): { kind: EventKind; verificationKind?: VerificationKind } | null {
  const command = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z_][a-z0-9_]*=[^\s]+\s+)*/, "");
  if (!command || /[\n\r;|]/.test(command) || command.includes("&&")) return null;
  if (
    /(?:^|\s)(?:--help|-h|--version|--dry-run|--dryrun|--if-present|--listtests|--list-tests|--collect-only|--fixtures|--showconfig|--show-config|--no-run|-co|-list)(?:\s|$)/.test(
      command,
    ) ||
    /^(?:npx\s+)?vitest\s+list(?:\s|$)/.test(command)
  ) {
    return null;
  }

  if (
    (/^git\s+commit(?:\s|$)/.test(command) &&
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
    return { kind: "verification", verificationKind: "test" };
  }
  if (
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:typecheck|type-check|check-types)(?::[a-z0-9:_-]+)?(?:\s|$)/.test(
      command,
    ) ||
    /^(?:npx\s+)?tsc(?:\s|$)/.test(command) ||
    /^(?:mypy|pyright|go\s+vet)(?:\s|$)/.test(command)
  ) {
    return { kind: "verification", verificationKind: "typecheck" };
  }
  if (
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+build(?::[a-z0-9:_-]+)?(?:\s|$)/.test(command) ||
    /^(?:go|cargo|dotnet)\s+build(?:\s|$)/.test(command) ||
    /^(?:mvn|mvnw)(?:\s+[^\s]+)*\s+(?:package|verify)(?:\s|$)/.test(command) ||
    /^(?:gradle|gradlew)(?:\s+[^\s]+)*\s+build(?:\s|$)/.test(command)
  ) {
    return { kind: "verification", verificationKind: "build" };
  }
  if (
    /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+lint(?::[a-z0-9:_-]+)?(?:\s|$)/.test(command) ||
    /^(?:npx\s+)?(?:eslint|oxlint)(?:\s|$)/.test(command) ||
    /^(?:ruff\s+check|biome\s+check|cargo\s+clippy|golangci-lint)(?:\s|$)/.test(command)
  ) {
    return { kind: "verification", verificationKind: "lint" };
  }
  if (
    /^(?:pwd|ls)(?:\s|$)/.test(command) ||
    /^git\s+(?:status|diff|log|show|rev-parse)(?:\s|$)/.test(command)
  ) {
    return { kind: "observation" };
  }
  return null;
}

function classifyTool(
  name: string,
  input: unknown,
): { kind: EventKind; verificationKind?: VerificationKind } | null {
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
  if (!SHELL_TOOLS.has(normalized)) return null;
  const command = commandFromInput(input);
  return command ? classifyCommand(command) : null;
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
  for (const key of ["exitCode", "exit_code", "code"]) {
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
    if (
      classified.kind !== "observation" &&
      this.events.some((event) => event.kind !== "observation" && event.outcome === "unknown")
    ) {
      this.sequenceKnown = false;
    }
    const event: WorkflowEvent = {
      ...classified,
      outcome,
      turn: this.turn >= 0 ? this.turn : null,
      name: normalized,
    };
    this.events.push(event);
    if (id) this.callIds.set(id, event);
  }

  toolResult(outcome: ToolOutcome, id?: string | null, name?: string | null): void {
    let event = id ? this.callIds.get(id) : undefined;
    if (!event && name) {
      const normalized = normalizeTool(name);
      const candidates = this.events.filter(
        (candidate) => candidate.name === normalized && candidate.outcome === "unknown",
      );
      if (candidates.length === 1) event = candidates[0];
    }
    if (event) {
      event.outcome = outcome;
      const index = this.events.indexOf(event);
      if (index >= 0) {
        this.events.splice(index, 1);
        this.events.push(event);
      }
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
    const mutations = this.events.filter((event) => event.kind === "mutation");
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
        this.events
          .filter((event) => event.kind === "verification")
          .map((event) => event.verificationKind)
          .filter((kind): kind is VerificationKind => kind !== undefined),
      ),
    ].sort();

    const lastSuccessfulMutation = this.events.findLastIndex(
      (event) => event.kind === "mutation" && event.outcome === "success",
    );
    const lastUncertainChange = this.events.findLastIndex(
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
      const firstSuccessfulMutation = this.events.findIndex(
        (event) => event.kind === "mutation" && event.outcome === "success",
      );
      const allChecks = this.events
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
        const change = this.events[lastChangeBoundary];
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
            this.events.some(
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

    const deliveryEvents = this.events.filter((event) => event.kind === "delivery");
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
