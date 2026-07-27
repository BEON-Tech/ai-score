# Wire format — `beon.ai-score.v1`

This document is the complete specification of what `@beon/ai-score` sends over
the network. If a field is not listed here, it is not collected. You can verify
this yourself at any time:

```sh
npx @beon/ai-score --dry-run --audit   # prints the exact payload, sends nothing
```

## Guarantees

The payload **never** contains:

- source code, diffs, or file contents
- prompts, assistant responses, or any message text
- file paths or directory names from your projects (project identity is a
  16-char SHA-256 prefix of the path — one-way, not reversible)
- git branch names, commit messages, repo names, or PR titles (only counts)
- tool arguments or tool outputs (only tool *names* and counts)
- environment variables, hostnames, or usernames (machine identity is a
  16-char SHA-256 prefix of `hostname:username`)

The payload **does** contain: tool names, model ids, token counts, cost totals
where the harness records them, timestamps, mode/policy enum values, harness
version strings, your email (for attribution), and one-way hashes.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"beon.ai-score.v1"` | format version; bump on breaking change |
| `client` | `{ name, version }` | this CLI's package name and version |
| `generatedAt` | ISO 8601 | when extraction ran |
| `window` | `{ days, start, end }` | look-back window that was scanned |
| `engineer.email` | string \| null | `--email` flag, else `git config user.email` |
| `engineer.machineId` | string | `sha256(hostname:username)` first 16 hex chars |
| `platform` | `{ os, arch, node }` | e.g. `darwin`, `arm64`, `24.1.0` |
| `harnesses` | `HarnessReport[]` | one entry per supported harness |

## `HarnessReport`

| Field | Type | Meaning |
|---|---|---|
| `harness` | `claude-code` \| `codex` \| `opencode` \| `pi` | |
| `detected` | boolean | whether the harness's data directory exists |
| `dataPath` | string | fixed, well-known location that was scanned (e.g. `~/.claude/projects`) |
| `latestVersion` | string \| null | most recent harness version seen in the data |
| `sessionsScanned` | number | sessions on disk (all time) |
| `sessionsIncluded` | number | sessions inside the window |
| `parseErrors` | number | records that failed to parse and were skipped |
| `skippedReason` | string \| null | why a detected harness produced no data (e.g. Node too old for `node:sqlite`) |
| `sessions` | `SessionRecord[]` | |

## `SessionRecord`

| Field | Type | Meaning |
|---|---|---|
| `id` | string | 16-char SHA-256 prefix of the native session id |
| `projectId` | string | 16-char SHA-256 prefix of the project path — groups sessions by project without revealing the path |
| `startedAt` / `endedAt` | ISO 8601 \| null | first/last record timestamp |
| `isSubagent` | boolean | session spawned by another session |
| `counts.userPrompts` | number | real human prompts (excludes tool results, meta records, subagent sidechains) |
| `counts.assistantMessages` | number | assistant API responses |
| `counts.toolCalls` | number | total tool invocations |
| `counts.toolErrors` | number | tool invocations that errored (where the harness records it) |
| `counts.toolDenials` | number | permission prompts the user rejected |
| `counts.interruptions` | number | times the user aborted the agent mid-turn |
| `tools` | `{ [toolName]: count }` | tool **names** only, never arguments or outputs |
| `models` | `{ [modelId]: TokenUsage }` | per-model token totals |
| `costUsd` | number \| null | cost where the harness records it (OpenCode, pi) |
| `flags` | object | harness-specific structural signals, see below |
| `agentic.turns` | number | user-initiated turns |
| `agentic.maxToolCallsPerTurn` | number | longest uninterrupted tool-call run in one turn |
| `agentic.longestTurnMs` | number \| null | wall-clock length of the longest turn |
| `outcome.prLinks` | number | PRs the harness linked to the session (count only) |
| `outcome.filesChanged` / `additions` / `deletions` | number \| null | OpenCode session diff summary (counts only) |
| `outcome.distinctGitBranches` | number \| null | how many branches the session touched (names are not sent) |

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
- **opencode**: `agents` (agent mode names)
- **pi**: none yet

## Windowing

A session is included when its file was modified (or DB row updated) inside the
window **and** its last record timestamp is inside the window. Sessions that
started before the window but continued into it are included whole.
