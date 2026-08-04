# @beon-tech/ai-score

CLI that measures how an engineer uses AI coding tools. It scans the session
data that coding harnesses already keep on your machine, derives privacy-safe
edit/check evidence, and submits it to Beon's scoring service. The server
returns a Verified Workflow score plus a separate Usage Profile.

```sh
npx @beon-tech/ai-score              # sign in if needed, scan, summarize, confirm, upload
npx @beon-tech/ai-score --dry-run    # scan and summarize only — never touches the network
npx @beon-tech/ai-score --audit      # print the exact JSON that would be uploaded
```

Uploading requires signing in once per machine. The first upload opens your
browser automatically; you can also do it up front:

```sh
npx @beon-tech/ai-score login        # choose a provider in the browser, then close the tab
npx @beon-tech/ai-score whoami       # show which account this machine submits as
npx @beon-tech/ai-score logout       # forget the cached token
```

## Supported harnesses

| Harness      | Source scanned                                                              |
| ------------ | --------------------------------------------------------------------------- |
| Claude Code  | `~/.claude/projects/**/*.jsonl`                                             |
| Codex CLI    | `~/.codex/sessions/**/*.jsonl` (+ `archived_sessions`)                      |
| Cursor CLI   | `~/.cursor/chats/**/store.db` (`node:sqlite`)                               |
| Cursor (app) | Cursor's `globalStorage/state.vscdb` and `workspaceStorage` (`node:sqlite`) |
| OpenCode     | `~/.local/share/opencode/opencode.db` (`node:sqlite`)                       |
| pi           | `~/.pi/agent/sessions/**/*.jsonl`                                           |

Sources marked `node:sqlite` need Node ≥ 22.5; on older Node those harnesses
report a `skippedReason` and the rest of the scan proceeds.

Cursor ships two products that share a name and nothing else, so they report as
two harnesses — `cursor-cli` and `cursor-ide`. They record different things:
the desktop app tracks tokens, cost and per-session diff stats, while the CLI's
session store keeps neither timestamps per message nor token counts, so
`cursor-cli` sessions carry a model id with an empty usage bucket and no
`longestTurnMs`.

Harness data is read-only — the CLI never modifies it. The one thing it writes
outside of `--out` is your access token, cached in
`~/.config/beon/ai-score.json` with `0600` permissions.

## Authentication

Submissions are attributed to an account you sign in to, not to a string your
machine asserts. `login` uses the OAuth 2.0 device authorization grant
(RFC 8628): the CLI asks the server for a code, opens the approval page, and
polls until you approve. Because the browser does the provider handshake, the
CLI never holds a GitHub or GitLab credential — only a Beon-issued token — and
new providers can be added server-side without a new release of this package.

Compare the code in your terminal against the one on the page before
approving. If they differ, someone else sent you that link; deny it.

There is no local HTTP listener, so this works over SSH and inside containers.
Use `--no-browser` to print the URL instead of opening one, and
`AI_SCORE_TOKEN` for CI, where no browser can open at all:

```sh
AI_SCORE_TOKEN=… npx @beon-tech/ai-score --yes
```

## Privacy model

All classification happens on-device. The CLI transiently inspects tool
arguments, structured result statuses, and recorded check output (only to read
a test runner's own pass/fail summary when a pipe hid the exit code) to
recognize edits, tests, typechecks, builds, lint runs and delivery events,
then immediately discards the raw values.
What leaves your machine is structural metadata and derived enums only. **No
code, prompts, message text, file paths, branch names, raw commands, arguments,
or tool outputs are uploaded.** The full field-by-field contract is in
[WIRE_FORMAT.md](./WIRE_FORMAT.md).

Two things leave your machine besides the payload, both only when you sign in:
the device-flow exchange with `ai-score.beon.tech`, and the access token
presented on upload. Your provider account is verified in the browser, so no
provider credential ever reaches this CLI.

You can hold the tool to that promise before anything is sent:

```sh
npx @beon-tech/ai-score --dry-run --audit          # inspect payload in the terminal
npx @beon-tech/ai-score --dry-run --out report.json # or write it to a file
```

`--dry-run` needs no account and touches no network, so it works before you
ever sign in. Uploading always requires explicit confirmation (interactive
`y/N`, or an explicit `--yes` in scripts). This package has zero runtime
dependencies, so auditing the code means reading `src/` and nothing else.

## Commands and options

```
(no command)        scan, summarize, confirm, upload
login               sign in through the browser
logout              forget the cached token for this server
whoami              print the account this machine submits as
```

```
--days <n>          look-back window in days (default: 180)
--harness <names>   comma-separated subset: claude-code,codex,cursor-cli,
                    cursor-ide,opencode,pi
--url <url>         ai-score server (default: $AI_SCORE_URL or
                    https://ai-score.beon.tech)
--no-browser        print the login URL instead of opening a browser
--audit             print the exact JSON payload
--out <file>        write the payload to a file
--dry-run           never touch the network
--yes               skip the interactive upload confirmation
--endpoint <url>    deprecated: exact submissions URL, overrides --url
--verbose           log each session file as it is parsed
```

| Environment variable | Effect                                        |
| -------------------- | --------------------------------------------- |
| `AI_SCORE_TOKEN`     | use this token instead of signing in (for CI) |
| `AI_SCORE_URL`       | default server, same as `--url`               |
| `XDG_CONFIG_HOME`    | where the token is cached, if set             |

## Architecture

```
src/
  cli.ts             argument parsing, commands, orchestration, consent
  config.ts          resolves which server to talk to
  types.ts           the beon.ai-score.v2 wire format
  workflow.ts        local command classification and workflow reduction
  adapters/
    claude-code.ts   one adapter per harness — each translates its native
    codex.ts         on-disk format into the common SessionRecord shape
    cursor-cli.ts
    cursor-ide.ts
    opencode.ts
    pi.ts
  auth/
    index.ts         login/logout/whoami orchestration and token resolution
    client.ts        the credential chokepoint (device flow + session lookup)
    store.ts         the token cache, 0600, keyed by server origin
    browser.ts       best-effort browser launch
  summary.ts         human-readable terminal summary
  send.ts            the payload chokepoint (one POST)
```

Design rules:

- **The client derives evidence but never scores it.** It classifies native
  records into fixed workflow enums; all weighting and eligibility remain
  server-side. A classifier change requires engineers to rescan local history,
  while a score-weight change remains fully server-side.
- **Adapters are defensive.** Harness log formats are undocumented internals
  that change between versions. Unparseable records are skipped and counted
  (`parseErrors`), never fatal.
- **Two network chokepoints, with distinct jobs.** `send.ts` is the only file
  that sends a payload, and it never obtains credentials. `auth/client.ts` is
  the only file that obtains or presents credentials, and it never sees a
  payload. Auditing what leaves the machine means reading those two files.
- **The client asserts no identity.** It sends a token; the server decides who
  that is. Nothing in the payload says who you are, which is why provider
  support lives entirely on the server.

### Adding a harness

Implement the `Adapter` interface in `src/adapters/<name>.ts`, register it in
`src/adapters/index.ts`, add the `HarnessName` union member in `types.ts`, and
document any new fields in `WIRE_FORMAT.md`. Raw text may only be inspected
transiently by a local classifier; only names, counts, timestamps, enums and
hashes may enter `SessionRecord`.

### Adding a sign-in provider

Nothing to do here. The CLI has no provider code — it only knows how to run a
device flow against the server, and the server owns which providers exist. Add
the provider to the server's auth config and a button to its approval page;
engineers get it without updating this package.

## Server contract

The CLI POSTs the payload as JSON to `<server>/api/v1/submissions` with an
`Authorization: Bearer <token>` header, and treats any 2xx as success. A 401 or
403 means the token is dead: the CLI drops it and tells the engineer to log in
again. The ingest endpoint validates `schema === "beon.ai-score.v2"`, resolves
the submitter from the token (**never** from the payload), stores the raw
submission, and computes both results server-side so their weights can evolve
independently of the client. The response keeps `score` as the Usage Profile for
older clients and adds `verifiedWorkflow` for current clients.

Auth endpoints used, all under `<server>/api/auth`:
`POST /device/code`, `POST /device/token`, `GET /get-session`.

## Development

```sh
pnpm install
pnpm build
pnpm test
node dist/cli.js --dry-run --verbose

# against a local server
AI_SCORE_URL=http://localhost:3000 node dist/cli.js login
```

## Releasing

Every push to `main` automatically publishes a patch release via the
[release workflow](.github/workflows/release.yml): CI bumps the version,
builds, smoke-tests, publishes to npm, and pushes the release commit and
`vX.Y.Z` tag back — the tag only lands if the publish succeeded. For a minor
or major release, trigger the workflow manually instead:

```sh
gh workflow run Release --repo BEON-Tech/ai-score -f bump=minor
```

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
(GitHub Actions OIDC — no npm tokens anywhere), which attaches a provenance
attestation linking the published tarball to the exact commit and workflow run
that built it. Never bump versions locally.
