/**
 * Local stand-in for the scoring service, so the upload path and the score card
 * can be exercised without submitting anything to production.
 *
 * Not a test file — `npm test` globs `test/*.test.js`, so this is ignored there.
 *
 *   node test/mock-server.mjs [mode] [port]
 *
 * Modes:
 *   score    (default) 201 with a full five-dimension score
 *   future   201 with an extra dimension and a bumped scoring version, to check
 *            that an older client renders a newer server's response
 *   plain    201 with a body this client cannot read — must degrade to
 *            "report uploaded" rather than crash
 *   401      rejects the token, to check the re-login guidance
 *   500      server error, to check the failure path
 *
 * Then, in another shell:
 *   AI_SCORE_TOKEN=fake node dist/cli.js --url http://localhost:8787
 */
import { createServer } from "node:http";

const MODE = process.argv[2] ?? "score";
const PORT = Number(process.argv[3] ?? 8787);

const DIMENSIONS = {
  leverage: {
    score: 55.4,
    max: 60,
    signals: { toolCallsPerPrompt: 20.6, maxToolCallsPerTurn: 200, longestTurnMinutes: 42.7 },
  },
  craft: { score: 15.8, max: 18, signals: { interruptionRate: 0.061, planningShare: 0.31 } },
  output: { score: 9.1, max: 10, signals: { prLinks: 11, linesChanged: 24310, activeDays: 22 } },
  customization: { score: 6.6, max: 7, signals: { mcpCalls: 214, slashCommands: 63 } },
  efficiency: { score: 5, max: 5, signals: { cacheRatio: 0.974, harnessesUsed: 3 } },
};

const RESPONSES = {
  score: {
    status: 201,
    body: {
      id: "6332871d-0f63-4973-8a46-a0803b534670",
      score: { total: 92, version: 1, dimensions: DIMENSIONS },
    },
  },
  future: {
    status: 201,
    body: {
      id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
      score: {
        total: 71.5,
        version: 2,
        dimensions: { ...DIMENSIONS, collaboration: { score: 3.2, max: 8, signals: {} } },
      },
    },
  },
  plain: { status: 201, body: { ok: true, queued: 1 } },
  401: { status: 401, body: { error: "token expired" } },
  500: { status: 500, body: { error: "scoring unavailable" } },
};

const chosen = RESPONSES[MODE];
if (!chosen) {
  process.stderr.write(`unknown mode "${MODE}" — try: ${Object.keys(RESPONSES).join(", ")}\n`);
  process.exit(1);
}

createServer((req, res) => {
  // Drain the body so the client's POST completes even when we ignore it.
  req.resume();
  req.on("end", () => {
    const size = Number(req.headers["content-length"] ?? 0);
    process.stderr.write(
      `  ${req.method} ${req.url} · ${(size / 1024).toFixed(1)} KB · → ${chosen.status}\n`,
    );
    res.writeHead(chosen.status, { "content-type": "application/json" });
    res.end(JSON.stringify(chosen.body));
  });
}).listen(PORT, () => {
  process.stderr.write(`mock scoring service on http://localhost:${PORT} (mode: ${MODE})\n`);
  process.stderr.write(
    `  AI_SCORE_TOKEN=fake node dist/cli.js --url http://localhost:${PORT} --yes\n\n`,
  );
});
