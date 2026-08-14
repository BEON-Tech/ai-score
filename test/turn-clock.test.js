import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldComposer } from "../dist/adapters/cursor-ide.js";
import { TurnClock, TURN_IDLE_GAP_MS } from "../dist/util.js";

const T0 = Date.parse("2026-07-30T10:00:00.000Z");
const MIN = 60_000;

describe("TurnClock", () => {
  it("accumulates gaps between records and excludes idle ones", () => {
    const clock = new TurnClock();
    clock.start(T0);
    clock.tick(T0 + 1 * MIN);
    clock.tick(T0 + 1 * MIN + TURN_IDLE_GAP_MS + 1); // overnight — excluded
    clock.tick(T0 + 1 * MIN + TURN_IDLE_GAP_MS + 1 + 30_000);
    assert.equal(clock.stop(), 1 * MIN + 30_000);
  });

  it("returns null when no turn was open, 0 for an open turn with no clock", () => {
    const clock = new TurnClock();
    assert.equal(clock.stop(), null);
    clock.start(null);
    assert.equal(clock.stop(), 0);
    // Ticks while closed are no-ops.
    clock.tick(T0);
    assert.equal(clock.stop(), null);
  });

  it("starts at the first timestamped tick when opened without one", () => {
    const clock = new TurnClock();
    clock.start(null);
    clock.tick(T0);
    clock.tick(T0 + 2 * MIN);
    assert.equal(clock.stop(), 2 * MIN);
  });
});

describe("cursor-ide / foldComposer with the turn clock", () => {
  const bubble = (overrides) => ({ ...overrides });
  const timed = (ts) => ({ timingInfo: { clientRpcSendTime: ts } });

  it("reports active turn time, not wall clock across an idle gap", () => {
    const bubbles = [
      bubble({ type: 1, ...timed(T0) }),
      bubble({ toolFormerData: { name: "edit" }, ...timed(T0 + MIN) }),
      // Session left open; next activity hours later.
      bubble({ toolFormerData: { name: "edit" }, ...timed(T0 + 5 * 60 * MIN) }),
      bubble({ toolFormerData: { name: "edit" }, ...timed(T0 + 5 * 60 * MIN + 30_000) }),
    ];
    const s = foldComposer({ composerId: "c1" }, bubbles, "p", false);
    assert.equal(s.agentic.longestTurnMs, MIN + 30_000);
  });

  it("counts distinct PRs once no matter how many bubbles carry them", () => {
    const pr = { url: "https://github.com/o/r/pull/7" };
    const bubbles = [
      bubble({ type: 1, ...timed(T0), pullRequests: [pr] }),
      bubble({ toolFormerData: { name: "edit" }, ...timed(T0 + MIN), pullRequests: [pr, pr] }),
      bubble({ type: 1, ...timed(T0 + 2 * MIN), pullRequests: [{ url: "other" }] }),
    ];
    const s = foldComposer({ composerId: "c2" }, bubbles, "p", false);
    assert.equal(s.outcome.prLinks, 2);
  });
});
