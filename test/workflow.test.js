import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

  it("marks overlapping relevant tool calls as unorderable", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit");
    t.toolCall("Bash", { command: "pnpm test" }, "test");
    t.toolResult("success", "test");
    t.toolResult("success", "edit");
    assert.equal(t.finish().finalVerification, "unknown");
    assert.equal(t.finish().sequenceKnown, false);
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
    assert.equal(evidence.finalVerification, "unknown");
    assert.deepEqual(evidence.verificationKinds, []);
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

  it("never retains command text in the wire-safe result", () => {
    const secret = "API_KEY=do-not-upload /private/project pnpm test";
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: secret }, "shell", "success");
    assert.doesNotMatch(JSON.stringify(t.finish()), /do-not-upload|private\/project/);
  });
});
