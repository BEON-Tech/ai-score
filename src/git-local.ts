import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { HarnessReport, SessionRecord } from "./types.js";
import { toMs } from "./util.js";
import { changedFilesOf, type ChangedFiles } from "./workflow.js";

const run = promisify(execFile);

/**
 * Delivery evidence the harness cannot see: engineers who commit and push
 * from a script or a second terminal ship real work that never appears in
 * the session transcript, so "no PR link in the transcript" must not read as
 * "didn't ship". This module consults local git history — read-only, offline
 * — and stamps each session with the number of its author's commits that
 * belong to it.
 *
 * A commit belongs to a session when it touches a file that session's agent
 * edited and lands within `DELIVERY_FILES_WINDOW_MS` of its end — so the
 * next-morning commit counts, and a parallel session's commit to other files
 * does not. A session whose edits are unknown (or partly unknown: an edit
 * through the shell names no file) falls back to time alone: any of the
 * author's commits in the repository during the session or within
 * `DELIVERY_SLACK_MS` after it.
 *
 * What is read: `git config user.email` (to attribute commits to this
 * machine's identity, never sent), `git log` timestamps and the file names
 * each commit touched. What is sent: a count per session, and which rule
 * produced it. No hashes, no messages, no branch names, no paths.
 */

/** Commit scripts run right after the agent stops; give them half an hour. */
export const DELIVERY_SLACK_MS = 30 * 60 * 1000;

/**
 * How long after a session a commit touching its files still belongs to it:
 * long enough for "reviewed it, committed the next morning" and a weekend in
 * between, short enough that a file edited again weeks later is new work.
 */
export const DELIVERY_FILES_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

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

/** One of the author's commits: when, and the repository-relative files it touched. */
export interface LocalCommit {
  time: number;
  files: string[];
}

export type CommitMatch = "files" | "files+time" | "time";

/**
 * The commits that belong to one session, by the rule in the module comment.
 * `edited` holds the session's edited files relative to the repository root;
 * null or empty means none is known. Null count when the session has no
 * clock at all.
 */
export function attributeCommits(
  commits: LocalCommit[],
  start: number | null,
  end: number | null,
  edited: { files: Set<string>; complete: boolean } | null,
): { count: number | null; match: CommitMatch } {
  if (start === null && end === null) return { count: null, match: "time" };
  const from = start ?? (end as number);
  const last = end ?? (start as number);
  const inTimeWindow = (commit: LocalCommit) =>
    commit.time >= from && commit.time <= last + DELIVERY_SLACK_MS;
  if (!edited || edited.files.size === 0) {
    return { count: commits.filter(inTimeWindow).length, match: "time" };
  }
  const touchesEdits = (commit: LocalCommit) =>
    commit.time >= from &&
    commit.time <= last + DELIVERY_FILES_WINDOW_MS &&
    commit.files.some((file) => edited.files.has(file));
  if (edited.complete) {
    return { count: commits.filter(touchesEdits).length, match: "files" };
  }
  return {
    count: commits.filter((commit) => touchesEdits(commit) || inTimeWindow(commit)).length,
    match: "files+time",
  };
}

/**
 * A session's edited files as paths relative to the repository root, in
 * git's forward-slash form. Relative paths are taken against the session's
 * directory, as the harness wrote them; files outside the repository drop.
 */
export function repoRelative(changed: ChangedFiles, sessionDir: string, root: string): Set<string> {
  const files = new Set<string>();
  const slash = (path: string) => path.replace(/\\/g, "/");
  // git reports the root with symlinks resolved (macOS: /var → /private/var),
  // while harnesses record the folder as the engineer opened it.
  let realDir = sessionDir;
  try {
    realDir = realpathSync(sessionDir);
  } catch {
    /* gone since the session — compare as recorded */
  }
  const dirPrefix = slash(sessionDir).replace(/\/+$/, "") + "/";
  for (const path of changed.paths) {
    let absolute = isAbsolute(path) ? slash(path) : join(realDir, path);
    if (absolute.startsWith(dirPrefix)) absolute = join(realDir, absolute.slice(dirPrefix.length));
    const rel = slash(relative(root, absolute));
    if (rel && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)) files.add(rel);
  }
  return files;
}

/** Parses `git log --name-only --pretty=format:%x1e%ct` into commits. */
export function parseCommitLog(log: string): LocalCommit[] {
  const commits: LocalCommit[] = [];
  for (const record of log.split("\x1e")) {
    const lines = record.split("\n").map((line) => line.trim());
    const time = Number(lines[0]) * 1000;
    if (!lines[0] || !Number.isFinite(time)) continue;
    commits.push({ time, files: lines.slice(1).filter(Boolean) });
  }
  return commits;
}

async function git(dir: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], {
    timeout: 8_000,
    maxBuffer,
    windowsHide: true,
  });
  return stdout;
}

/**
 * This machine's own non-merge commits in the repository containing `dir`,
 * newest window only, with the files each touched, plus the repository root
 * those file names are relative to. Throws when `dir` is not a repository,
 * git is missing, or no identity is configured — the caller treats all of
 * those as "unmeasurable", never as zero.
 */
async function ownCommits(
  dir: string,
  since: Date,
): Promise<{ root: string; commits: LocalCommit[] }> {
  const email = (await git(dir, ["config", "user.email"])).trim();
  if (!email) throw new Error("no git identity");
  const root = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  const log = await git(
    dir,
    [
      "log",
      "--all",
      "--no-merges",
      "--fixed-strings",
      `--author=${email}`,
      `--since=${since.toISOString()}`,
      "--max-count=20000",
      "--name-only",
      "--pretty=format:%x1e%ct",
    ],
    64 * 1024 * 1024,
  );
  return { root, commits: parseCommitLog(log) };
}

/**
 * Fills `outcome.localCommits` (and `localCommitsMatch`) for every session
 * whose adapter recorded a working directory. One `git log` per distinct
 * directory, sessions bucketed onto it in memory. Directories that fail stay
 * null for their sessions — silent, because "not a repo" and "git not
 * installed" are normal here.
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

  const matched: Record<CommitMatch, number> = { files: 0, "files+time": 0, time: 0 };
  for (const [dir, sessions] of byDir) {
    let repo: { root: string; commits: LocalCommit[] };
    try {
      repo = await ownCommits(dir, since);
    } catch {
      verbose(`git: skipping ${dir} — not a repository, no git, or no identity`);
      continue;
    }
    for (const session of sessions) {
      const changed = changedFilesOf(session);
      const edited = changed
        ? { files: repoRelative(changed, dir, repo.root), complete: changed.complete }
        : null;
      const { count, match } = attributeCommits(
        repo.commits,
        toMs(session.startedAt),
        toMs(session.endedAt),
        edited,
      );
      session.outcome.localCommits = count;
      if (count !== null) {
        session.outcome.localCommitsMatch = match;
        matched[match]++;
      }
    }
  }
  verbose(
    `git: commits attributed by files ${matched.files}, files+time ${matched["files+time"]}, time ${matched.time}`,
  );
}
