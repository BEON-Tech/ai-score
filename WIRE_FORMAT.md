# Wire format — `beon.ai-score.v2`

This document is the complete specification of what `@beon-tech/ai-score` sends over
the network. If a field is not listed here, it is not collected. You can verify
this yourself at any time:

```sh
npx @beon-tech/ai-score --dry-run --audit   # prints the exact payload, sends nothing
```

## Changes in v2

`engineer.email` is gone. v1 asserted the submitter's identity in the payload
body, with nothing on the server able to verify it. v2 sends an access token
instead and the server resolves identity from it, so the client no longer
claims to be anyone. See [Request headers](#request-headers).

`workflow` was later added as an optional, backward-compatible session field.
The CLI derives it locally from ordered tool calls and structured result
statuses. Older v2 payloads without it remain valid.

## Request headers

The payload is not the only thing on the wire, so for completeness:

| Header          | Value                                                     |
| --------------- | --------------------------------------------------------- |
| `content-type`  | `application/json`                                        |
| `user-agent`    | `beon-ai-score/<client version>`                          |
| `authorization` | `Bearer <token>` — issued by Beon, obtained by signing in |

The token is a Beon session token, cached at `~/.config/beon/ai-score.json`
with `0600` permissions. It is never a GitHub or GitLab credential: the
provider handshake happens in your browser, and this CLI never sees its result.
Obtaining it involves two further requests, which carry no payload and no
personal data — `POST /api/auth/device/code` and `POST /api/auth/device/token`.

## Guarantees

The payload **never** contains:

- source code, diffs, or file contents
- prompts, assistant responses, or any message text
- file paths or directory names from your projects (project identity is a
  16-char SHA-256 prefix of the path — one-way, not reversible)
- git branch names, commit messages, repo names, or PR titles (only counts)
- tool arguments or tool outputs (only tool _names_ and counts)
- environment variables, hostnames, or usernames (machine identity is a
  16-char SHA-256 prefix of `hostname:username`)
- your email, name, or any other identity field — the payload says nothing
  about who you are; attribution comes from the access token in the
  `authorization` header

The payload **does** contain: tool names, model ids, token counts, cost totals
where the harness records them, timestamps, mode/policy enum values, harness
version strings, one-way hashes, and derived workflow enums. To derive those
enums the CLI transiently inspects tool arguments, result statuses, and — for
checks piped through filters like `tail`, where the exit code proves nothing —
the runner's own pass/fail summary line in the recorded output. Raw values are
immediately discarded and never serialized.

One local source outside harness data is consulted: **git history**, read-only,
to count the commits you made in a session's repository while it ran — the
delivery evidence a commit script or second terminal leaves outside the
transcript. The CLI reads `git config user.email` (to attribute commits to this
machine, never sent) and commit timestamps. What survives into the payload is a
single count per session (`outcome.localCommits`): no hashes, no messages, no
branch names, no repository paths.

## Top level

| Field                | Type                   | Meaning                                              |
| -------------------- | ---------------------- | ---------------------------------------------------- |
| `schema`             | `"beon.ai-score.v2"`   | format version; bump on breaking change              |
| `client`             | object                 | CLI name/version plus `workflowClassifierVersion: 2` |
| `generatedAt`        | ISO 8601               | when extraction ran                                  |
| `window`             | `{ days, start, end }` | look-back window that was scanned                    |
| `engineer.machineId` | string                 | `sha256(hostname:username)` first 16 hex chars       |
| `platform`           | `{ os, arch, node }`   | e.g. `darwin`, `arm64`, `24.1.0`                     |
| `harnesses`          | `HarnessReport[]`      | one entry per supported harness                      |

## `HarnessReport`

| Field              | Type                                                                                                             | Meaning                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `harness`          | `claude-code` \| `codex` \| `copilot-cli` \| `copilot-ide` \| `cursor-cli` \| `cursor-ide` \| `opencode` \| `pi` |                                                                               |
| `detected`         | boolean                                                                                                          | whether the harness's data directory exists                                   |
| `dataPath`         | string                                                                                                           | fixed, well-known location that was scanned (e.g. `~/.claude/projects`)       |
| `latestVersion`    | string \| null                                                                                                   | most recent harness version seen in the data                                  |
| `sessionsScanned`  | number                                                                                                           | sessions on disk (all time)                                                   |
| `sessionsIncluded` | number                                                                                                           | sessions inside the window                                                    |
| `parseErrors`      | number                                                                                                           | records that failed to parse and were skipped                                 |
| `skippedReason`    | string \| null                                                                                                   | why a detected harness produced no data (e.g. Node too old for `node:sqlite`) |
| `capabilities`     | object                                                                                                           | what this adapter can observe, per signal — see below                         |
| `sessions`         | `SessionRecord[]`                                                                                                |                                                                               |

### `capabilities`

A null in a session is ambiguous by construction: "didn't happen", "couldn't be
measured this run", and "this harness never records that" all serialize the
same way. The capability manifest is the disambiguation. Every report declares,
for each evidence signal, one of three values:

- `measured` — read from the harness's own records.
- `estimated` — derived by the CLI from what the harness does record (e.g.
  line counts implied by edit-tool arguments, banked only when the paired
  result succeeded). Null when nothing measurable fired.
- `unobservable` — the harness never records enough to produce the signal.
  **The server must not score its absence against the engineer**; the correct
  treatment is to renormalize the affected dimension over the signals that
  were observable.

The declared signals: `filesChanged`, `additions`, `deletions`, `prLinks`,
`distinctGitBranches`, `costUsd`, `cacheTokens`, `longestTurnMs`,
`toolErrors`, `toolDenials`, `interruptions`, `checkVerdicts`,
`localCommits`. `checkVerdicts` states
whether check output text reaches the workflow classifier, so piped checks
(`pnpm test | tail -8`) can settle on the runner's own summary line; where it
is `unobservable`, `finalVerification: "unknown"` is the format's ceiling, not
evidence about the engineer. The manifest lives in `src/capabilities.ts` and
must change in the same commit as the adapter behavior it describes; `--audit`
prints it with the rest of the payload.

## `SessionRecord`

| Field                                              | Type                        | Meaning                                                                                                                                                           |
| -------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                               | string                      | 16-char SHA-256 prefix of the native session id                                                                                                                   |
| `projectId`                                        | string                      | 16-char SHA-256 prefix of the project path — groups sessions by project without revealing the path                                                                |
| `startedAt` / `endedAt`                            | ISO 8601 \| null            | first/last record timestamp                                                                                                                                       |
| `isSubagent`                                       | boolean                     | session spawned by another session                                                                                                                                |
| `counts.userPrompts`                               | number                      | real human prompts (excludes tool results, meta records, subagent sidechains)                                                                                     |
| `counts.assistantMessages`                         | number                      | assistant API responses                                                                                                                                           |
| `counts.toolCalls`                                 | number                      | total tool invocations                                                                                                                                            |
| `counts.toolErrors`                                | number                      | tool invocations that errored (where the harness records it)                                                                                                      |
| `counts.toolDenials`                               | number                      | permission prompts the user rejected                                                                                                                              |
| `counts.interruptions`                             | number                      | times the user aborted the agent mid-turn                                                                                                                         |
| `tools`                                            | `{ [toolName]: count }`     | tool **names** only, never arguments or outputs                                                                                                                   |
| `models`                                           | `{ [modelId]: TokenUsage }` | per-model token totals                                                                                                                                            |
| `costUsd`                                          | number \| null              | cost where the harness records it (OpenCode, pi, Cursor's separately billed requests)                                                                             |
| `flags`                                            | object                      | harness-specific structural signals, see below                                                                                                                    |
| `agentic.turns`                                    | number                      | user-initiated turns                                                                                                                                              |
| `agentic.maxToolCallsPerTurn`                      | number                      | longest uninterrupted tool-call run in one turn                                                                                                                   |
| `agentic.longestTurnMs`                            | number \| null              | wall-clock length of the longest turn                                                                                                                             |
| `outcome.prLinks`                                  | number                      | PRs the harness linked to the session (count only)                                                                                                                |
| `outcome.filesChanged` / `additions` / `deletions` | number \| null              | session diff summary — native where the harness records one, estimated from edit-tool arguments elsewhere; the report's `capabilities` says which                 |
| `outcome.distinctGitBranches`                      | number \| null              | how many branches the session touched (names are not sent)                                                                                                        |
| `outcome.localCommits`                             | number \| null              | commits by this machine's git identity in the session's repo during the session (+30 min slack), read from local git history — count only; null when unmeasurable |
| `workflow`                                         | object                      | optional privacy-safe edit/check evidence derived locally; see below                                                                                              |

### `workflow`

Present in reports produced by clients with workflow classification support:

| Field                      | Type                                           | Meaning                                                                 |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `classifierVersion`        | `2`                                            | local classifier contract version                                       |
| `codeChange`               | `success` \| `failure` \| `none` \| `unknown`  | whether a code-mutating tool produced an observable change              |
| `sequenceKnown`            | boolean                                        | whether native records preserved reliable event order                   |
| `finalVerification`        | `passed` \| `failed` \| `not-run` \| `unknown` | state of checks after the final successful code change                  |
| `stalePass`                | boolean \| null                                | final change unchecked, but a check passed after an earlier change      |
| `autonomousVerifiedChange` | boolean \| null                                | whether final change and passing check occurred in one human turn       |
| `recoveredFromFailure`     | boolean \| null                                | whether a failed check was followed by another change and passing check |
| `delivery`                 | `observed` \| `not-observed` \| `unknown`      | successful commit/PR evidence visible inside the harness                |
| `verificationKinds`        | (`test` \| `typecheck` \| `build` \| `lint`)[] | categories observed, never command text                                 |

`unknown` is materially different from a negative result. It means the native
harness did not expose enough ordering, arguments, or structured outcome data
to make the claim. The server must not label it as an observed failure or drop
it from consideration. It remains visible in evidence coverage and the
coding-session denominator.

Two denominator rules the scorer is expected to honor:

- Sessions with `codeChange: "none"` — research, docs, Q&A — are not
  verification candidates. They must not dilute verified-completion or
  coverage ratios; there was nothing to verify.
- Where the report's `capabilities` declares a signal `unobservable`, the
  affected dimension should be renormalized over the observable signals
  rather than scoring the structural blank as a zero.

Classifier v2 changes, all three aimed at patterns v1 misread as opaque or
mutating:

- Writes to **agent-state paths** — dot-directories under the home directory
  (`~/.claude/…` memory notes, harness config) and OS temp directories
  (scratchpads) — are observations, not code changes, unless the path sits
  inside the session's own working directory. v1 counted them as mutations,
  which turned note-taking sessions into "unverified coding sessions" and let
  an end-of-session memory note invalidate checks that had already passed.
- **Heredoc bodies** are stdin data, not commands: quoted-delimiter heredocs
  (`git commit -F - <<'EOF'`) and expansion-free unquoted ones no longer make
  the whole command opaque.
- **Verify-and-ship chains** (`checks && git commit && git push`) record the
  checks as verification evidence alongside the delivery instead of
  discarding them; the checks are certified only when provable (exit-gated by
  `&&`, or failure-marked with the stream end preserved).

### `TokenUsage`

`{ input, output, cacheRead, cacheWrite, reasoning }` — token counts as
natively reported by each harness. Semantics differ slightly per harness
(e.g. Codex's `input` includes cached tokens; Claude Code's does not).
Normalization is deliberately the server's job; the client reports raw values.

### `flags` by harness

Values are numbers, booleans, or arrays of harness-defined enum values.

- **claude-code**: `modes` (e.g. `plan`), `permissionModes`, `sidechainMessages`,
  `subagentRuns`, `hookEvents`, `compactions`, `slashCommands`, `mcpCalls`
- **codex**: `models`, `efforts`, `approvalPolicies`, `collaborationModes`,
  `mcpCalls`, `errors`, `gitRepo`
- **cursor-cli**: `modes`, `models`, `mcpCalls`, `reasoningBlocks`
- **cursor-ide**: `modes` (`agent`, `chat`, `plan`), `models`, `mcpCalls`,
  `maxMode`, `isAgentic`, `billedRequests`, `thinkingBlocks`
- **opencode**: `agents` (agent mode names)
- **pi**: none yet

## Cursor

Cursor is two harnesses because it is two products with unrelated storage, and
neither records everything the others do. What each one can and cannot report:

| Field                    | `cursor-cli`                                 | `cursor-ide`                                      |
| ------------------------ | -------------------------------------------- | ------------------------------------------------- |
| `models` token counts    | **none** — model id with a zero usage bucket | `input` / `output` per model (no cache split)     |
| `costUsd`                | never recorded                               | separately billed requests only; `null` otherwise |
| `startedAt` / `endedAt`  | store creation time → file mtime             | composer `createdAt` → `lastUpdatedAt`            |
| `agentic.longestTurnMs`  | **null** — messages carry no clock           | from the per-request client timings               |
| `counts.toolErrors`      | not recorded                                 | tool status `error`                               |
| `counts.toolDenials`     | not recorded                                 | tool decision `rejected`                          |
| `counts.interruptions`   | not recorded                                 | tool status `cancelled`                           |
| `outcome.additions` etc. | estimated from successful edit-call args     | composer diff totals                              |
| `outcome.localCommits`   | never — the store hides the working dir      | from the workspace folder's git history           |
| `projectId`              | hash of Cursor's own project key             | hash of the workspace folder path                 |

Two consequences worth stating plainly:

- **Project ids do not line up across the two.** The CLI never writes the
  working directory down — only its own opaque key for it — so the same repo
  hashes differently under `cursor-cli` than under `cursor-ide` or any other
  harness. Recovering the path would mean guessing at it, which is worse.
- **`counts.assistantMessages` is a reply count, not a bubble count.** The
  desktop app emits a separate message for every tool call and every block of
  thinking; counting those would inflate the figure several-fold against
  harnesses that record one message per API response. Only messages carrying
  assistant prose are counted, with the rest in `counts.toolCalls` and
  `flags.thinkingBlocks`.

Nothing from Cursor's `~/.cursor/ai-tracking` database — which stores commit
messages, file paths and conversation summaries — is read at all.

## Windowing

A session is included when its file was modified (or DB row updated) inside the
window **and** its last record timestamp is inside the window. Sessions that
started before the window but continued into it are included whole.

`sessionsScanned` counts sessions that still exist. Cursor keeps the key of a
deleted chat around holding `null`; those tombstones count as neither a session
nor a parse error.
