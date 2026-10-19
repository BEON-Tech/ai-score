import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotateLocalCommits,
  attributeCommits,
  countCommitsInWindow,
  DELIVERY_FILES_WINDOW_MS,
  DELIVERY_SLACK_MS,
  parseCommitLog,
  repoRelative,
} from "../dist/git-local.js";
import { CHANGED_FILES } from "../dist/workflow.js";

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

describe("local git delivery evidence — attribution by edited files", () => {
  const start = 1_000_000_000_000;
  const end = start + 60 * MIN;
  const HOUR = 60 * MIN;
  const commits = [
    { time: end + 10 * MIN, files: ["src/other.ts"] }, // someone else's work, right after
    { time: end + 20 * HOUR, files: ["src/a.ts", "README.md"] }, // the next morning, our file
    { time: end + DELIVERY_FILES_WINDOW_MS + HOUR, files: ["src/a.ts"] }, // weeks of new work later
  ];
  const edited = (complete) => ({ files: new Set(["src/a.ts"]), complete });

  it("credits the next-morning commit that touches the session's files, not a neighbour's", () => {
    assert.deepEqual(attributeCommits(commits, start, end, edited(true)), {
      count: 1,
      match: "files",
    });
  });

  it("keeps the time rule too when some edits went through the shell", () => {
    assert.deepEqual(attributeCommits(commits, start, end, edited(false)), {
      count: 2,
      match: "files+time",
    });
  });

  it("falls back to the time window when no edited file is known", () => {
    assert.deepEqual(attributeCommits(commits, start, end, null), { count: 1, match: "time" });
    assert.deepEqual(attributeCommits(commits, start, end, { files: new Set(), complete: true }), {
      count: 1,
      match: "time",
    });
  });

  it("reports null when the session has no clock", () => {
    assert.equal(attributeCommits(commits, null, null, edited(true)).count, null);
  });

  it("parses git's name-only log, commits with no files included", () => {
    const log = "\x1e1700000000\nsrc/a.ts\nsrc/b.ts\n\x1e1700000100\n\x1e1700000200\nREADME.md";
    assert.deepEqual(parseCommitLog(log), [
      { time: 1_700_000_000_000, files: ["src/a.ts", "src/b.ts"] },
      { time: 1_700_000_100_000, files: [] },
      { time: 1_700_000_200_000, files: ["README.md"] },
    ]);
  });

  it("maps edited paths onto the repository root and drops files outside it", () => {
    const changed = { paths: ["/w/app/src/a.ts", "src/b.ts", "/elsewhere/c.ts"], complete: true };
    assert.deepEqual([...repoRelative(changed, "/w/app", "/w/app")].sort(), [
      "src/a.ts",
      "src/b.ts",
    ]);
    // A session opened in a subfolder still lands on the root's paths.
    assert.deepEqual(
      [...repoRelative({ paths: ["x.ts"], complete: true }, "/w/app/pkg", "/w/app")],
      ["pkg/x.ts"],
    );
  });

  it("attributes real commits end to end, and never serializes the paths", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ai-score-git-"));
    const gitIn = (args, env = {}) =>
      execFileSync("git", ["-C", repo, ...args], {
        env: { ...process.env, ...env },
        stdio: "pipe",
      });
    gitIn(["init", "-q"]);
    gitIn(["config", "user.email", "dev@example.com"]);
    gitIn(["config", "user.name", "Dev"]);
    mkdirSync(join(repo, "src"));
    const commitAt = (file, iso) => {
      writeFileSync(join(repo, file), iso);
      gitIn(["add", file]);
      gitIn(["commit", "-q", "-m", "c"], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
    };
    commitAt("src/other.ts", "2026-07-01T10:10:00Z"); // during the session, not its file
    commitAt("src/a.ts", "2026-07-02T09:00:00Z"); // the next morning, its file
    const session = {
      id: "s1",
      startedAt: "2026-07-01T09:00:00Z",
      endedAt: "2026-07-01T10:00:00Z",
      outcome: { localCommits: null },
    };
    session[CHANGED_FILES] = { paths: [join(repo, "src", "a.ts")], complete: true };
    const timeOnly = {
      id: "s2",
      startedAt: "2026-07-01T09:00:00Z",
      endedAt: "2026-07-01T10:00:00Z",
      outcome: { localCommits: null },
    };
    await annotateLocalCommits(
      [
        {
          report: { sessions: [session, timeOnly] },
          dirs: new Map([
            ["s1", repo],
            ["s2", repo],
          ]),
        },
      ],
      new Date("2026-06-01T00:00:00Z"),
      () => {},
    );
    assert.deepEqual(session.outcome, { localCommits: 1, localCommitsMatch: "files" });
    assert.deepEqual(timeOnly.outcome, { localCommits: 1, localCommitsMatch: "time" });
    assert.ok(!JSON.stringify(session).includes("a.ts"));
    rmSync(repo, { recursive: true, force: true });
  });
});
