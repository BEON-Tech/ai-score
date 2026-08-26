import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSession } from "../dist/adapters/claude-code.js";
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

const parse = async (lines) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-code-test-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, lines.join("\n"));
  const report = emptyReport("claude-code", null);
  return { session: await parseSession(file, "project-slug", "native-id", report, ctx), report };
};

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
    assert.equal(s.counts.promptWords, 8 + 9 + 1);
    assert.equal(s.counts.repromptedPrompts, 1);
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
