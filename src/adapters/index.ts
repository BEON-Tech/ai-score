import type { Adapter } from "../types.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";

export const adapters: Adapter[] = [claudeCode, codex, opencode, pi];
