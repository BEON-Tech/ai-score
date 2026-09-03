import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { claudeCode, parseSession } from "../dist/adapters/claude-code.js";
import { emptyReport } from "../dist/util.js";

const ctx = { since: new Date(0), now: new Date(), verbose: () => {} };

const at = (i) => new Date(1700000000000 + i * 1000).toISOString();
const record = (i, fields) => JSON.stringify({ timestamp: at(i), ...fields });
const user = (i, text) =>
  record(i, { type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (i, usage) =>
  record(i, {
    type: "assistant",
    requestId: `req${i}`,
    message: { role: "assistant", model: "claude-fable-5", usage, content: [] },
  });
const toolUse = (i, id, name, input, extra = {}) =>
  record(i, {
    type: "assistant",
    requestId: `req${i}`,
    ...extra,
    message: {
      role: "assistant",
      model: "claude-fable-5",
      usage: { input_tokens: 1 },
      content: [{ type: "tool_use", id, name, input }],
    },
  });
const toolResult = (i, id, content, extra = {}, block = {}) =>
  record(i, {
    type: "user",
    ...extra,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, ...block }],
    },
  });

// Writes `session.jsonl` plus, optionally, `native-id/subagents/agent-*.jsonl`
// beside it — the on-disk layout Claude Code uses for subagent transcripts.
const parse = async (lines, subagents = []) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-code-test-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, lines.join("\n"));
  for (const [index, subLines] of subagents.entries()) {
    const subDir = join(dir, "native-id", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, `agent-${index}.jsonl`), subLines.join("\n"));
  }
  const report = emptyReport("claude-code", null);
  return { session: await parseSession(file, "project-slug", "native-id", report, ctx), report };
};

describe("claude-code / parseSession subagent transcripts", () => {
  it("merges a subagent's checks into the session that delegated them", async () => {
    const side = { isSidechain: true };
    const { session: s } = await parse(
      [
        user(0, "fix the parser and make sure the tests pass"),
        toolUse(1, "e1", "Edit", {
          file_path: "/repo/src/parser.ts",
          old_string: "a",
          new_string: "b",
        }),
        toolResult(2, "e1", "ok"),
        toolUse(3, "a1", "Agent", { prompt: "run the test suite" }),
        // Subagent records arrive between the spawn and its result.
        toolResult(8, "a1", "All 12 tests passed."),
      ],
      [
        [
          record(4, {
            ...side,
            type: "user",
            message: { role: "user", content: "run the test suite" },
          }),
          toolUse(5, "b1", "Bash", { command: "pnpm test" }, side),
          toolResult(6, "b1", "Tests 12 passed (12)", side),
          record(7, {
            ...side,
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "All 12 tests passed." }],
            },
          }),
        ],
      ],
    );
    // The subagent's prompt is not a human prompt; its tool calls are the session's.
    assert.equal(s.counts.userPrompts, 1);
    assert.equal(s.counts.toolCalls, 3);
    assert.equal(s.tools.Bash, 1);
    assert.equal(s.flags.subagentRuns, 1);
    assert.equal(s.flags.sidechainMessages, 4);
    assert.deepEqual(s.workflow.verificationKinds, ["test"]);
    // Without the merge this read as `not-run`: an edit, then an opaque Agent call.
    assert.equal(s.workflow.finalVerification, "passed");
  });

  it("counts error-marked results, denials included", async () => {
    const { session: s } = await parse([
      user(0, "try it"),
      toolUse(1, "b1", "Bash", { command: "pnpm test" }),
      toolResult(2, "b1", "ELIFECYCLE Command failed", {}, { is_error: true }),
      toolUse(3, "b2", "Bash", { command: "ls" }),
      toolResult(4, "b2", "src"),
    ]);
    assert.equal(s.counts.toolErrors, 1);
  });
});

describe("claude-code / collect roots", () => {
  it("reads the desktop app's sandboxed .claude/projects trees beside ~/.claude", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "claude-code-home-"));
    const cliProject = join(fakeHome, ".claude", "projects", "-repo");
    const sandboxProject = join(
      fakeHome,
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions",
      "account-uuid",
      "workspace-uuid",
      "local_sandbox-uuid",
      ".claude",
      "projects",
      "-sessions-magical-kind-davinci",
    );
    await mkdir(cliProject, { recursive: true });
    await mkdir(sandboxProject, { recursive: true });
    const lines = [user(0, "hello there"), assistant(1, { input_tokens: 5 })].join("\n");
    await writeFile(join(cliProject, "s1.jsonl"), lines);
    await writeFile(join(sandboxProject, "s2.jsonl"), lines);
    await writeFile(
      join(sandboxProject, "s3.jsonl"),
      [
        user(0, "newer build"),
        record(1, {
          type: "assistant",
          version: "2.1.234",
          message: { role: "assistant", content: [] },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(cliProject, "s4.jsonl"),
      [
        record(0, {
          type: "assistant",
          version: "2.1.173",
          message: { role: "assistant", content: [] },
        }),
      ].join("\n"),
    );
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const report = await claudeCode.collect(ctx);
      assert.equal(report.detected, true);
      assert.equal(report.sessionsScanned, 4);
      // s4 has no prompt and no usage, so it is scanned but not included.
      assert.equal(report.sessionsIncluded, 3);
      // Newest version seen anywhere, not the last file read.
      assert.equal(report.latestVersion, "2.1.234");
    } finally {
      process.env.HOME = previousHome;
    }
  });
});

describe("claude-code / parseSession prompt gauge", () => {
  it("counts words per prompt and re-sent prompts, ignoring tool results and interrupts", async () => {
    const { session: s } = await parse([
      user(0, "please refactor the parser module to handle unicode"),
      assistant(1, { input_tokens: 10 }),
      // A tool result carries the same words back; it is not a prompt.
      record(2, {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "please refactor the parser module to handle unicode",
            },
          ],
        },
      }),
      user(3, "please refactor the parser module to handle unicode properly"),
      user(4, "[Request interrupted by user]"),
      user(5, "ok"),
    ]);
    assert.equal(s.counts.userPrompts, 3);
    assert.equal(s.counts.describedPrompts, 3);
    assert.equal(s.counts.promptWords, 8 + 9 + 1);
    assert.equal(s.counts.repromptedPrompts, 1);
  });

  it("counts a slash command as a prompt but not as a description", async () => {
    const { session: s } = await parse([
      user(
        0,
        "<command-message>ticket is running…</command-message>\n<command-name>/ticket</command-name>\n<command-args>JIRA-123</command-args>",
      ),
      assistant(1, { input_tokens: 10 }),
      user(2, "now also update the release notes"),
      assistant(3, { input_tokens: 10 }),
    ]);
    assert.equal(s.counts.userPrompts, 2);
    assert.equal(s.counts.describedPrompts, 1);
    assert.equal(s.counts.promptWords, 6);
    assert.equal(s.flags.slashCommands, 1);
  });
});

describe("claude-code / parseSession context hygiene", () => {
  it("splits compactions by trigger and keeps triggerless ones in the total", async () => {
    const { session: s, report } = await parse([
      user(0, "do the thing"),
      assistant(1, {
        input_tokens: 100,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 900,
      }),
      record(2, {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 160_000 },
      }),
      assistant(3, {
        input_tokens: 200,
        cache_read_input_tokens: 110_000,
        cache_creation_input_tokens: 1_000,
      }),
      record(4, {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual" },
      }),
      // Older Claude Code versions write the boundary without metadata.
      record(5, { type: "system", subtype: "compact_boundary" }),
    ]);
    assert.equal(report.parseErrors, 0);
    assert.equal(s.flags.compactions, 3);
    assert.equal(s.flags.autoCompactions, 1);
    assert.equal(s.flags.manualCompactions, 1);
    // Peak context = the larger request's input + cacheRead + cacheWrite.
    assert.equal(s.flags.peakContextTokens, 200 + 110_000 + 1_000);
  });

  it("emits zero split counters but omits the peak when nothing was recorded", async () => {
    const { session: s } = await parse([user(0, "just chatting")]);
    assert.equal(s.flags.compactions, 0);
    assert.equal(s.flags.autoCompactions, 0);
    assert.equal(s.flags.manualCompactions, 0);
    // Flag absence means "not measured" to the server, never zero.
    assert.equal("peakContextTokens" in s.flags, false);
  });
});
