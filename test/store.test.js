import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  clearCredential,
  credentialPath,
  readCredential,
  writeCredential,
} from "../dist/auth/store.js";

// The store reads XDG_CONFIG_HOME on every call, so pointing it at a temp dir
// keeps these tests away from the real ~/.config/beon.
let sandbox;
let previousXdg;

beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
  sandbox = mkdtempSync(join(tmpdir(), "ai-score-store-"));
  process.env.XDG_CONFIG_HOME = sandbox;
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(sandbox, { recursive: true, force: true });
});

const credential = (token) => ({ token, expiresAt: null, identity: null });

describe("credential store", () => {
  it("round-trips a credential", () => {
    writeCredential("https://a.example.com", credential("tok-a"));
    assert.equal(readCredential("https://a.example.com").token, "tok-a");
  });

  it("returns null when nothing is stored", () => {
    assert.equal(readCredential("https://a.example.com"), null);
  });

  // The whole point of keying by origin: a dev token must never be sent to prod.
  it("isolates credentials per origin", () => {
    writeCredential("https://a.example.com", credential("tok-a"));
    writeCredential("http://localhost:3000", credential("tok-local"));
    assert.equal(readCredential("https://a.example.com").token, "tok-a");
    assert.equal(readCredential("http://localhost:3000").token, "tok-local");
    assert.equal(readCredential("https://b.example.com"), null);
  });

  it("writes the credential file readable only by the owner", () => {
    writeCredential("https://a.example.com", credential("tok-a"));
    assert.equal(statSync(credentialPath()).mode & 0o777, 0o600);
  });

  it("tightens permissions on a pre-existing loose file", () => {
    writeCredential("https://a.example.com", credential("tok-a"));
    // Simulate a file left world-readable by an older version.
    chmodSync(credentialPath(), 0o644);
    writeCredential("https://a.example.com", credential("tok-b"));
    assert.equal(statSync(credentialPath()).mode & 0o777, 0o600);
  });

  it("treats an expired credential as absent", () => {
    writeCredential("https://a.example.com", {
      token: "tok-old",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      identity: null,
    });
    assert.equal(readCredential("https://a.example.com"), null);
  });

  it("keeps a credential that has not expired yet", () => {
    writeCredential("https://a.example.com", {
      token: "tok-new",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      identity: null,
    });
    assert.equal(readCredential("https://a.example.com").token, "tok-new");
  });

  it("clears only the requested origin", () => {
    writeCredential("https://a.example.com", credential("tok-a"));
    writeCredential("http://localhost:3000", credential("tok-local"));
    assert.equal(clearCredential("https://a.example.com"), true);
    assert.equal(readCredential("https://a.example.com"), null);
    assert.equal(readCredential("http://localhost:3000").token, "tok-local");
  });

  it("reports when there was nothing to clear", () => {
    assert.equal(clearCredential("https://a.example.com"), false);
  });

  // A truncated or hand-edited file should mean "log in again", not a crash
  // in the middle of an otherwise successful extraction.
  it("survives a corrupt credential file", () => {
    writeCredential("https://a.example.com", credential("tok-a"));
    writeFileSync(credentialPath(), "{not json");
    assert.equal(readCredential("https://a.example.com"), null);
  });

  it("ignores an entry with no token", () => {
    writeCredential("https://a.example.com", credential("tok-a"));
    writeFileSync(credentialPath(), JSON.stringify({ "https://a.example.com": { token: "" } }));
    assert.equal(readCredential("https://a.example.com"), null);
  });
});
