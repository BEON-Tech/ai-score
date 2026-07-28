import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { login, whoami } from "../dist/auth/index.js";

/**
 * A stand-in for better-auth's device-authorization endpoints, so the polling
 * loop's behaviour can be exercised without a database or a browser. It mimics
 * the shape that matters: errors arrive as HTTP 400 with an OAuth-style body,
 * not as 200 with an error field.
 */
function stubServer(script) {
  const calls = { code: 0, token: 0, session: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/auth/device/code") {
      calls.code++;
      // interval 0 keeps the suite fast; the client still adds its own cushion.
      return json(200, {
        device_code: "dev-code-1",
        user_code: "ABCD1234",
        verification_uri: "http://localhost/device",
        verification_uri_complete: "http://localhost/device?user_code=ABCD1234",
        expires_in: script.expiresIn ?? 30,
        interval: 0,
      });
    }
    if (url.pathname === "/api/auth/device/token") {
      const step = script.token[Math.min(calls.token, script.token.length - 1)];
      calls.token++;
      return json(step.status, step.body);
    }
    if (url.pathname === "/api/auth/get-session") {
      calls.session++;
      if (script.session === null) return json(200, null);
      return json(200, { user: { id: "u1", name: "Ada Lovelace", email: "ada@beon.tech" } });
    }
    return json(404, { error: "not_found" });
  });
  return { server, calls };
}

async function withServer(script, run) {
  const { server, calls } = stubServer(script);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const pending = {
  status: 400,
  body: { error: "authorization_pending", error_description: "not yet" },
};
const approved = {
  status: 200,
  body: { access_token: "tok-live", token_type: "Bearer", expires_in: 3600 },
};

let sandbox;
let previousXdg;
const silent = { noBrowser: true, log: () => {} };

beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
  sandbox = mkdtempSync(join(tmpdir(), "ai-score-flow-"));
  process.env.XDG_CONFIG_HOME = sandbox;
  delete process.env.AI_SCORE_TOKEN;
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("device flow", () => {
  it("keeps polling through authorization_pending and then succeeds", async () => {
    await withServer({ token: [pending, pending, approved] }, async (baseUrl, calls) => {
      const credential = await login({ ...silent, baseUrl });
      assert.equal(credential.token, "tok-live");
      assert.equal(calls.token, 3, "should have polled until approval");
      assert.equal(credential.identity.email, "ada@beon.tech");
    });
  });

  it("caches the token so whoami works afterwards", async () => {
    await withServer({ token: [approved] }, async (baseUrl) => {
      await login({ ...silent, baseUrl });
      assert.equal((await whoami(baseUrl)).name, "Ada Lovelace");
    });
  });

  it("records an expiry derived from expires_in", async () => {
    await withServer({ token: [approved] }, async (baseUrl) => {
      const credential = await login({ ...silent, baseUrl });
      const ms = Date.parse(credential.expiresAt) - Date.now();
      assert.ok(ms > 3_500_000 && ms <= 3_600_000, `unexpected expiry ${credential.expiresAt}`);
    });
  });

  // RFC 8628: slow_down means back off, not give up.
  it("backs off on slow_down and still completes", async () => {
    const slowDown = {
      status: 400,
      body: { error: "slow_down", error_description: "too fast" },
    };
    await withServer({ token: [slowDown, approved] }, async (baseUrl, calls) => {
      const credential = await login({ ...silent, baseUrl });
      assert.equal(credential.token, "tok-live");
      assert.equal(calls.token, 2);
    });
  });

  it("gives up immediately when the user denies", async () => {
    const denied = {
      status: 400,
      body: { error: "access_denied", error_description: "denied by user" },
    };
    await withServer({ token: [denied] }, async (baseUrl, calls) => {
      await assert.rejects(login({ ...silent, baseUrl }), (err) => {
        assert.equal(err.code, "access_denied");
        return true;
      });
      assert.equal(calls.token, 1, "a denial should not be retried");
    });
  });

  it("surfaces an expired device code", async () => {
    const expired = {
      status: 400,
      body: { error: "expired_token", error_description: "too late" },
    };
    await withServer({ token: [expired] }, async (baseUrl) => {
      await assert.rejects(login({ ...silent, baseUrl }), (err) => err.code === "expired_token");
    });
  });

  it("stops polling once the device code lifetime is up", async () => {
    await withServer({ token: [pending], expiresIn: 1 }, async (baseUrl) => {
      await assert.rejects(login({ ...silent, baseUrl }), (err) => err.code === "expired_token");
    });
  });

  it("still stores a token when the identity lookup returns no session", async () => {
    await withServer({ token: [approved], session: null }, async (baseUrl) => {
      const credential = await login({ ...silent, baseUrl });
      assert.equal(credential.token, "tok-live");
      assert.equal(credential.identity, null);
    });
  });

  it("reports not-signed-in when nothing is cached", async () => {
    await withServer({ token: [approved] }, async (baseUrl) => {
      assert.equal(await whoami(baseUrl), null);
    });
  });
});
