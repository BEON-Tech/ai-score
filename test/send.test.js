import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { send } from "../dist/send.js";

const PAYLOAD = { client: { version: "0.0.0" } };

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

describe("send", () => {
  it("explains an oversized payload instead of echoing a bare 413", async () => {
    const { server, port } = await listen((_req, res) => {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "payload too large" }));
    });
    try {
      await assert.rejects(
        send(`http://127.0.0.1:${port}/api/v1/submissions`, PAYLOAD, "token"),
        /--days/,
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
