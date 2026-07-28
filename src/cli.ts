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
import { DEFAULT_BASE_URL, resolveTarget } from "./config.js";
import { send, UnauthorizedError } from "./send.js";
import {
  renderHeader,
  renderPrivacy,
  renderReport,
  renderScore,
  renderUploaded,
  scanDetail,
} from "./summary.js";
import type { HarnessName, Payload } from "./types.js";
import { c, ScanProgress } from "./ui.js";
import { displayPath, hash16 } from "./util.js";

const COMMANDS = ["login", "logout", "whoami"] as const;
type Command = (typeof COMMANDS)[number];

const HELP = `ai-score — extract AI coding harness usage into an auditable report

Usage
  npx @beon-tech/ai-score [options]        scan, summarize, confirm, upload
  npx @beon-tech/ai-score login            sign in through your browser
  npx @beon-tech/ai-score logout           forget the cached token
  npx @beon-tech/ai-score whoami           show who this machine is signed in as

Scans local session data from Claude Code, Codex, OpenCode and pi, normalizes
it into structural metadata (tool names, model ids, counts, timestamps, hashed
ids — never code, prompts, file paths or message text) and submits it to the
Beon scoring service. Submissions are attributed to the account you sign in
as; the server derives your identity from the token, so nothing about your
identity is taken from this machine.

Options
  --days <n>          look-back window in days (default: 30)
  --harness <names>   comma-separated subset: claude-code,codex,opencode,pi
  --url <url>         ai-score server (default: $AI_SCORE_URL or
                      ${DEFAULT_BASE_URL})
  --no-browser        print the login URL instead of opening a browser

Audit / consent
  --audit             print the exact JSON payload that would be uploaded
  --out <file>        write the payload to a file for inspection
  --dry-run           extract and summarize, but never touch the network
  --yes               skip the interactive upload confirmation

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
      days: { type: "string", default: "30" },
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

  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new Error(`--days must be a number between 1 and 365, got "${values.days}"`);
  }

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

  const harnesses = [];
  try {
    for (const adapter of selected) {
      progress.begin(adapter.harness);
      const report = await adapter.collect({ since, now, verbose });
      progress.end(adapter.harness, scanDetail(report));
      harnesses.push(report);
    }
  } finally {
    // Always erase the block and restore the cursor, including on a throw.
    progress.finish();
  }

  const payload: Payload = {
    schema: "beon.ai-score.v2",
    client: { name: "@beon-tech/ai-score", version },
    generatedAt: now.toISOString(),
    window: { days, start: since.toISOString(), end: now.toISOString() },
    engineer: { machineId },
    platform: { os: process.platform, arch: process.arch, node: process.versions.node },
    harnesses,
  };

  process.stderr.write(renderReport(payload));
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

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      throw new Error("refusing to upload without confirmation — pass --yes, or use --dry-run");
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (
      await rl.question(
        `  ${c.text("Upload this report?")} ${c.faint(new URL(target.submissionsUrl).host)} ${c.faint("[y/N]")} `,
      )
    )
      .trim()
      .toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      process.stderr.write(
        `\n  ${c.faint("aborted — nothing was uploaded. --audit shows the exact payload.")}\n\n`,
      );
      return;
    }
    process.stderr.write("\n");
  }

  try {
    const { status, result } = await send(target.submissionsUrl, payload, token);
    // The server returns a per-dimension breakdown; render it rather than
    // printing the first 200 characters of the response object.
    if (result.score) process.stderr.write(renderScore(result.score, result.id));
    else process.stderr.write(renderUploaded(status, result.id));
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
