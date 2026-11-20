import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

/**
 * beoner/cli.js is what `npx @beon-tech/beoner-ai-score` runs: this CLI with
 * --beon always on. Installed the way npm would lay it out — the wrapper next
 * to a node_modules/@beon-tech/ai-score that is this repo — it must use the
 * BEON login, never the default one, and name its own command in hints.
 */
const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let sandbox;
let server;
let baseUrl;

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "beoner-wrapper-"));
  const scope = join(sandbox, "node_modules", "@beon-tech");
  mkdirSync(scope, { recursive: true });
  symlinkSync(repo, join(scope, "ai-score"), "dir");
  copyFileSync(join(repo, "beoner", "cli.js"), join(sandbox, "cli.js"));

  server = createServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    const user =
      token === "tok-beon"
        ? { id: "u2", name: "Ada", email: "ada@beon.tech" }
        : token === "tok-default"
          ? { id: "u1", name: "Ada", email: "ada@gmail.com" }
          : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(user ? { user } : null));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(sandbox, { recursive: true, force: true });
});

function wrapper(args, config) {
  const xdg = mkdtempSync(join(tmpdir(), "beoner-xdg-"));
  if (config) {
    mkdirSync(join(xdg, "beon"), { recursive: true });
    writeFileSync(join(xdg, "beon", "ai-score.json"), JSON.stringify(config));
  }
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, AI_SCORE_URL: baseUrl };
  delete env.AI_SCORE_TOKEN;
  return run(process.execPath, [join(sandbox, "cli.js"), ...args], { env }).finally(() =>
    rmSync(xdg, { recursive: true, force: true }),
  );
}

describe("@beon-tech/beoner-ai-score", () => {
  it("answers as the BEON login, not the default one", async () => {
    const credential = (token) => ({ token, expiresAt: null, identity: null });
    const { stderr } = await wrapper(["whoami"], {
      [baseUrl]: credential("tok-default"),
      [`${baseUrl}#beon`]: credential("tok-beon"),
    });
    assert.match(stderr, /ada@beon\.tech/);
    assert.doesNotMatch(stderr, /gmail/);
  });

  it("names its own command when not signed in", async () => {
    await assert.rejects(wrapper(["whoami"]), (err) => {
      assert.match(err.stderr, /npx @beon-tech\/beoner-ai-score login/);
      return true;
    });
  });

  it("passes everything else through to the CLI", async () => {
    const { stdout } = await wrapper(["--version"]);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
