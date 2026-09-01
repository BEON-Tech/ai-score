import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { send } from "../dist/send.js";

const PAYLOAD = { client: { version: "0.0.0" } };

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

describe("send", () => {
  it("gzips the body so big reports fit under transport limits", async () => {
    let received;
    const { server, port } = await listen((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received = { encoding: req.headers["content-encoding"], body: Buffer.concat(chunks) };
        res.statusCode = 201;
        res.end(JSON.stringify({ id: "abc" }));
      });
    });
    try {
      const { result } = await send(`http://127.0.0.1:${port}/api/v1/submissions`, PAYLOAD, "t");
      assert.equal(result.id, "abc");
      assert.equal(received.encoding, "gzip");
      // The server sniffs these magic bytes to decide whether to inflate.
      assert.equal(received.body[0], 0x1f);
      assert.equal(received.body[1], 0x8b);
      assert.deepEqual(JSON.parse(gunzipSync(received.body).toString("utf8")), PAYLOAD);
    } finally {
      server.close();
    }
  });

  it("explains an oversized payload instead of echoing a bare 413", async () => {
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "payload too large" }));
    });
    try {
      await assert.rejects(
        send(`http://127.0.0.1:${port}/api/v1/submissions`, PAYLOAD, "token"),
        /--harness/,
      );
    } finally {
      server.close();
    }
  });

  it("keeps other failures verbatim for diagnosis", async () => {
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    try {
      await assert.rejects(
        send(`http://127.0.0.1:${port}/api/v1/submissions`, PAYLOAD, "token"),
        /HTTP 500 boom/,
      );
    } finally {
      server.close();
    }
  });
});
