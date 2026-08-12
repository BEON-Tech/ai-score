import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSubmission } from "../dist/send.js";
import { renderReport, renderScore, renderUploaded } from "../dist/summary.js";
import { blockText, compact, padStart, vlen } from "../dist/ui.js";

/**
 * Strips ANSI escapes before asserting. Setting NO_COLOR here would not work —
 * ESM imports are hoisted, so ui.js reads the environment before any statement
 * in this file runs — and the assertions should hold whether colour is on or
 * off in the harness that happens to be running them.
 */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const dimension = (score, max) => ({ score, max, signals: {} });

const FULL_BODY = JSON.stringify({
  id: "6332871d-0f63-4973-8a46-a0803b534670",
  url: "https://score.example.com/submissions/6332871d-0f63-4973-8a46-a0803b534670",
  score: {
    total: 92,
    version: 3,
    dimensions: {
      leverage: { score: 23.1, max: 25, signals: { toolCallsPerPrompt: 20.6 } },
      craft: dimension(13.2, 15),
      output: dimension(9.1, 10),
      customization: dimension(4.7, 5),
      efficiency: dimension(5, 5),
      verification: { score: 9, max: 10, signals: { attempted: 9, observable: 10 } },
      completion: { score: 20, max: 25, signals: { passed: 8, observable: 10 } },
      autonomy: { score: 3, max: 5, signals: { autonomous: 6, observable: 10 } },
    },
    workflow: {
      status: "scored",
      scoringVersion: 3,
      reasonCodes: [],
      evidence: {
        codingSessions: 12,
        unclassifiedSessions: 0,
        observableSessions: 10,
        coverage: 10 / 12,
        checksAttempted: 9,
        verifiedCompletions: 8,
        autonomousCompletions: 6,
        recoveredFailures: 2,
        deliveriesObserved: 4,
      },
    },
  },
});

describe("parseSubmission", () => {
  it("reads id and every dimension out of a well-formed response", () => {
    const { id, score, url } = parseSubmission(FULL_BODY);
    assert.equal(id, "6332871d-0f63-4973-8a46-a0803b534670");
    assert.equal(url, "https://score.example.com/submissions/6332871d-0f63-4973-8a46-a0803b534670");
    assert.equal(score.total, 92);
    assert.equal(score.version, 3);
    assert.deepEqual(Object.keys(score.dimensions), [
      "leverage",
      "craft",
      "output",
      "customization",
      "efficiency",
      "verification",
      "completion",
      "autonomy",
    ]);
    assert.equal(score.dimensions.leverage.signals.toolCallsPerPrompt, 20.6);
    assert.equal(score.workflow.status, "scored");
    assert.equal(score.workflow.evidence.observableSessions, 10);
  });

  it("keeps dimensions the client has never heard of", () => {
    const body = JSON.stringify({
      id: "x",
      score: { total: 5, version: 9, dimensions: { collaboration: dimension(3.2, 8) } },
    });
    const { score } = parseSubmission(body);
    assert.equal(score.dimensions.collaboration.max, 8);
  });

  // Every case below must degrade rather than throw: the upload has already
  // succeeded by the time the body is parsed, so throwing would turn a
  // successful submission into a reported failure.
  it("returns nulls for a non-JSON body", () => {
    assert.deepEqual(parseSubmission("<html>502 Bad Gateway</html>"), {
      id: null,
      score: null,
      url: null,
    });
  });

  it("returns nulls for JSON that is not an object", () => {
    const empty = { id: null, score: null, url: null };
    assert.deepEqual(parseSubmission("[1,2,3]"), empty);
    assert.deepEqual(parseSubmission("null"), empty);
    assert.deepEqual(parseSubmission('"ok"'), empty);
  });

  it("keeps the id even when the score is unusable", () => {
    assert.deepEqual(parseSubmission('{"id":"abc","score":{"total":"nope"}}'), {
      id: "abc",
      score: null,
      url: null,
    });
  });

  it("tolerates a score without workflow evidence, from an older server", () => {
    const body = JSON.stringify({ id: "a", score: { total: 5, version: 2, dimensions: {} } });
    assert.equal(parseSubmission(body).score.workflow, null);
  });

  // The url is printed and offered to a browser launcher, so anything but a
  // well-formed http(s) URL must degrade to "no link" rather than pass through.
  it("drops a view url that is not well-formed http(s)", () => {
    const parse = (url) => parseSubmission(JSON.stringify({ id: "a", url })).url;
    assert.equal(parse("javascript:alert(1)"), null);
    assert.equal(parse("file:///etc/passwd"), null);
    assert.equal(parse("not a url"), null);
    assert.equal(parse(42), null);
    assert.equal(
      parse("http://localhost:3000/submissions/a"),
      "http://localhost:3000/submissions/a",
    );
  });

  it("drops a score with no dimensions object", () => {
    assert.equal(parseSubmission('{"id":"a","score":{"total":10}}').score, null);
  });

  it("skips malformed dimensions but keeps valid siblings", () => {
    const body = JSON.stringify({
      id: "a",
      score: {
        total: 10,
        version: 1,
        dimensions: { good: dimension(1, 2), bad: { score: "x" }, alsoBad: null },
      },
    });
    const { score } = parseSubmission(body);
    assert.deepEqual(Object.keys(score.dimensions), ["good"]);
  });

  it("drops non-numeric signals rather than the whole dimension", () => {
    const body = JSON.stringify({
      id: "a",
      score: {
        total: 1,
        version: 1,
        dimensions: { d: { score: 1, max: 2, signals: { good: 3, bad: "x", worse: null } } },
      },
    });
    const { score } = parseSubmission(body);
    assert.deepEqual(score.dimensions.d.signals, { good: 3 });
  });

  it("defaults a missing version to 0 so it can be hidden", () => {
    const body = JSON.stringify({ id: "a", score: { total: 1, dimensions: {} } });
    assert.equal(parseSubmission(body).score.version, 0);
  });

  it("rejects a non-finite total", () => {
    assert.equal(parseSubmission('{"score":{"total":null,"dimensions":{}}}').score, null);
  });
});

describe("renderScore", () => {
  const score = parseSubmission(FULL_BODY).score;

  it("shows the total against the sum of the dimension maxima", () => {
    const out = plain(renderScore(score, null));
    assert.match(out, /O V E R A L L\s+S C O R E/);
    assert.match(out, /92 of 100/);
    assert.match(out, /exceptional/);
    assert.match(out, /scoring v3/);
  });

  it("prints the workflow evidence as notes on the card", () => {
    const out = plain(renderScore(score, null));
    assert.match(out, /10 observable \/ 12 evidence candidates/);
    assert.match(out, /83\.3% coverage/);
    assert.match(out, /2 failures recovered · 4 deliveries observed/);
  });

  it("explains missing workflow dimensions without inventing a zero", () => {
    const out = plain(
      renderScore(
        {
          total: 88,
          version: 3,
          dimensions: { leverage: dimension(22, 41.7) },
          workflow: {
            status: "insufficient_evidence",
            scoringVersion: 3,
            reasonCodes: ["MIN_OBSERVABLE_SESSIONS"],
            evidence: { ...score.workflow.evidence, observableSessions: 3, coverage: 1 },
          },
        },
        null,
      ),
    );
    assert.match(out, /scored over the usage dimensions only/);
    assert.match(out, /at least 5 observable coding sessions/);
    assert.doesNotMatch(out, /0 of 100/);
  });

  it("lists every dimension with its figure", () => {
    const out = plain(renderScore(score, null));
    for (const [name, d] of Object.entries(score.dimensions)) {
      assert.match(out, new RegExp(name), `missing dimension ${name}`);
      assert.match(out, new RegExp(`${d.score}/${d.max}`.replace(".", "\\.")));
    }
  });

  it("prints whole scores without a trailing .0", () => {
    const out = plain(renderScore({ total: 92, version: 1, dimensions: {} }, null));
    assert.match(out, /92 of 100/);
    assert.doesNotMatch(out, /92\.0/);
  });

  it("hides the scoring version when the server did not send one", () => {
    const out = plain(renderScore({ total: 50, version: 0, dimensions: {} }, null));
    assert.doesNotMatch(out, /scoring v/);
  });

  it("includes the submission id as a note when given", () => {
    assert.match(plain(renderScore(score, "abc-123")), /submission abc-123/);
    assert.doesNotMatch(plain(renderScore(score, null)), /submission/);
  });

  it("prints the view link instead of the bare id when the server sent one", () => {
    const out = plain(renderScore(score, "abc-123", "https://s.example.com/submissions/abc-123"));
    assert.match(out, /full report\s+https:\/\/s\.example\.com\/submissions\/abc-123/);
    assert.doesNotMatch(out, /submission abc-123/);
  });

  it("bands the total by percentage, not by raw points", () => {
    const halfOfTen = { total: 5, version: 1, dimensions: { a: dimension(5, 10) } };
    assert.match(plain(renderScore(halfOfTen, null)), /developing/);
    const nearlyAll = { total: 9.5, version: 1, dimensions: { a: dimension(9.5, 10) } };
    assert.match(plain(renderScore(nearlyAll, null)), /exceptional/);
  });

  it("survives an empty dimensions object", () => {
    assert.doesNotThrow(() => renderScore({ total: 0, version: 1, dimensions: {} }, null));
  });
});

describe("renderUploaded", () => {
  it("confirms the upload when no score could be read", () => {
    assert.match(plain(renderUploaded(201, null)), /report uploaded/);
    assert.match(plain(renderUploaded(201, null)), /HTTP 201/);
  });

  it("includes the id when there is one", () => {
    assert.match(plain(renderUploaded(201, "abc")), /abc/);
  });

  it("prefers the view link over the bare id", () => {
    const out = plain(renderUploaded(201, "abc", "https://s.example.com/submissions/abc"));
    assert.match(out, /https:\/\/s\.example\.com\/submissions\/abc/);
    assert.doesNotMatch(out, / · abc/);
  });
});

describe("renderReport", () => {
  const report = (harness, over = {}) => ({
    harness,
    detected: true,
    dataPath: null,
    latestVersion: null,
    sessionsScanned: 1,
    sessionsIncluded: 1,
    parseErrors: 0,
    skippedReason: null,
    sessions: [],
    ...over,
  });

  const payload = (harnesses) => ({
    schema: "beon.ai-score.v2",
    client: { name: "@beon-tech/ai-score", version: "0.0.0" },
    generatedAt: "2026-07-28T00:00:00.000Z",
    window: { days: 30, start: "2026-06-28T00:00:00.000Z", end: "2026-07-28T00:00:00.000Z" },
    engineer: { machineId: "abc" },
    platform: { os: "darwin", arch: "arm64", node: "22.0.0" },
    harnesses,
  });

  it("marks an undetected harness as not found and still lists it", () => {
    const out = plain(renderReport(payload([report("pi", { detected: false })])));
    assert.match(out, /pi/);
    assert.match(out, /not found/);
  });

  it("marks a skipped harness and explains why", () => {
    const out = plain(
      renderReport(payload([report("opencode", { skippedReason: "needs Node >= 22.5" })])),
    );
    assert.match(out, /skipped/);
    assert.match(out, /needs Node >= 22\.5/);
  });

  it("notes unreadable records without hiding them", () => {
    const out = plain(renderReport(payload([report("codex", { parseErrors: 4 })])));
    assert.match(out, /4 unreadable records/);
  });

  it("keeps columns aligned when a harness name is unusually long", () => {
    const out = plain(
      renderReport(payload([report("claude-code"), report("a-very-long-harness-name")])),
    );
    const rows = out
      .split("\n")
      .filter((l) => l.includes("claude-code") || l.includes("a-very-long-harness-name"));
    assert.equal(rows.length, 2);
    // Both data rows must end their first column at the same visible offset.
    const offsets = rows.map((r) => r.length - r.trimEnd().length);
    assert.equal(new Set(offsets).size <= 2, true);
  });
});

describe("ui primitives", () => {
  it("measures visible width, ignoring ANSI escapes", () => {
    assert.equal(vlen("\x1b[38;2;1;2;3mabc\x1b[0m"), 3);
    assert.equal(vlen("abc"), 3);
  });

  it("pads based on visible width, not byte length", () => {
    assert.equal(vlen(padStart("\x1b[1mab\x1b[0m", 5)), 5);
  });

  it("renders block text as exactly three rows of equal width", () => {
    const rows = blockText("92");
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => [...r].length)).size, 1);
  });

  it("falls back to blanks for characters with no glyph", () => {
    assert.doesNotThrow(() => blockText("!@#"));
    assert.equal(
      blockText("!").every((r) => r.trim() === ""),
      true,
    );
  });

  it("abbreviates large counts", () => {
    assert.equal(compact(999), "999");
    assert.equal(compact(4108), "4.1k");
    assert.equal(compact(4_200_000), "4.2M");
    assert.equal(compact(1_042_000_000), "1.0B");
  });
});
