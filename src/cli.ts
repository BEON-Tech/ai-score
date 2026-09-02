#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { adapters } from "./adapters/index.js";
import {
  type AuthContext,
  cached,
  credentialPath,
  describe,
  DeviceFlowError,
  invalidate,
  login,
  logout,
  resolveToken,
  TOKEN_ENV_VAR,
  whoami,
} from "./auth/index.js";
import { canOpenBrowser, openBrowser } from "./auth/browser.js";
import { DEFAULT_BASE_URL, resolveTarget } from "./config.js";
import { annotateLocalCommits } from "./git-local.js";
import { send, UnauthorizedError } from "./send.js";
import {
  renderHeader,
  renderPrivacy,
  renderReport,
  renderScore,
  renderUploaded,
  scanDetail,
} from "./summary.js";
import type { HarnessName, HarnessReport, Payload } from "./types.js";
import { c, ScanProgress } from "./ui.js";
import { displayPath, hash16 } from "./util.js";

const COMMANDS = ["login", "logout", "whoami"] as const;
type Command = (typeof COMMANDS)[number];

const HELP = `ai-score — extract AI coding harness usage into an auditable report

Usage
  npx @beon-tech/ai-score [options]        scan, summarize, upload
  npx @beon-tech/ai-score login            sign in through your browser
  npx @beon-tech/ai-score logout           forget the cached token
  npx @beon-tech/ai-score whoami           show who this machine is signed in as

Scans local session data from Claude Code, Codex, Cursor and GitHub Copilot,
normalizes it into structural metadata and locally derived workflow states.
Tool arguments, result statuses and check output are inspected only long
enough to classify edits and checks; their raw values, code, prompts, paths
and message text are never sent. Submissions are attributed to the account
you sign in as.

Options
  --harness <names>   comma-separated subset: claude-code,codex,copilot-cli,
                      copilot-ide,cursor-cli,cursor-ide
  --url <url>         ai-score server (default: $AI_SCORE_URL or
                      ${DEFAULT_BASE_URL})
  --no-browser        never open a browser — print login and report URLs only

Audit
  --audit             print the exact JSON payload that would be uploaded
  --out <file>        write the payload to a file for inspection
  --dry-run           extract and summarize, but never touch the network
  --yes               skip remaining interactive prompts

Other
  --endpoint <url>    deprecated: exact submissions URL, overrides --url
  --verbose           log every session file as it is parsed
  --version           print version
  --help              show this help

Environment
  ${TOKEN_ENV_VAR}     use this token instead of signing in (for CI)
  AI_SCORE_URL        default server, same as --url
`;

function ownVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version);
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      harness: { type: "string", multiple: true },
      url: { type: "string" },
      endpoint: { type: "string" },
      out: { type: "string" },
      audit: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "no-browser": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const version = ownVersion();
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }

  // parseArgs accepts positionals now, which means a mistyped flag value lands
  // here instead of erroring — so reject anything that is not a known command.
  if (positionals.length > 1) {
    throw new Error(`expected one command, got: ${positionals.join(" ")}`);
  }
  const command = positionals[0];
  if (command !== undefined && !COMMANDS.includes(command as Command)) {
    throw new Error(`unknown command "${command}" — valid commands: ${COMMANDS.join(", ")}`);
  }

  const target = resolveTarget(values.endpoint, values.url);
  const auth: AuthContext = {
    baseUrl: target.baseUrl,
    noBrowser: values["no-browser"],
    log: (message) => process.stderr.write(`${message}\n`),
  };

  if (command) {
    await runCommand(command as Command, auth);
    return;
  }

  // Not an option any more, on purpose: the window used to be user-chosen,
  // which made count signals depend on how much history you asked to upload.
  // The CLI now always collects a full year and the server scores a fixed
  // trailing window over it, so every submission is like-for-like.
  const days = 365;

  const known = adapters.map((a) => a.harness);
  const requested = values.harness
    ?.flatMap((v) => v.split(",").map((s) => s.trim()))
    .filter(Boolean);
  if (requested) {
    const unknown = requested.filter((h) => !known.includes(h as HarnessName));
    if (unknown.length > 0) {
      throw new Error(
        `unknown harness "${unknown.join(", ")}" — valid values: ${known.join(", ")}`,
      );
    }
  }
  const selected = requested ? adapters.filter((a) => requested.includes(a.harness)) : adapters;

  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const verbose = values.verbose ? (msg: string) => process.stderr.write(`${msg}\n`) : () => {};
  const machineId = hash16(`${os.hostname()}:${os.userInfo().username}`);

  // Offline lookup — shows who we would submit as without a network round-trip.
  const knownAccount = process.env[TOKEN_ENV_VAR]
    ? `(${TOKEN_ENV_VAR})`
    : cached(target.baseUrl)?.identity
      ? describe(cached(target.baseUrl)!.identity)
      : null;

  // The header goes up before the scan so the run's parameters are on screen
  // while the slow part happens.
  process.stderr.write(
    renderHeader({
      version,
      days,
      start: since.toISOString(),
      end: now.toISOString(),
      account: knownAccount,
      machineId,
    }),
  );

  // `--verbose` prints a line per session file, which cannot share a cursor with
  // a fixed-height repaint region — so the spinner stands down for it.
  const progress = new ScanProgress(
    selected.map((a) => a.harness),
    !values.verbose,
  );
  if (values.verbose) {
    process.stderr.write(
      `  ${c.faint(`scanning ${selected.map((a) => a.harness).join(", ")}…`)}\n`,
    );
  }

  const harnesses: HarnessReport[] = [];
  // Session working directories, kept out of the reports on purpose: the
  // payload only ever carries their hashes, but the git delivery cross-check
  // below needs the real paths for a moment.
  const collected: { report: HarnessReport; dirs: Map<string, string> }[] = [];
  try {
    for (const adapter of selected) {
      progress.begin(adapter.harness);
      const dirs = new Map<string, string>();
      const report = await adapter.collect({
        since,
        now,
        // Adapters call verbose once per session file, so it doubles as the
        // progress tick that keeps a multi-thousand-session scan looking alive.
        verbose: (msg) => {
          progress.tick(adapter.harness);
          verbose(msg);
        },
        recordProjectDir: (sessionId, dir) => dirs.set(sessionId, dir),
      });
      // A session the agent never answered says nothing about how the engineer
      // works, and the server drops it before scoring (its `isInertSession`).
      // Dropping it here too keeps the payload uploadable: one automation left
      // 97k one-prompt Codex files behind — 157 MB against a 25 MB limit.
      report.sessions = report.sessions.filter(
        (s) => s.counts.assistantMessages > 0 || s.counts.toolCalls > 0,
      );
      report.sessionsIncluded = report.sessions.length;
      progress.end(adapter.harness, scanDetail(report));
      harnesses.push(report);
      collected.push({ report, dirs });
    }
  } finally {
    // Always erase the block and restore the cursor, including on a throw.
    progress.finish();
  }

  // Delivery that happened outside the harness — commit scripts, a second
  // terminal — is only visible in local git history. Read-only and offline;
  // only commit counts survive into the payload.
  await annotateLocalCommits(collected, since, verbose);

  const payload: Payload = {
    schema: "beon.ai-score.v2",
    client: { name: "@beon-tech/ai-score", version, workflowClassifierVersion: 3 },
    generatedAt: now.toISOString(),
    window: { days, start: since.toISOString(), end: now.toISOString() },
    engineer: { machineId },
    platform: { os: process.platform, arch: process.arch, node: process.versions.node },
    harnesses,
  };

  process.stderr.write(renderReport(payload, values.verbose));
  process.stderr.write(renderPrivacy());

  const json = JSON.stringify(payload, null, 2);
  if (values.out) {
    writeFileSync(values.out, json);
    process.stderr.write(`  ${c.faint("payload written to")} ${c.text(values.out)}\n\n`);
  }
  if (values.audit) {
    process.stdout.write(`${json}\n`);
  }

  // Everything past here touches the network. --dry-run must return first so it
  // stays usable with no token and no TTY (CI's smoke test relies on this).
  if (values["dry-run"]) {
    process.stderr.write(`  ${c.faint("dry run — nothing was uploaded.")}\n\n`);
    return;
  }

  // Login needs no stdin, but it does need someone watching the terminal;
  // blocking a CI job for ten minutes is worse than failing fast.
  const token = await resolveToken({ ...auth, allowLogin: Boolean(process.stdin.isTTY) });

  try {
    const { status, result } = await send(target.submissionsUrl, payload, token);
    // The server returns a per-dimension breakdown; render it rather than
    // printing the first 200 characters of the response object.
    if (result.score) {
      process.stderr.write(renderScore(result.score, result.id, result.url));
    } else process.stderr.write(renderUploaded(status, result.id, result.url));

    // Offer to open the full report, but only in a session that is already
    // conversational: `--yes` promised no prompts (its runs may be scripted
    // with a live TTY), and `--no-browser` said never to spawn one. The URL
    // is printed above either way, so declining loses nothing.
    if (
      result.url &&
      !values.yes &&
      !values["no-browser"] &&
      process.stdin.isTTY &&
      canOpenBrowser()
    ) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = (
        await rl.question(
          `  ${c.text("Open the full report in your browser?")} ${c.faint("[Y/n]")} `,
        )
      )
        .trim()
        .toLowerCase();
      rl.close();
      if (answer === "" || answer === "y" || answer === "yes") openBrowser(result.url);
      process.stderr.write("\n");
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Drop the dead token so the next run does not repeat this failure.
      invalidate(target.baseUrl);
      throw new Error(`${err.message}\nyour session is no longer valid — run 'ai-score login'`);
    }
    throw err;
  }
}

async function runCommand(command: Command, auth: AuthContext): Promise<void> {
  switch (command) {
    case "login": {
      const existing = cached(auth.baseUrl);
      if (existing) {
        auth.log(`already signed in as ${describe(existing.identity)} — replacing that session.`);
      }
      await login(auth);
      return;
    }
    case "logout": {
      const removed = logout(auth.baseUrl);
      auth.log(
        removed
          ? `signed out of ${auth.baseUrl} — token removed from ${displayPath(credentialPath())}`
          : `not signed in to ${auth.baseUrl} — nothing to do.`,
      );
      return;
    }
    case "whoami": {
      const identity = await whoami(auth.baseUrl);
      if (!identity) {
        auth.log(`not signed in to ${auth.baseUrl} — run 'ai-score login'.`);
        process.exitCode = 1;
        return;
      }
      auth.log(`${describe(identity)} · ${auth.baseUrl}`);
      return;
    }
  }
}

main().catch((err: Error) => {
  const detail = err instanceof DeviceFlowError ? `${err.message} (${err.code})` : err.message;
  process.stderr.write(`ai-score: ${detail}\n`);
  process.exit(1);
});
