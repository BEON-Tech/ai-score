# @beon/ai-score

One-shot CLI that measures how an engineer uses AI coding tools. It scans the
session data that coding harnesses already keep on your machine, normalizes it
into structural metadata, and submits it to Beon's scoring service, where the
score is computed server-side.

```sh
npx @beon/ai-score              # scan, summarize, confirm, upload
npx @beon/ai-score --dry-run    # scan and summarize only — never touches the network
npx @beon/ai-score --audit      # print the exact JSON that would be uploaded
```

## Supported harnesses

| Harness | Source scanned |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` (+ `archived_sessions`) |
| OpenCode | `~/.local/share/opencode/opencode.db` (requires Node ≥ 22.5 for `node:sqlite`) |
| pi | `~/.pi/agent/sessions/**/*.jsonl` |

Everything is read-only. The CLI never modifies harness data.

## Privacy model

All processing happens on-device. What leaves your machine is structural
metadata only: tool names, model ids, token/cost counts, timestamps, enum
flags, and one-way hashes of session/project identifiers. **No code, prompts,
message text, file paths, branch names, or tool arguments — ever.** The full
field-by-field contract is in [WIRE_FORMAT.md](./WIRE_FORMAT.md); anything not
listed there is not collected.

You can hold the tool to that promise before anything is sent:

```sh
npx @beon/ai-score --dry-run --audit          # inspect payload in the terminal
npx @beon/ai-score --dry-run --out report.json # or write it to a file
```

Uploading always requires explicit confirmation (interactive `y/N`, or an
explicit `--yes` in scripts). This package has zero runtime dependencies, so
auditing the code means reading `src/` and nothing else.

## Options

```
--days <n>          look-back window in days (default: 30)
--harness <names>   comma-separated subset: claude-code,codex,opencode,pi
--email <email>     engineer identity (default: git config user.email)
--endpoint <url>    override $AI_SCORE_ENDPOINT / the default endpoint
--audit             print the exact JSON payload
--out <file>        write the payload to a file
--dry-run           never touch the network
--yes               skip the interactive upload confirmation
--verbose           log each session file as it is parsed
```

## Architecture

```
src/
  cli.ts             argument parsing, orchestration, consent, upload
  types.ts           the beon.ai-score.v1 wire format
  adapters/
    claude-code.ts   one adapter per harness — each translates its native
    codex.ts         on-disk format into the common SessionRecord shape
    opencode.ts
    pi.ts
  summary.ts         human-readable terminal summary
  send.ts            the single network chokepoint (one POST)
```

Design rules:

- **The client is dumb on purpose.** It extracts and normalizes; all scoring,
  weighting, and cross-harness calibration live server-side. The algorithm can
  change without engineers re-running anything, and historical submissions can
  be re-scored.
- **Adapters are defensive.** Harness log formats are undocumented internals
  that change between versions. Unparseable records are skipped and counted
  (`parseErrors`), never fatal.
- **One network chokepoint.** `send.ts` is the only file that talks to the
  network, which keeps the audit surface small.

### Adding a harness

Implement the `Adapter` interface in `src/adapters/<name>.ts`, register it in
`src/adapters/index.ts`, add the `HarnessName` union member in `types.ts`, and
document any new `flags` in `WIRE_FORMAT.md`. Only emit names, counts,
timestamps, enums, and hashes — never free text from the logs.

## Server contract

The CLI POSTs the payload as JSON to `$AI_SCORE_ENDPOINT` (default
`https://ai-score.beon.tech/api/v1/submissions`) and treats any 2xx as success.
The ingest endpoint should validate `schema === "beon.ai-score.v1"`, store the
raw submission, and compute scores asynchronously so the algorithm can evolve
independently of the client.

## Development

```sh
pnpm install
pnpm build
node dist/cli.js --dry-run --verbose
```
