#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { adapters } from './adapters/index.js';
import { send } from './send.js';
import { renderSummary } from './summary.js';
import type { HarnessName, Payload } from './types.js';
import { hash16 } from './util.js';

const DEFAULT_ENDPOINT = 'https://ai-score.beon.tech/api/v1/submissions';

const HELP = `ai-score — extract AI coding harness usage into an auditable report

Usage
  npx @beon/ai-score [options]

Scans local session data from Claude Code, Codex, OpenCode and pi, normalizes
it into structural metadata (tool names, model ids, counts, timestamps, hashed
ids — never code, prompts, file paths or message text) and submits it to the
Beon scoring service.

Options
  --days <n>          look-back window in days (default: 30)
  --harness <names>   comma-separated subset: claude-code,codex,opencode,pi
  --email <email>     engineer identity (default: git config user.email)
  --endpoint <url>    submission endpoint (default: $AI_SCORE_ENDPOINT or
                      ${DEFAULT_ENDPOINT})

Audit / consent
  --audit             print the exact JSON payload that would be uploaded
  --out <file>        write the payload to a file for inspection
  --dry-run           extract and summarize, but never touch the network
  --yes               skip the interactive upload confirmation

Other
  --verbose           log every session file as it is parsed
  --version           print version
  --help              show this help
`;

function ownVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version);
  } catch {
    return '0.0.0';
  }
}

function gitEmail(): string | null {
  try {
    const email = execSync('git config user.email', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return email || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      days: { type: 'string', default: '30' },
      harness: { type: 'string', multiple: true },
      email: { type: 'string' },
      endpoint: { type: 'string' },
      out: { type: 'string' },
      audit: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
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

  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new Error(`--days must be a number between 1 and 365, got "${values.days}"`);
  }

  const known = adapters.map((a) => a.harness);
  const requested = values.harness?.flatMap((v) => v.split(',').map((s) => s.trim())).filter(Boolean);
  if (requested) {
    const unknown = requested.filter((h) => !known.includes(h as HarnessName));
    if (unknown.length > 0) {
      throw new Error(`unknown harness "${unknown.join(', ')}" — valid values: ${known.join(', ')}`);
    }
  }
  const selected = requested
    ? adapters.filter((a) => requested.includes(a.harness))
    : adapters;

  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const verbose = values.verbose ? (msg: string) => process.stderr.write(`${msg}\n`) : () => {};

  process.stderr.write(`scanning ${selected.map((a) => a.harness).join(', ')}…\n`);
  const harnesses = [];
  for (const adapter of selected) {
    harnesses.push(await adapter.collect({ since, now, verbose }));
  }

  const payload: Payload = {
    schema: 'beon.ai-score.v1',
    client: { name: '@beon/ai-score', version },
    generatedAt: now.toISOString(),
    window: { days, start: since.toISOString(), end: now.toISOString() },
    engineer: {
      email: values.email ?? gitEmail(),
      machineId: hash16(`${os.hostname()}:${os.userInfo().username}`),
    },
    platform: { os: process.platform, arch: process.arch, node: process.versions.node },
    harnesses,
  };

  process.stderr.write(renderSummary(payload));

  const json = JSON.stringify(payload, null, 2);
  if (values.out) {
    writeFileSync(values.out, json);
    process.stderr.write(`payload written to ${values.out}\n`);
  }
  if (values.audit) {
    process.stdout.write(`${json}\n`);
  }

  if (values['dry-run']) {
    process.stderr.write('dry run — nothing was uploaded.\n');
    return;
  }

  const endpoint = values.endpoint ?? process.env.AI_SCORE_ENDPOINT ?? DEFAULT_ENDPOINT;
  if (!payload.engineer.email) {
    throw new Error('no email found — pass --email you@beon.tech so the submission can be attributed');
  }
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('refusing to upload without confirmation — pass --yes, or use --dry-run');
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`upload this report to ${endpoint}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      process.stderr.write('aborted — nothing was uploaded. Tip: --audit shows the exact payload.\n');
      return;
    }
  }

  const result = await send(endpoint, payload);
  process.stderr.write(`uploaded (HTTP ${result.status}). ${result.body.slice(0, 200)}\n`);
}

main().catch((err: Error) => {
  process.stderr.write(`ai-score: ${err.message}\n`);
  process.exit(1);
});
