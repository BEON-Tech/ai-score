import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { copilotOutcome, parseSession } from "../dist/adapters/copilot-cli.js";
import { classifierName, foldChatSession } from "../dist/adapters/copilot-ide.js";
import { emptyReport } from "../dist/util.js";

const ctx = { since: new Date(0), now: new Date(), verbose: () => {} };

const at = (i) => new Date(1700000000000 + i * 1000).toISOString();
const event = (i, type, data) =>
  JSON.stringify({ type, data, id: `e${i}`, parentId: null, timestamp: at(i) });

describe("copilot-cli / copilotOutcome", () => {
  it("trusts the success flag over anything in the body", () => {
    assert.equal(copilotOutcome({ success: true, error: { message: "red herring" } }), "success");
    assert.equal(copilotOutcome({ success: false }), "failure");
  });

  it("falls back to sniffing the result when success is absent", () => {
    assert.equal(copilotOutcome({ result: { content: "exit code 1" } }), "failure");
    assert.equal(copilotOutcome({}), "unknown");
  });
});

describe("copilot-cli / parseSession", () => {
  const lines = [
    event(0, "session.start", {
      sessionId: "abc",
      copilotVersion: "1.0.79",
      selectedModel: "gpt-5",
      startTime: at(0),
      version: 1,
      producer: "cli",
      context: { cwd: "/repo", gitRoot: "/repo", branch: "main" },
    }),
    event(1, "user.message", { content: "fix the bug" }),
    event(2, "session.mode_changed", { mode: "plan" }),
    event(3, "tool.execution_start", {
      toolCallId: "t1",
      toolName: "str_replace_editor",
      arguments: { path: "a.ts" },
    }),
    event(4, "tool.execution_complete", {
      toolCallId: "t1",
      success: true,
      result: { content: "ok" },
    }),
    event(5, "tool.execution_start", {
      toolCallId: "t2",
      toolName: "shell",
      arguments: { command: "pnpm test" },
    }),
    event(6, "tool.execution_complete", {
      toolCallId: "t2",
      success: true,
      result: { content: "12 passed" },
    }),
    event(7, "tool.execution_start", {
      toolCallId: "t3",
      toolName: "github-list_issues",
      mcpServerName: "github",
      mcpToolName: "list_issues",
    }),
    event(8, "tool.execution_complete", { toolCallId: "t3", success: true }),
    event(9, "assistant.message", { content: "done", messageId: "m1" }),
    event(10, "permission.completed", {
      requestId: "p1",
      result: { kind: "denied-interactively-by-user" },
    }),
    event(11, "subagent.started", {
      agentName: "tester",
      agentDisplayName: "Tester",
      agentDescription: "",
      toolCallId: "t4",
    }),
    // machine traffic: an autopilot continuation is not the engineer typing
    event(12, "user.message", { content: "continue", isAutopilotContinuation: true }),
    event(13, "abort", { reason: "user_initiated" }),
    event(14, "session.shutdown", {
      shutdownType: "routine",
      sessionStartTime: 1700000000000,
      totalApiDurationMs: 1,
      modelMetrics: {
        "gpt-5": {
          requests: { count: 2 },
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 400,
            cacheWriteTokens: 10,
            reasoningTokens: 5,
          },
        },
      },
      codeChanges: { filesModified: ["a.ts"], linesAdded: 10, linesRemoved: 2 },
    }),
  ];

  const parse = async (text) => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-test-"));
    const sessionDir = join(dir, "session-abc");
    await mkdir(sessionDir);
    const file = join(sessionDir, "events.jsonl");
    await writeFile(file, text);
    const report = emptyReport("copilot-cli", null);
    return { session: await parseSession(file, report, ctx), report };
  };

  it("folds the event log into one session record", async () => {
    const { session: s, report } = await parse(lines.join("\n"));
    assert.equal(report.latestVersion, "1.0.79");
    assert.equal(report.parseErrors, 0);
    assert.equal(s.counts.userPrompts, 1);
    assert.equal(s.counts.assistantMessages, 1);
    assert.equal(s.counts.toolCalls, 3);
    assert.equal(s.counts.toolDenials, 1);
    assert.equal(s.counts.interruptions, 1);
    assert.equal(s.tools["mcp:list_issues"], 1);
    assert.equal(s.flags.mcpCalls, 1);
    assert.equal(s.flags.subagentRuns, 1);
    assert.deepEqual(s.flags.modes, ["plan"]);
    assert.deepEqual(s.models["gpt-5"], {
      input: 100,
      output: 50,
      cacheRead: 400,
      cacheWrite: 10,
      reasoning: 5,
    });
    assert.deepEqual(
      [
        s.outcome.filesChanged,
        s.outcome.additions,
        s.outcome.deletions,
        s.outcome.distinctGitBranches,
      ],
      [1, 10, 2, 1],
    );
    assert.equal(s.startedAt, at(0));
    assert.equal(s.endedAt, at(14));
    assert.ok(s.agentic.longestTurnMs > 0);
    assert.equal(s.agentic.maxToolCallsPerTurn, 3);
  });

  it("reads a verified, autonomously completed change out of the sequence", async () => {
    const { session: s } = await parse(lines.join("\n"));
    assert.equal(s.workflow.codeChange, "success");
    assert.equal(s.workflow.finalVerification, "passed");
    assert.equal(s.workflow.autonomousVerifiedChange, true);
    assert.deepEqual(s.workflow.verificationKinds, ["test"]);
    assert.equal(s.workflow.delivery, "not-observed");
    assert.equal(s.workflow.sequenceKnown, true);
  });

  it("drops sessions with no human conversation", async () => {
    const { session } = await parse(
      [
        event(0, "session.start", {
          sessionId: "x",
          startTime: at(0),
          version: 1,
          producer: "cli",
        }),
      ].join("\n"),
    );
    assert.equal(session, null);
  });

  it("counts a broken line as a parse error and keeps going", async () => {
    const { session, report } = await parse([lines[0], "{broken", lines[1]].join("\n"));
    assert.equal(report.parseErrors, 1);
    assert.equal(session.counts.userPrompts, 1);
    assert.equal(session.workflow.sequenceKnown, false);
  });
});

describe("copilot-ide / classifierName", () => {
  it("normalizes VS Code tool ids to the classifier's vocabulary", () => {
    assert.equal(classifierName("copilot_readFile"), "read_file");
    assert.equal(classifierName("copilot_insertEdit"), "insert_edit");
    assert.equal(classifierName("run_in_terminal"), "run_in_terminal");
  });
});

describe("copilot-ide / foldChatSession", () => {
  const session = {
    version: 3,
    sessionId: "s1",
    creationDate: 1700000000000,
    requests: [
      {
        requestId: "r1",
        message: { text: "add the feature" },
        timestamp: 1700000001000,
        modelId: "gpt-5",
        promptTokens: 120,
        completionTokens: 40,
        elapsedMs: 90_000,
        response: [
          { kind: "markdownContent", value: "On it." },
          {
            kind: "toolInvocationSerialized",
            toolId: "insert_edit_into_file",
            toolCallId: "c1",
            isConfirmed: { type: 4 },
            isComplete: true,
            invocationMessage: "editing",
            resultDetails: { input: "", output: [{ value: "done" }], isError: false },
          },
          {
            kind: "toolInvocationSerialized",
            toolId: "run_in_terminal",
            toolCallId: "c2",
            isConfirmed: { type: 4 },
            isComplete: true,
            invocationMessage: "running",
            toolSpecificData: { kind: "terminal", commandLine: { original: "pnpm test" } },
            resultDetails: { input: "", output: [{ value: "9 passed" }], isError: false },
          },
        ],
        editedFileEvents: [
          { uri: { scheme: "file", path: "/repo/a.ts" }, eventKind: 1 },
          { uri: { scheme: "file", path: "/repo/b.ts" }, eventKind: 2 },
        ],
      },
      {
        requestId: "r2",
        message: { text: "now delete prod" },
        timestamp: 1700000200000,
        modelId: "gpt-5",
        isCanceled: true,
        response: [
          {
            kind: "toolInvocationSerialized",
            toolId: "run_in_terminal",
            toolCallId: "c3",
            isConfirmed: { type: 0 },
            isComplete: false,
            invocationMessage: "running",
            toolSpecificData: { kind: "terminal", commandLine: { original: "rm -rf prod" } },
          },
        ],
      },
      {
        requestId: "r3",
        message: { text: "editor housekeeping" },
        isSystemInitiated: true,
        response: [],
      },
    ],
  };

  it("folds requests, tools, tokens and edits into a session record", () => {
    const s = foldChatSession(session, "project-1");
    assert.equal(s.projectId, "project-1");
    assert.equal(s.counts.userPrompts, 2);
    assert.equal(s.counts.assistantMessages, 1);
    assert.equal(s.counts.toolCalls, 3);
    assert.equal(s.counts.toolDenials, 1);
    assert.equal(s.counts.interruptions, 1);
    assert.equal(s.agentic.maxToolCallsPerTurn, 2);
    assert.equal(s.agentic.longestTurnMs, 90_000);
    assert.deepEqual(s.models["gpt-5"], {
      input: 120,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    // only the kept edit counts — the Undo event reverted b.ts
    assert.equal(s.outcome.filesChanged, 1);
    assert.equal(s.startedAt, new Date(1700000000000).toISOString());
    assert.equal(s.endedAt, new Date(1700000200000).toISOString());
  });

  it("treats the edit + passing test as a verified change, and the denial as not-run", () => {
    const s = foldChatSession(session, "project-1");
    assert.equal(s.workflow.codeChange, "success");
    assert.equal(s.workflow.finalVerification, "passed");
    assert.equal(s.workflow.autonomousVerifiedChange, true);
    assert.deepEqual(s.workflow.verificationKinds, ["test"]);
  });

  it("prefers per-model totals over the flat token counts when both exist", () => {
    const s = foldChatSession(
      {
        version: 3,
        sessionId: "s2",
        creationDate: 1700000000000,
        requests: [
          {
            requestId: "r1",
            message: { text: "hi" },
            timestamp: 1700000001000,
            modelId: "gpt-5",
            promptTokens: 999,
            completionTokens: 999,
            modelTotals: [
              { model: "gpt-5-mini", inputTokens: 10, cachedTokens: 7, outputTokens: 3 },
            ],
            response: [{ kind: "markdownContent", value: "hello" }],
          },
        ],
      },
      "unknown",
    );
    assert.equal(s.models["gpt-5"], undefined);
    assert.deepEqual(s.models["gpt-5-mini"], {
      input: 10,
      output: 3,
      cacheRead: 7,
      cacheWrite: 0,
      reasoning: 0,
    });
  });

  it("returns null for shapes that are not a chat session", () => {
    assert.equal(foldChatSession(null, "unknown"), null);
    assert.equal(foldChatSession({ version: 3 }, "unknown"), null);
  });
});
