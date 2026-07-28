import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../util.js";
import type { Credential } from "./types.js";

/**
 * Credentials live in one file keyed by server origin, so a token for a local
 * dev server can never be sent to production (or vice versa).
 */
type CredentialFile = Record<string, Credential>;

export function credentialDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "beon") : home(".config", "beon");
}

export function credentialPath(): string {
  return join(credentialDir(), "ai-score.json");
}

function readAll(): CredentialFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CredentialFile;
    }
  } catch {
    // Missing, unreadable or corrupt — treat as "not logged in" rather than
    // failing the run. Worst case the engineer logs in again.
  }
  return {};
}

function writeAll(file: CredentialFile): void {
  mkdirSync(credentialDir(), { recursive: true, mode: 0o700 });
  const path = credentialPath();
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // `mode` above only applies when the file is created, so an existing file
  // with looser permissions would keep them.
  chmodSync(path, 0o600);
}

export function readCredential(origin: string): Credential | null {
  const stored = readAll()[origin];
  if (!stored || typeof stored.token !== "string" || stored.token === "") return null;
  if (stored.expiresAt !== null && Date.parse(stored.expiresAt) <= Date.now()) return null;
  return stored;
}

export function writeCredential(origin: string, credential: Credential): void {
  const file = readAll();
  file[origin] = credential;
  writeAll(file);
}

/** Returns whether anything was actually removed. */
export function clearCredential(origin: string): boolean {
  const file = readAll();
  if (!(origin in file)) return false;
  delete file[origin];
  if (Object.keys(file).length === 0) {
    rmSync(credentialPath(), { force: true });
  } else {
    writeAll(file);
  }
  return true;
}
