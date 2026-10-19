import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asMessage, foldMessages, messageOrder, parseMeta } from "../dist/adapters/cursor-cli.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composerPaths,
  foldComposer,
  gitRootFinder,
  projectsByComposer,
  repoFromPaths,
  workspacePath,
} from "../dist/adapters/cursor-ide.js";
import { databaseSync } from "../dist/util.js";
import { newSessionRecord } from "../dist/util.js";

const utf8 = (s) => new TextEncoder().encode(s);

/** A root blob: `0x0a 0x20 <32-byte digest>` per message, then whatever else. */
const rootBlob = (digests, tail = []) =>
  Uint8Array.from([...digests.flatMap((d) => [0x0a, 0x20, ...Buffer.from(d, "hex")]), ...tail]);

const digest = (byte) => Buffer.alloc(32, byte).toString("hex");

describe("cursor-cli / parseMeta", () => {
  const meta = { agentId: "a1", latestRootBlobId: "ff", mode: "default", lastUsedModel: "gpt-5" };

  it("decodes the hex-encoded JSON the store writes today", () => {
    const hex = Buffer.from(JSON.stringify(meta), "utf8").toString("hex");
    assert.deepEqual(parseMeta(hex), meta);
  });

  it("accepts plain JSON and raw bytes as well", () => {
    assert.deepEqual(parseMeta(JSON.stringify(meta)), meta);
    assert.deepEqual(parseMeta(utf8(JSON.stringify(meta))), meta);
  });

  it("returns null rather than throwing on anything else", () => {
    assert.equal(parseMeta("not json"), null);
    assert.equal(parseMeta("deadbeef"), null);
    assert.equal(parseMeta(null), null);
    assert.equal(parseMeta(42), null);
  });
});

describe("cursor-cli / messageOrder", () => {
  it("reads the run of 32-byte references off the front of the root", () => {
    const ids = [digest(1), digest(2), digest(3)];
    assert.deepEqual(messageOrder(rootBlob(ids)), ids);
  });

  it("stops at the first field that is not a reference", () => {
    // 0x12 opens field 2 — everything from there on belongs to the event log.
    const ids = [digest(1), digest(2)];
    assert.deepEqual(messageOrder(rootBlob(ids, [0x12, 0x20, ...Buffer.alloc(32, 9)])), ids);
  });

  it("yields nothing for a missing or truncated root", () => {
    assert.deepEqual(messageOrder(null), []);
    assert.deepEqual(messageOrder(undefined), []);
    assert.deepEqual(messageOrder(Uint8Array.from([0x0a, 0x20, 1, 2, 3])), []);
  });
});

describe("cursor-cli / asMessage", () => {
  it("recognises a JSON message and rejects protobuf blobs", () => {
    assert.deepEqual(asMessage(utf8('{"role":"user","content":[]}')), {
      role: "user",
      content: [],
    });
    assert.equal(asMessage(Uint8Array.from([0x0a, 0x20, 0x00])), null);
    assert.equal(asMessage(utf8('{"no":"role"}')), null);
    assert.equal(asMessage(utf8("{broken")), null);
    assert.equal(asMessage(new Uint8Array()), null);
  });
});

describe("cursor-cli / foldMessages", () => {
  const conversation = [
    { role: "system", content: "you are…" },
    { role: "user", content: [{ type: "text", text: "fix it" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "…" },
        { type: "tool-call", toolName: "Grep" },
        { type: "tool-call", toolName: "Read" },
      ],
    },
    { role: "tool", content: [{ type: "tool-result", toolName: "Grep" }] },
    { role: "assistant", content: [{ type: "tool-call", toolName: "Read" }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];

  it("counts prompts, replies and tools without double-counting results", () => {
    const s = newSessionRecord("id", "project");
    const { reasoning } = foldMessages(conversation, s);
    assert.equal(s.counts.userPrompts, 2);
    assert.equal(s.counts.assistantMessages, 3);
    assert.equal(s.counts.toolCalls, 3);
    assert.deepEqual(s.tools, { Grep: 1, Read: 2 });
    assert.equal(reasoning, 1);
  });

  it("segments turns at the user message, including the last one", () => {
    const s = newSessionRecord("id", "project");
    foldMessages(conversation, s);
    assert.equal(s.agentic.turns, 2);
    // Three tool calls in the first turn, none in the second.
    assert.equal(s.agentic.maxToolCallsPerTurn, 3);
  });

  it("names a tool call that arrives without one", () => {
    const s = newSessionRecord("id", "project");
    foldMessages([{ role: "assistant", content: [{ type: "tool-call" }] }], s);
    assert.deepEqual(s.tools, { unknown: 1 });
  });

  it("derives verified workflow evidence without retaining tool arguments", () => {
    const s = newSessionRecord("id", "project");
    foldMessages(
      [
        { role: "user", content: [{ type: "text", text: "fix it" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolName: "Edit", toolCallId: "e1", input: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolName: "Edit", toolCallId: "e1", isError: false }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "Bash",
              toolCallId: "t1",
              input: { command: "pnpm test" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "Bash",
              toolCallId: "t1",
              output: "Process exited with code 0",
            },
          ],
        },
      ],
      s,
    );

    assert.equal(s.workflow.codeChange, "success");
    assert.equal(s.workflow.finalVerification, "passed");
    assert.equal(s.workflow.autonomousVerifiedChange, true);
  });
});

describe("cursor-ide / workspacePath", () => {
  it("reduces a local folder URI to its path, so projects hash consistently", () => {
    assert.equal(workspacePath("file:///Users/dev/src/api"), "/Users/dev/src/api");
    assert.equal(workspacePath("file:///Users/dev/my%20app"), "/Users/dev/my app");
  });

  it("leaves anything without a local path as written", () => {
    const remote = "vscode-remote://background-composer%2Bbc-1/workspace";
    assert.equal(workspacePath(remote), remote);
    assert.equal(workspacePath("/plain/path"), "/plain/path");
  });
});

describe("cursor-ide / locating a chat's repository from its file paths", () => {
  // Two repositories and a stray folder, on a real disk: the walk up to `.git`
  // is the thing under test.
  const root = mkdtempSync(join(tmpdir(), "ai-score-cursor-"));
  const app = join(root, "app");
  const lib = join(root, "lib");
  mkdirSync(join(app, ".git"), { recursive: true });
  mkdirSync(join(app, "src", "deep"), { recursive: true });
  mkdirSync(lib, { recursive: true });
  // A worktree leaves `.git` as a file, not a directory.
  writeFileSync(join(lib, ".git"), "gitdir: elsewhere\n");
  mkdirSync(join(root, "scratch"), { recursive: true });
  const file = (...parts) => join(...parts);

  it("reads absolute paths from tool params, string-encoded params and file URIs", () => {
    const composer = {
      originalFileStates: { [`file://${file(app, "src", "a.ts")}`]: {} },
      codeBlockData: {},
    };
    const bubbles = [
      { toolFormerData: { name: "edit_file", params: { target_file: file(app, "src", "b.ts") } } },
      {
        toolFormerData: {
          name: "read_file",
          params: JSON.stringify({
            relativeWorkspacePath: "src/c.ts",
            path: file(app, "README.md"),
          }),
        },
      },
      { text: "no tool here" },
    ];
    assert.deepEqual(composerPaths(composer, bubbles).sort(), [
      file(app, "README.md"),
      file(app, "src", "a.ts"),
      file(app, "src", "b.ts"),
    ]);
  });

  it("picks the repository most of the paths live in, worktrees included", () => {
    const paths = [
      file(app, "src", "deep", "x.ts"),
      file(app, "src", "y.ts"),
      file(lib, "z.ts"),
      file(root, "scratch", "notes.md"),
    ];
    assert.equal(repoFromPaths(paths), app);
    assert.equal(repoFromPaths([file(lib, "only.ts")]), lib);
  });

  it("finds nothing outside a repository, so the session stays unmeasured", () => {
    assert.equal(repoFromPaths([file(root, "scratch", "notes.md")]), null);
    assert.equal(repoFromPaths([]), null);
    assert.equal(
      composerPaths({}, [{ toolFormerData: { params: { query: "relative/only" } } }]).length,
      0,
    );
  });

  it("never caches a verdict from a walk that ran out of levels", () => {
    // 70 folders below the repository: past the 64-level cap, so the deep
    // lookup cannot reach `.git` — but it must not teach the cache that the
    // folders it passed hold no repository.
    const parts = Array.from({ length: 70 }, (_, i) => `d${i}`);
    const deep = join(app, ...parts);
    mkdirSync(deep, { recursive: true });
    const rootOf = gitRootFinder();
    assert.equal(rootOf(join(deep, "x.ts")), null);
    assert.equal(rootOf(join(app, ...parts.slice(0, 40), "y.ts")), app);
  });

  it("cleans up", () => rmSync(root, { recursive: true, force: true }));
});

describe("cursor-ide / projectsByComposer", () => {
  it("marks remote workspaces, so their tool paths are never read against this disk", async () => {
    const DatabaseSync = await databaseSync();
    const storage = mkdtempSync(join(tmpdir(), "ai-score-ws-"));
    const workspace = (name, folder, composerId) => {
      const dir = join(storage, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "workspace.json"), JSON.stringify({ folder }));
      const db = new DatabaseSync(join(dir, "state.vscdb"));
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
        "composer.composerData",
        JSON.stringify({ allComposers: [{ composerId }] }),
      );
      db.close();
    };
    workspace("local", "file:///Users/someone/app", "c-local");
    workspace("remote", "vscode-remote://ssh-remote+box/home/someone/app", "c-remote");
    const projects = projectsByComposer(storage, DatabaseSync);
    assert.deepEqual(
      { dir: projects.get("c-local")?.dir, remote: projects.get("c-local")?.remote },
      { dir: "/Users/someone/app", remote: false },
    );
    assert.deepEqual(
      { dir: projects.get("c-remote")?.dir, remote: projects.get("c-remote")?.remote },
      { dir: null, remote: true },
    );
    rmSync(storage, { recursive: true, force: true });
  });
});

describe("cursor-ide / foldComposer", () => {
  const timing = (start, end) => ({ clientRpcSendTime: start, clientEndTime: end });
  const tool = (name, extra = {}) => ({
    type: 2,
    toolFormerData: { name, status: "completed", ...extra },
  });

  const composer = {
    composerId: "c1",
    createdAt: 1_700_000_000_000,
    lastUpdatedAt: 1_700_000_600_000,
    unifiedMode: "agent",
    isAgentic: true,
    modelConfig: { modelName: "composer-1", maxMode: true },
    usageData: { "claude-4.5-sonnet": { costInCents: 294, amount: 75 } },
    totalLinesAdded: 120,
    totalLinesRemoved: 30,
    filesChangedCount: 4,
  };

  const bubbles = [
    { type: 1, text: "add a route", timingInfo: timing(1_700_000_000_000, 1_700_000_000_500) },
    { type: 2, thinking: { text: "…" }, tokenCount: { inputTokens: 900, outputTokens: 40 } },
    tool("read_file"),
    tool("search_replace", { status: "error" }),
    tool("run_terminal_cmd", { userDecision: "rejected" }),
    {
      type: 2,
      text: "here is the route",
      modelInfo: { modelName: "claude-4.5-sonnet" },
      tokenCount: { inputTokens: 1_000, outputTokens: 250 },
      timingInfo: timing(1_700_000_030_000, 1_700_000_090_000),
    },
    { type: 1, text: "now cancel" },
    tool("mcp_context7_get-library-docs", { status: "cancelled" }),
  ];

  const fold = () => foldComposer(composer, bubbles, "projecthash", false);

  it("counts replies apart from thinking and tool bubbles", () => {
    const s = fold();
    assert.equal(s.counts.userPrompts, 2);
    assert.equal(s.counts.assistantMessages, 1);
    assert.equal(s.counts.toolCalls, 4);
    assert.equal(s.flags.thinkingBlocks, 1);
  });

  it("reads errors, denials and cancellations off the tool bubbles", () => {
    const s = fold();
    assert.equal(s.counts.toolErrors, 1);
    assert.equal(s.counts.toolDenials, 1);
    assert.equal(s.counts.interruptions, 1);
    assert.equal(s.flags.mcpCalls, 1);
    assert.deepEqual(s.tools, {
      read_file: 1,
      search_replace: 1,
      run_terminal_cmd: 1,
      "mcp_context7_get-library-docs": 1,
    });
  });

  it("attributes tokens to the bubble's model, falling back to the composer's", () => {
    const s = fold();
    assert.equal(s.models["composer-1"].input, 900);
    assert.equal(s.models["claude-4.5-sonnet"].input, 1_000);
    assert.equal(s.models["claude-4.5-sonnet"].output, 250);
    assert.deepEqual(s.flags.models, ["claude-4.5-sonnet", "composer-1"]);
  });

  it("measures turns even when only some bubbles carry a clock", () => {
    const s = fold();
    assert.equal(s.agentic.turns, 2);
    // First turn: three tool calls. Second: one.
    assert.equal(s.agentic.maxToolCallsPerTurn, 3);
    assert.equal(s.agentic.longestTurnMs, 90_000);
  });

  it("carries over the composer's own bookkeeping", () => {
    const s = fold();
    assert.equal(s.startedAt, new Date(composer.createdAt).toISOString());
    assert.equal(s.endedAt, new Date(composer.lastUpdatedAt).toISOString());
    assert.equal(s.costUsd, 2.94);
    assert.equal(s.flags.billedRequests, 75);
    assert.deepEqual(s.outcome.additions, 120);
    assert.deepEqual(s.outcome.deletions, 30);
    assert.deepEqual(s.outcome.filesChanged, 4);
    assert.deepEqual(s.flags.modes, ["agent"]);
    assert.equal(s.flags.maxMode, true);
  });

  it("reports no cost when the session was never billed separately", () => {
    const s = foldComposer({ ...composer, usageData: {} }, bubbles, "p", false);
    assert.equal(s.costUsd, null);
    assert.equal(s.flags.billedRequests, 0);
  });

  it("leaves diff counts null when the composer never recorded them", () => {
    const bare = { composerId: "c2", createdAt: 1, lastUpdatedAt: 2 };
    const s = foldComposer(bare, [], "p", true);
    assert.equal(s.isSubagent, true);
    assert.equal(s.outcome.additions, null);
    assert.equal(s.outcome.filesChanged, null);
    assert.equal(s.agentic.longestTurnMs, null);
    assert.deepEqual(s.models, {});
  });
});

describe("cursor / piped-check verdicts and diff estimates", () => {
  it("settles a piped check from the recorded output text (cursor-cli)", () => {
    const s = newSessionRecord("id", "project");
    foldMessages(
      [
        { role: "user", content: [{ type: "text", text: "fix it" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "edit",
              toolCallId: "e1",
              input: { file_path: "/p/a.ts", old_string: "x", new_string: "y\nz" },
            },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "e1", output: { exitCode: 0 } }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "shell",
              toolCallId: "t1",
              input: { command: "pnpm test 2>&1 | tail -8" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              output: { exitCode: 0, output: "Tests  9 passed (9)\nDuration  1.2s" },
            },
          ],
        },
      ],
      s,
    );
    // The pipe replaced the test runner's exit code; only the recorded output
    // text can certify the pass. Before resultText flowed, this was "unknown".
    assert.equal(s.workflow.finalVerification, "passed");
    // And the successful edit implies a measurable diff.
    assert.equal(s.outcome.additions, 2);
    assert.equal(s.outcome.deletions, 1);
    assert.equal(s.outcome.filesChanged, 1);
  });

  it("settles a piped check from toolFormerData.result (cursor-ide)", () => {
    const s = foldComposer(
      { composerId: "c9", createdAt: 1, lastUpdatedAt: 2 },
      [
        { type: 1, text: "run the tests" },
        {
          type: 2,
          toolFormerData: {
            name: "edit_file_v2",
            callId: "e1",
            status: "completed",
            input: { file_path: "/p/a.ts", old_string: "x", new_string: "y" },
          },
        },
        {
          type: 2,
          toolFormerData: {
            name: "run_terminal_command_v2",
            callId: "t1",
            status: "completed",
            input: { command: "pnpm test | tail -5" },
            result: JSON.stringify({ output: "Tests  3 passed (3)" }),
          },
        },
      ],
      "p",
      false,
    );
    assert.equal(s.workflow.codeChange, "success");
    assert.deepEqual(s.workflow.verificationKinds, ["test"]);
    assert.equal(s.workflow.finalVerification, "passed");
  });
});
