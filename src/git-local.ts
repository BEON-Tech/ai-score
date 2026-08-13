import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessReport, SessionRecord } from "./types.js";
import { toMs } from "./util.js";

const run = promisify(execFile);

/**
 * Delivery evidence the harness cannot see: engineers who commit and push
 * from a script or a second terminal ship real work that never appears in
 * the session transcript, so "no PR link in the transcript" must not read as
 * "didn't ship". This module consults local git history — read-only, offline
 * — and stamps each session with the number of commits its author made in
 * the session's repository while the session ran (plus a slack window after
 * it, which is when commit scripts actually run).
 *
 * What is read: `git config user.email` (to attribute commits to this
 * machine's identity, never sent) and `git log` timestamps. What is sent: a
 * count per session. No hashes, no messages, no branch names, no paths.
 */

/** Commit scripts run right after the agent stops; give them half an hour. */
export const DELIVERY_SLACK_MS = 30 * 60 * 1000;

/** Commits inside [start, end + slack], or null when the window is unknown. */
export function countCommitsInWindow(
  commitTimes: number[],
  start: number | null,
  end: number | null,
  slackMs = DELIVERY_SLACK_MS,
): number | null {
  if (start === null && end === null) return null;
  const from = start ?? (end as number);
  const to = (end ?? (start as number)) + slackMs;
  return commitTimes.filter((time) => time >= from && time <= to).length;
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], {
    timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/**
 * Committer timestamps (ms) of this machine's own non-merge commits in the
 * repository containing `dir`, newest window only. Throws when `dir` is not
 * a repository, git is missing, or no identity is configured — the caller
 * treats all of those as "unmeasurable", never as zero.
 */
async function ownCommitTimes(dir: string, since: Date): Promise<number[]> {
  const email = (await git(dir, ["config", "user.email"])).trim();
  if (!email) throw new Error("no git identity");
  const log = await git(dir, [
    "log",
    "--all",
    "--no-merges",
    "--fixed-strings",
    `--author=${email}`,
    `--since=${since.toISOString()}`,
    "--max-count=20000",
    "--pretty=%ct",
  ]);
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line) * 1000)
    .filter((time) => Number.isFinite(time));
}

/**
 * Fills `outcome.localCommits` for every session whose adapter recorded a
 * working directory. One `git log` per distinct directory, sessions bucketed
 * onto it in memory. Directories that fail stay null for their sessions —
 * silent, because "not a repo" and "git not installed" are normal here.
 */
export async function annotateLocalCommits(
  entries: Array<{ report: HarnessReport; dirs: Map<string, string> }>,
  since: Date,
  verbose: (message: string) => void,
): Promise<void> {
  const byDir = new Map<string, SessionRecord[]>();
  for (const { report, dirs } of entries) {
    for (const session of report.sessions) {
      const dir = dirs.get(session.id);
      if (!dir) continue;
      const bucket = byDir.get(dir);
      if (bucket) bucket.push(session);
      else byDir.set(dir, [session]);
    }
  }

  for (const [dir, sessions] of byDir) {
    let times: number[];
    try {
      times = await ownCommitTimes(dir, since);
    } catch {
      verbose(`git: skipping ${dir} — not a repository, no git, or no identity`);
      continue;
    }
    for (const session of sessions) {
      session.outcome.localCommits = countCommitsInWindow(
        times,
        toMs(session.startedAt),
        toMs(session.endedAt),
      );
    }
  }
}
