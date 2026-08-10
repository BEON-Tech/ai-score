import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  codexDetachedIdFromInput,
  codexDetachedIdFromOutput,
  codexOutcome,
} from "../dist/adapters/codex.js";
import { toolOutcome, verificationVerdict, WorkflowTracker } from "../dist/workflow.js";

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
      classifierVersion: 2,
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

  it("does not let an agent memory note invalidate a passing check", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall(
      "Write",
      { file_path: `${homedir()}/.claude/projects/x/memory/note.md` },
      "memory",
      "success",
    );
    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "passed");
    assert.equal(evidence.autonomousVerifiedChange, true);
  });

  it("does not count sessions that only write agent state as coding", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall(
      "Write",
      { file_path: `${homedir()}/.claude/projects/x/memory/MEMORY.md` },
      "memory",
      "success",
    );
    t.toolCall(
      "Write",
      { file_path: `${tmpdir()}/claude-501/scratchpad/plan.md` },
      "scratch",
      "success",
    );
    assert.equal(t.finish().codeChange, "none");
  });

  it("keeps writes inside a dot-directory project as mutations", () => {
    const t = tracker();
    t.projectDir(`${homedir()}/.config/nvim`);
    t.humanTurn();
    t.toolCall("Write", { file_path: `${homedir()}/.config/nvim/init.lua` }, "edit", "success");
    assert.equal(t.finish().codeChange, "success");
  });

  it("keeps mutations with relative targets conservative", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall("Write", { file_path: "memory/note.md" }, "note", "success");
    assert.equal(t.finish().finalVerification, "not-run");
  });

  it("classifies apply_patch by the files its patch touches", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall(
      "apply_patch",
      {
        input: `*** Begin Patch\n*** Update File: ${homedir()}/.codex/notes.md\n*** End Patch`,
      },
      "patch",
      "success",
    );
    assert.equal(t.finish().finalVerification, "passed");
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

  it("classifies stdin-heredoc commits as delivery, not opaque changes", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall(
      "Bash",
      {
        command: "git add -A && git commit -F - <<'EOF'\nfeat: a | b; c\n\nbody text\nEOF",
      },
      "ship",
      "success",
    );
    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "passed");
    assert.equal(evidence.delivery, "observed");
  });

  it("certifies checks gated ahead of an unpiped ship chain", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall(
      "Bash",
      { command: 'pnpm test && git add -A && git commit -m "x" && git push' },
      "ship",
      "success",
    );
    const evidence = t.finish();
    // The && chain only reaches the push when the tests exited 0.
    assert.equal(evidence.finalVerification, "passed");
    assert.equal(evidence.autonomousVerifiedChange, true);
    assert.equal(evidence.delivery, "observed");
    assert.deepEqual(evidence.verificationKinds, ["test"]);
  });

  it("certifies piped checks in a ship chain only when every check is markable", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall(
      "Bash",
      {
        command:
          'pnpm typecheck 2>&1 | tail -3 && pnpm test 2>&1 | tail -8 && git commit -am "x" && git push',
      },
      "ship",
    );
    // Both checks are pnpm-run scripts (marker on failure) and both pipes
    // keep the end of the stream, so marker-free output is a pass.
    t.toolResult("success", "ship", null, "> tsc\n> vitest run\n[main abc123] x\n");
    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "passed");
    assert.equal(evidence.delivery, "observed");
  });

  it("does not certify a ship chain whose checks cannot prove their verdict", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall(
      "Bash",
      {
        // oxlint runs bare (no runner failure marker) and its pipe would let
        // the chain ship even when it failed, so its silence proves nothing.
        command:
          'pnpm typecheck 2>&1 | tail -3 && pnpm exec oxlint src 2>&1 | tail -2 && git commit -am "x" && git push',
      },
      "ship",
    );
    t.toolResult("success", "ship", null, "> tsc\nclean\n[main abc123] x\n");
    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "unknown");
    assert.equal(evidence.delivery, "observed");
  });

  it("keeps unquoted heredocs with expansions opaque", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall(
      "Bash",
      { command: "git commit -F - <<EOF\nrelease $(date)\nEOF" },
      "ship",
      "success",
    );
    assert.equal(t.finish().finalVerification, "unknown");
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

  it("keeps read-only shell wrappers after a passing check observable", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test" }, "test", "success");
    t.toolCall(
      "Bash",
      { command: 'git -C "/private/repo" status 2>/dev/null' },
      "status",
      "success",
    );
    t.toolCall("Bash", { command: "git checkout -b feature" }, "branch", "success");
    t.toolCall("Bash", { command: "pnpm --version >/dev/null" }, "version", "success");
    t.toolCall(
      "Bash",
      { command: "git rev-parse @{upstream} 2>/dev/null || echo none" },
      "fallback",
      "success",
    );
    t.toolCall("SendMessage", {}, "message", "success");
    assert.equal(t.finish().finalVerification, "passed");
  });

  it("recognises checks across ecosystems, not just the JS toolchain", () => {
    for (const command of [
      "bundle exec rspec",
      "uv run pytest -q",
      "poetry run pytest",
      "python -m unittest discover",
      "mix test",
      "rake test",
      "deno test",
      "dart test",
      "flutter test",
      "swift test",
      "zig build test",
      "make check",
      "ctest --output-on-failure",
      "./gradlew test",
      "./mvnw test",
      "vendor/bin/phpunit",
      "php artisan test",
      "cargo check",
      "phpstan analyse",
      "dart analyze",
      "mix compile",
      "swift build",
      "make",
      "./gradlew build",
      "rubocop",
      "flake8 src",
      "black --check .",
      "prettier --check src",
      "cargo fmt --check",
      "deno lint",
      "mix format --check-formatted",
      "terraform validate",
    ]) {
      const t = tracker();
      t.humanTurn();
      t.toolCall("Edit", {}, "edit", "success");
      t.toolCall("Bash", { command }, command, "success");
      assert.equal(t.finish().finalVerification, "passed", command);
    }
  });

  it("reads cross-ecosystem runner summaries as verdicts", () => {
    assert.equal(verificationVerdict("[INFO] BUILD SUCCESS\n[INFO] Total time: 3s"), "success");
    assert.equal(verificationVerdict("BUILD SUCCESSFUL in 2s"), "success");
    assert.equal(verificationVerdict("[ERROR] BUILD FAILURE"), "failure");
    assert.equal(verificationVerdict("make: *** [test] Error 2"), "failure");
    assert.equal(verificationVerdict("10 examples, 0 failures"), "success");
    assert.equal(verificationVerdict("4 tests, 0 failures"), "success");
    assert.equal(verificationVerdict("10 examples, 2 failures"), "failure");
    assert.equal(verificationVerdict("All checks passed!"), "success");
  });

  it("reads oxlint and oxfmt summaries as check verdicts", () => {
    assert.equal(verificationVerdict("Found 0 warnings and 0 errors."), "success");
    assert.equal(verificationVerdict("Found 3 warnings and 0 errors."), "success");
    assert.equal(verificationVerdict("Found 1 warning and 2 errors."), "failure");
    assert.equal(
      verificationVerdict("Checking formatting...\n\nAll matched files use the correct format."),
      "success",
    );

    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "npx oxlint src 2>&1 | tail -5" }, "lint");
    t.toolResult("success", "lint", null, "Found 0 warnings and 0 errors.");
    assert.equal(t.finish().finalVerification, "passed");
  });

  it("does not let an or-fallback turn a failed check into evidence", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "pnpm test || true" }, "test", "success");
    assert.equal(t.finish().finalVerification, "unknown");
  });

  it("does not count help or dry-run invocations as evidence", () => {
    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("Bash", { command: "vitest --help" }, "help", "success");
    t.toolCall("Bash", { command: "gh pr create --dry-run" }, "pr", "success");
    const evidence = t.finish();
    assert.equal(evidence.finalVerification, "not-run");
    assert.equal(evidence.delivery, "not-observed");
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
      assert.equal(t.finish().finalVerification, "not-run", command);
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

  it("settles a detached codex check from its polling result", () => {
    assert.equal(codexDetachedIdFromOutput("Process running with session ID 89726"), "89726");
    assert.equal(codexDetachedIdFromOutput("Script running with cell ID 4"), "4");
    assert.equal(codexDetachedIdFromInput('{"session_id":89726}'), "89726");
    assert.equal(codexDetachedIdFromInput({ cellId: "4" }), "4");

    const t = tracker();
    t.humanTurn();
    t.toolCall("Edit", {}, "edit", "success");
    t.toolCall("exec_command", { cmd: "pnpm test" }, "exec");
    t.toolResult("unknown", "exec");
    t.toolCall("write_stdin", { session_id: 89726 }, "poll");
    t.toolResult("success", "poll");
    t.toolResult("success", "exec");

    assert.equal(t.finish().finalVerification, "passed");
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
