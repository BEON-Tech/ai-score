import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  cached,
  credentialKey,
  invalidate,
  login,
  loginCommand,
  logout,
  resolveToken,
  whoami,
} from "../dist/auth/index.js";

/**
 * `--beon`: the BEON login uses its own device-flow client, so the server can
 * require a BEON Google account for it, and its token is cached apart from the
 * default one so neither login ever replaces or stands in for the other.
 *
 * The stub hands out a different token per client and resolves each token to
 * a different person, so a mix-up shows as the wrong identity.
 */
function stubServer() {
  const clientIds = { code: [], token: [] };
  const people = {
    "tok-default": { id: "u1", name: "Ada", email: "ada@gmail.com" },
    "tok-beon": { id: "u2", name: "Ada", email: "ada@beon.tech" },
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const body = raw ? JSON.parse(raw) : {};
      const json = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/api/auth/device/code") {
        clientIds.code.push(body.client_id);
        return json(200, {
          device_code: `dev-${body.client_id}`,
          user_code: "ABCD1234",
          verification_uri: "http://localhost/device",
          expires_in: 30,
          interval: 0,
        });
      }
      if (url.pathname === "/api/auth/device/token") {
        clientIds.token.push(body.client_id);
        const beon = body.client_id === "ai-score-cli-beon";
        return json(200, {
          access_token: beon ? "tok-beon" : "tok-default",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/api/auth/get-session") {
        const token = (req.headers.authorization ?? "").replace("Bearer ", "");
        return json(200, people[token] ? { user: people[token] } : null);
      }
      return json(404, { error: "not_found" });
    });
  });
  return { server, clientIds };
}

async function withServer(run) {
  const { server, clientIds } = stubServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl, clientIds);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const run = promisify(execFile);

let sandbox;
let previousXdg;
const silent = { noBrowser: true, log: () => {} };

beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
  sandbox = mkdtempSync(join(tmpdir(), "ai-score-beon-"));
  process.env.XDG_CONFIG_HOME = sandbox;
  delete process.env.AI_SCORE_TOKEN;
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("--beon login", () => {
  it("asks for a code and a token with the BEON client id", async () => {
    await withServer(async (baseUrl, clientIds) => {
      await login({ ...silent, baseUrl, beon: true });
      assert.deepEqual(clientIds.code, ["ai-score-cli-beon"]);
      assert.deepEqual(clientIds.token, ["ai-score-cli-beon"]);
    });
  });

  it("leaves the default login on the public client id", async () => {
    await withServer(async (baseUrl, clientIds) => {
      await login({ ...silent, baseUrl });
      assert.deepEqual(clientIds.code, ["ai-score-cli"]);
      assert.deepEqual(clientIds.token, ["ai-score-cli"]);
    });
  });

  it("caches the two logins side by side, each answering for itself", async () => {
    await withServer(async (baseUrl) => {
      await login({ ...silent, baseUrl });
      await login({ ...silent, baseUrl, beon: true });
      assert.equal(cached(baseUrl).token, "tok-default");
      assert.equal(cached(baseUrl, true).token, "tok-beon");
      assert.equal((await whoami(baseUrl)).email, "ada@gmail.com");
      assert.equal((await whoami(baseUrl, true)).email, "ada@beon.tech");
    });
  });

  it("submits with the BEON token only when asked to", async () => {
    await withServer(async (baseUrl) => {
      await login({ ...silent, baseUrl });
      await login({ ...silent, baseUrl, beon: true });
      assert.equal(await resolveToken({ ...silent, baseUrl, allowLogin: false }), "tok-default");
      assert.equal(
        await resolveToken({ ...silent, baseUrl, beon: true, allowLogin: false }),
        "tok-beon",
      );
    });
  });

  it("never falls back to the default token for a BEON run", async () => {
    await withServer(async (baseUrl) => {
      await login({ ...silent, baseUrl });
      await assert.rejects(
        resolveToken({ ...silent, baseUrl, beon: true, allowLogin: false }),
        /ai-score login --beon/,
      );
    });
  });

  it("logs out and invalidates one login without touching the other", async () => {
    await withServer(async (baseUrl) => {
      await login({ ...silent, baseUrl });
      await login({ ...silent, baseUrl, beon: true });
      assert.equal(logout(baseUrl, true), true);
      assert.equal(cached(baseUrl, true), null);
      assert.equal(cached(baseUrl).token, "tok-default");

      await login({ ...silent, baseUrl, beon: true });
      invalidate(baseUrl);
      assert.equal(cached(baseUrl), null);
      assert.equal(cached(baseUrl, true).token, "tok-beon");
    });
  });

  it("keys the BEON credential off the origin", () => {
    assert.equal(credentialKey("https://ai-score.beon.tech/x"), "https://ai-score.beon.tech");
    assert.equal(
      credentialKey("https://ai-score.beon.tech/x", true),
      "https://ai-score.beon.tech#beon",
    );
    assert.equal(loginCommand(true), "ai-score login --beon");
    assert.equal(loginCommand(), "ai-score login");
  });
});

/**
 * The "will show in AI Coding Pulse" note after an upload must follow the
 * token actually sent: the BEON login's, not an AI_SCORE_TOKEN override that
 * may belong to anyone. Runs the real CLI with an empty home (nothing to
 * scan, so it is fast) against a stub that records what it was sent.
 */
describe("--beon upload note", () => {
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const note = /will show in AI Coding Pulse/;

  async function upload(env) {
    const home = mkdtempSync(join(tmpdir(), "ai-score-upload-"));
    const sent = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        sent.push(req.headers.authorization);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "run-1", url: null }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    // A cached BEON login, as `login --beon` would leave it.
    mkdirSync(join(home, ".config", "beon"), { recursive: true });
    writeFileSync(
      join(home, ".config", "beon", "ai-score.json"),
      JSON.stringify({
        [`${baseUrl}#beon`]: { token: "tok-beon", expiresAt: null, identity: null },
      }),
    );
    try {
      const { stderr } = await run(process.execPath, [cli, "--beon", "--yes", "--no-browser"], {
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          AI_SCORE_URL: baseUrl,
          ...env,
        },
      });
      return { stderr, sent };
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("says so when the BEON login sent the run", async () => {
    const { stderr, sent } = await upload({ AI_SCORE_TOKEN: undefined });
    assert.deepEqual(sent, ["Bearer tok-beon"]);
    assert.match(stderr, note);
  });

  it("stays quiet when AI_SCORE_TOKEN sent it instead", async () => {
    const { stderr, sent } = await upload({ AI_SCORE_TOKEN: "tok-ci" });
    assert.deepEqual(sent, ["Bearer tok-ci"]);
    assert.doesNotMatch(stderr, note);
  });

  it("treats an empty AI_SCORE_TOKEN as unset, for the token and the note alike", async () => {
    const { stderr, sent } = await upload({ AI_SCORE_TOKEN: "" });
    assert.deepEqual(sent, ["Bearer tok-beon"]);
    assert.match(stderr, note);
  });
});
