import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexOutcome } from "../dist/adapters/codex.js";
import { toolOutcome, WorkflowTracker } from "../dist/workflow.js";

const tracker = () =>
  new WorkflowTracker({
    sequenceKnown: true,
    commandObservation: true,
    deliveryObservation: true,
  });

describe("workflow evidence", () => {
  it("recognises a change verified in the same human turn", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");

    assert.deepEqual(t.finish(), {
      classifierVersion: 1,
      codeChange: "success",
      sequenceKnown: true,
      finalVerification: "passed",
      autonomousVerifiedChange: true,
      recoveredFromFailure: null,
      delivery: "not-observed",
      verificationKinds: ["test"],
    });
  });

  it("invalidates a passing check when another edit follows it", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit-1", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("Edit", {}, "edit-2", "success");

    assert.equal(t.finish().finalVerification, "not-run");
  });

  it("invalidates a passing check when a later shell command cannot be classified", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("Bash", { command: "./project-specific-script" }, "custom", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("records a failed check that is repaired and rerun", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit-1", "success");
    t.toolCall("Bash", { command: "pytest" }, "test-1", "failure");
    t.toolCall("Edit", {}, "edit-2", "success");
    t.toolCall("Bash", { command: "pytest" }, "test-2", "success");

    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "passed");
    assert.equal(evidence.recoveredFromFailure, true);
  });

  it("does not let an unrelated passing check hide a failed test", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit-1", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "failure");
    t.toolCall("Edit", {}, "edit-2", "success");
    t.toolCall("Bash", { command: "pnpm lint" }, "lint", "success");
    assert.equal(t.finish().finalVerification, "failed");
  });

  it("does not let a rejected rerun erase an unresolved failed check", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit-1", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test-1", "failure");
    t.toolCall("Edit", {}, "edit-2", "success");
    t.toolCall("Bash", { command: "pnpm lint" }, "lint", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test-2", "not-run");
    assert.equal(t.finish().finalVerification, "failed");
  });

  it("orders overlapping tool calls by completion, not by call", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit");
    t.toolCall("Bash", { command: "pnpm test" }, "test");
    t.toolResult("success", "test");
    t.toolResult("success", "edit");
    // The edit finished after the check, so the check proves nothing.
    assert.equal(t.finish().finalVerification, "not-run");
    assert.equal(t.finish().sequenceKnown, true);
  });

  it("keeps parallel calls in one turn observable when results resolve in order", () => {
    const t = tracker();
    t.humanTurn();
    // One assistant message with two tool_use blocks: both calls precede both
    // results in the log. This must not read as an unorderable sequence.
    t.toolCall("Read", {}, "read");
    t.toolCall("Edit", {}, "edit");
    t.toolResult("success", "read");
    t.toolResult("success", "edit");
    t.toolCall("Bash", { command: "pnpm test" }, "test");
    t.toolResult("success", "test");
    const evidence = t.finish();
    assert.equal(evidence.sequenceKnown, true);
    assert.equal(evidence.finalVerification, "passed");
    assert.equal(evidence.autonomousVerifiedChange, true);
  });

  it("does not verify a mutation whose result is still pending", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit-1", "success");
    t.toolCall("NotebookEdit", {}, "edit-2");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("does not certify mutation-like custom tool names as code changes", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit-1", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("NotebookEdit", {}, "edit-2", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("does not classify commands merely printed by another executable", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "echo pnpm test" }, "echo", "success");
    const evidence = t.finish();
    // `echo` is a harmless observation, so the session stays observable — but
    // the printed command must never register as a verification.
    assert.equal(evidence.finalVerification, "not-run");
    assert.deepEqual(evidence.verificationKinds, []);
  });

  it("classifies && chains by their strongest classifiable segment", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "cd app && pnpm build && pnpm test" }, "chain", "success");
    const evidence = t.finish();
    // An && chain only reaches its last command when everything before it
    // succeeded, so the chain reports as its final verification segment.
    assert.equal(evidence.finalVerification, "passed");
    assert.deepEqual(evidence.verificationKinds, ["test"]);
  });

  it("keeps && chains with an opaque segment unclassified", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test && ./deploy.sh" }, "chain", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("reads a piped check's verdict from the runner summary, not the pipe's exit", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test 2>&1 | tail -8" }, "test");
    // tail exits 0 even when the tests failed; only the summary line counts.
    t.toolResult("success", "test", null, "...\n Tests  2 failed | 7 passed (9)\n...");
    assert.equal(t.finish().finalVerification, "failed");
  });

  it("treats marker-free wrapper output through tail as a pass", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm typecheck 2>&1 | tail -5" }, "check");
    t.toolResult("success", "check", null, "> ai-score@0.1.7 typecheck\n> tsc\n");
    assert.equal(t.finish().finalVerification, "passed");
  });

  it("does not trust marker-free output when head may have cut the marker", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm typecheck 2>&1 | head -5" }, "check");
    t.toolResult("success", "check", null, "> ai-score@0.1.7 typecheck\n> tsc\n");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("classifies heredoc commit chains despite quoted newlines and pipes", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall(
      "Bash",
      {
        command:
          "git add -A && git commit -m \"$(cat <<'EOF'\nfeat: a | b; c\nEOF\n)\" && git push",
      },
      "ship",
      "success",
    );
    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "passed");
    assert.equal(evidence.delivery, "observed");
  });

  it("keeps remote API tools out of the code-change boundary", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("mcp__plugin_vercel__get_runtime_logs", {}, "logs", "success");
    t.toolCall("Bash", { command: "gh api repos/o/r/pulls -f title=x" }, "api", "success");
    assert.equal(t.finish().finalVerification, "passed");
  });

  it("still treats filesystem MCP tools as potential edits", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("mcp__filesystem__write_file", {}, "fs", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("keeps redirected observation commands unclassified", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("Bash", { command: "echo done > src/marker.ts" }, "redir", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("does not count help or dry-run invocations as evidence", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "vitest --help" }, "help", "success");
    t.toolCall("Bash", { command: "gh pr create --dry-run" }, "pr", "success");
    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "unknown");
    assert.equal(evidence.delivery, "unknown");
  });

  it("does not count collection and configuration-only commands as checks", () => {
    for (const command of [
      "npm run test --if-present",
      "jest --listTests",
      "pytest --collect-only",
      "tsc --showConfig",
    ]) {
      const t = tracker();
      t.humanTurn();
      t.toolCall("Edit", {}, "edit", "success");
      t.toolCall("Bash", { command }, command, "success");
      assert.equal(t.finish().finalVerification, "unknown", command);
    }
  });

  it("keeps generic database writes out of code-change evidence", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("database_write", {}, "db", "success");
    assert.equal(t.finish().codeChange, "none");
  });

  it("does not reuse a pass from before the final edit", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit-1", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("Edit", {}, "edit-2", "success");
    t.toolCall("Bash", { command: "pnpm lint" }, "lint", "not-run");
    assert.equal(t.finish().finalVerification, "not-run");
  });

  it("does not classify external MCP edits as code mutations", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("mcp__notion__edit_page", {}, "mcp", "success");
    assert.equal(t.finish().codeChange, "none");
  });

  it("does not turn unknown ordering into a completion claim", () => {
    const t = new WorkflowTracker({ sequenceKnown: false, commandObservation: true });
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("keeps rejected and failed tool outcomes distinct", () => {
    assert.equal(toolOutcome({ status: "completed", userDecision: "rejected" }), "not-run");
    assert.equal(toolOutcome({ status: "error" }), "failure");
    assert.equal(toolOutcome({ is_error: false }), "success");
    assert.equal(toolOutcome('{"exit_code":1}'), "failure");
    assert.equal(toolOutcome({ isError: false, output: "Process exited with code 1" }), "failure");
    assert.equal(
      toolOutcome({
        isError: false,
        content: [{ type: "text", text: "Process exited with code 1" }],
      }),
      "failure",
    );
    assert.equal(toolOutcome({ status: "completed", success: false }), "failure");
    assert.equal(toolOutcome({ status: "completed", error: false }), "success");
    assert.equal(
      toolOutcome({ status: "completed", metadata: { output: "Process exited with code 2" } }),
      "failure",
    );
    assert.equal(
      toolOutcome({ state: { status: "completed" }, output: "Process exited with code 2" }),
      "failure",
    );
    assert.equal(toolOutcome("Process exited with code 0"), "success");
    assert.equal(toolOutcome("Process exited with code 2"), "failure");
  });

  it("reads codex's prose exec wrapper without keeping the output", () => {
    assert.equal(codexOutcome("Script completed\nWall time: 1.2 seconds\n..."), "success");
    assert.equal(codexOutcome([{ type: "input_text", text: "Script failed\n..." }]), "failure");
    assert.equal(codexOutcome("exec_command failed for `/bin/zsh -lc 'x'`"), "failure");
    assert.equal(codexOutcome("aborted by user after 3.1s"), "not-run");
    assert.equal(codexOutcome("Script running with cell ID 4"), "unknown");
    // Structured statuses still win over the prose wrapper.
    assert.equal(codexOutcome('{"exit_code":1}'), "failure");
  });

  it("never retains command text in the wire-safe result", () => {
    const secret = "API_KEY=do-not-upload /private/project pnpm test";
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: secret }, "shell", "success");
    assert.doesNotMatch(JSON.stringify(t.finish()), /do-not-upload|private\/project/);
  });
});
