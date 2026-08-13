import type { HarnessCapabilities, HarnessName } from "./types.js";

/**
 * What each adapter can actually observe, declared on the wire so the server
 * renormalizes over observable signals instead of inferring capability from
 * nulls. `additions: null` used to mean three different facts with one
 * representation — "no edit succeeded" (claude-code), "never measurable"
 * (cursor-cli), "structurally absent" (copilot-ide). This table is the
 * disambiguation, and it must change in the same commit as the adapter
 * behavior it describes.
 *
 * The values state what the shipped adapter produces, not what the native
 * format could theoretically yield: a signal the format records but this
 * adapter does not read is `unobservable` until the adapter reads it.
 */
export const CAPABILITIES: Record<HarnessName, HarnessCapabilities> = {
  "claude-code": {
    // No native diff summary; sizes are implied by Edit/Write arguments and
    // banked only when the paired result succeeds.
    filesChanged: "estimated",
    additions: "estimated",
    deletions: "estimated",
    prLinks: "measured",
    distinctGitBranches: "measured",
    costUsd: "unobservable",
    cacheTokens: "measured",
    longestTurnMs: "measured",
    // Result blocks mark errors, but the count currently stays at zero —
    // declared unobservable so a zero is never read as "no errors".
    toolErrors: "unobservable",
    toolDenials: "measured",
    interruptions: "measured",
    checkVerdicts: "measured",
    localCommits: "measured",
  },
  codex: {
    filesChanged: "estimated",
    additions: "estimated",
    deletions: "estimated",
    prLinks: "unobservable",
    distinctGitBranches: "unobservable",
    costUsd: "unobservable",
    cacheTokens: "measured",
    longestTurnMs: "measured",
    toolErrors: "unobservable",
    toolDenials: "unobservable",
    interruptions: "measured",
    checkVerdicts: "measured",
    localCommits: "measured",
  },
  "copilot-cli": {
    // `session.shutdown` carries real diff stats; a crashed session falls
    // back to the same argument-implied estimate as claude-code.
    filesChanged: "measured",
    additions: "measured",
    deletions: "measured",
    prLinks: "unobservable",
    distinctGitBranches: "measured",
    costUsd: "unobservable",
    cacheTokens: "measured",
    longestTurnMs: "measured",
    toolErrors: "measured",
    toolDenials: "measured",
    interruptions: "measured",
    checkVerdicts: "measured",
    localCommits: "measured",
  },
  "copilot-ide": {
    // Distinct edited-file URIs; the serialized format never stores line
    // counts or tool output text, so those are the data's ceiling.
    filesChanged: "estimated",
    additions: "unobservable",
    deletions: "unobservable",
    prLinks: "measured",
    distinctGitBranches: "unobservable",
    costUsd: "unobservable",
    cacheTokens: "unobservable",
    longestTurnMs: "measured",
    toolErrors: "unobservable",
    toolDenials: "measured",
    interruptions: "measured",
    checkVerdicts: "unobservable",
    localCommits: "measured",
  },
  "cursor-cli": {
    filesChanged: "estimated",
    additions: "estimated",
    deletions: "estimated",
    prLinks: "unobservable",
    distinctGitBranches: "unobservable",
    costUsd: "unobservable",
    cacheTokens: "unobservable",
    // Messages carry no clock, and the store never writes the working
    // directory down — only its own opaque key for it.
    longestTurnMs: "unobservable",
    toolErrors: "unobservable",
    toolDenials: "unobservable",
    interruptions: "unobservable",
    checkVerdicts: "measured",
    localCommits: "unobservable",
  },
  "cursor-ide": {
    filesChanged: "measured",
    additions: "measured",
    deletions: "measured",
    prLinks: "measured",
    distinctGitBranches: "unobservable",
    costUsd: "measured",
    cacheTokens: "unobservable",
    longestTurnMs: "measured",
    toolErrors: "measured",
    toolDenials: "measured",
    interruptions: "measured",
    checkVerdicts: "measured",
    localCommits: "measured",
  },
  opencode: {
    filesChanged: "measured",
    additions: "measured",
    deletions: "measured",
    prLinks: "unobservable",
    distinctGitBranches: "unobservable",
    costUsd: "measured",
    cacheTokens: "measured",
    longestTurnMs: "unobservable",
    toolErrors: "measured",
    toolDenials: "unobservable",
    interruptions: "unobservable",
    checkVerdicts: "measured",
    localCommits: "measured",
  },
  pi: {
    filesChanged: "estimated",
    additions: "estimated",
    deletions: "estimated",
    prLinks: "unobservable",
    distinctGitBranches: "unobservable",
    costUsd: "measured",
    cacheTokens: "measured",
    longestTurnMs: "measured",
    toolErrors: "measured",
    toolDenials: "unobservable",
    interruptions: "measured",
    checkVerdicts: "measured",
    localCommits: "measured",
  },
};
