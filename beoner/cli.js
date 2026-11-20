#!/usr/bin/env node
// @beon-tech/beoner-ai-score: the AI Workflow Score CLI for BEONers.
//
// It is @beon-tech/ai-score with `--beon` always on — sign in with your BEON
// Google account, so every run reaches AI Coding Pulse under your name — and
// nothing else. All scanning, privacy filtering and upload logic lives in
// @beon-tech/ai-score, pinned to the same version this package was released
// with, so the two never drift.
//
// A separate package rather than a flag to remember: a BEONer who reruns the
// plain command from memory would upload to their GitHub account instead.

process.env.AI_SCORE_INVOKED_AS ??= "npx @beon-tech/beoner-ai-score";
if (!process.argv.includes("--beon")) process.argv.splice(2, 0, "--beon");

await import("@beon-tech/ai-score/dist/cli.js");
