import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countCommitsInWindow, DELIVERY_SLACK_MS } from "../dist/git-local.js";

const MIN = 60_000;

describe("local git delivery evidence", () => {
  it("counts commits inside the session window plus the slack", () => {
    const start = 1_000_000_000_000;
    const end = start + 60 * MIN;
    const times = [
      start - 5 * MIN, // before the session — a different piece of work
      start + 10 * MIN, // during
      end + 10 * MIN, // the commit script, just after the agent stopped
      end + DELIVERY_SLACK_MS + MIN, // too late to attribute
    ];
    assert.equal(countCommitsInWindow(times, start, end), 2);
  });

  it("brackets a session missing one timestamp by the other", () => {
    const t = 1_000_000_000_000;
    assert.equal(countCommitsInWindow([t + MIN], t, null), 1);
    assert.equal(countCommitsInWindow([t + MIN], null, t), 1);
  });

  it("reports null, never zero, when the window is unknown", () => {
    assert.equal(countCommitsInWindow([1, 2, 3], null, null), null);
  });
});
