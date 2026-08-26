import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newSessionRecord, PromptGauge, PROMPT_WORD_CAP } from "../dist/util.js";

describe("PromptGauge", () => {
  it("sums words per prompt and caps a pasted wall of text", () => {
    const s = newSessionRecord("id", "project");
    const g = new PromptGauge(s.counts);
    g.add("fix the failing parser test");
    g.add(Array.from({ length: 1_000 }, (_, i) => `log${i}`).join(" "));
    assert.equal(s.counts.promptWords, 5 + PROMPT_WORD_CAP);
    assert.equal(s.counts.repromptedPrompts, 0);
  });

  it("counts a prompt that mostly repeats the previous one, once per repeat", () => {
    const s = newSessionRecord("id", "project");
    const g = new PromptGauge(s.counts);
    g.add("please refactor the parser module to handle unicode");
    g.add("Please refactor the parser module to handle unicode properly!");
    g.add("now write the changelog entry");
    g.add("please refactor the parser module to handle unicode");
    // Only consecutive repeats count: the last prompt follows an unrelated one.
    assert.equal(s.counts.repromptedPrompts, 1);
  });

  it("never counts short prompts as re-sends", () => {
    const s = newSessionRecord("id", "project");
    const g = new PromptGauge(s.counts);
    g.add("yes");
    g.add("yes");
    g.add("continue");
    g.add("continue");
    assert.equal(s.counts.repromptedPrompts, 0);
    assert.equal(s.counts.promptWords, 4);
  });

  it("keeps different asks apart", () => {
    const s = newSessionRecord("id", "project");
    const g = new PromptGauge(s.counts);
    g.add("please refactor the parser module to handle unicode");
    g.add("please refactor the parser module so it handles unicode");
    // 6 shared of 11 distinct words is 0.55 — a rewording with new words,
    // below the 0.6 line.
    assert.equal(s.counts.repromptedPrompts, 0);
  });
});
