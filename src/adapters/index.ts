import type { Adapter } from "../types.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { copilotCli } from "./copilot-cli.js";
import { copilotIde } from "./copilot-ide.js";
import { cursorCli } from "./cursor-cli.js";
import { cursorIde } from "./cursor-ide.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";

export const adapters: Adapter[] = [
  claudeCode,
  codex,
  copilotCli,
  copilotIde,
  cursorCli,
  cursorIde,
  opencode,
  pi,
];
