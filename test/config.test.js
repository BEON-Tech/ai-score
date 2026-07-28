import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_BASE_URL, resolveTarget } from "../dist/config.js";

const ENV_KEYS = ["AI_SCORE_ENDPOINT", "AI_SCORE_URL"];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveTarget", () => {
  it("defaults to the production server", () => {
    const target = resolveTarget(undefined, undefined);
    assert.equal(target.baseUrl, DEFAULT_BASE_URL);
    assert.equal(target.submissionsUrl, `${DEFAULT_BASE_URL}/api/v1/submissions`);
  });

  it("derives both URLs from --url", () => {
    const target = resolveTarget(undefined, "http://localhost:3000");
    assert.equal(target.baseUrl, "http://localhost:3000");
    assert.equal(target.submissionsUrl, "http://localhost:3000/api/v1/submissions");
  });

  it("tolerates a trailing slash on --url", () => {
    const target = resolveTarget(undefined, "http://localhost:3000///");
    assert.equal(target.submissionsUrl, "http://localhost:3000/api/v1/submissions");
  });

  it("reads AI_SCORE_URL when no flag is given", () => {
    process.env.AI_SCORE_URL = "https://staging.example.com";
    assert.equal(resolveTarget(undefined, undefined).baseUrl, "https://staging.example.com");
  });

  it("prefers the flag over the environment", () => {
    process.env.AI_SCORE_URL = "https://staging.example.com";
    assert.equal(
      resolveTarget(undefined, "http://localhost:3000").baseUrl,
      "http://localhost:3000",
    );
  });

  // Back-compat: --endpoint predates auth and names the submissions URL
  // directly, so the origin has to be recovered from it for the auth calls.
  it("recovers the origin from a legacy --endpoint", () => {
    const target = resolveTarget("https://other.example.com/api/v1/submissions", undefined);
    assert.equal(target.baseUrl, "https://other.example.com");
    assert.equal(target.submissionsUrl, "https://other.example.com/api/v1/submissions");
  });

  it("lets a legacy --endpoint win over --url", () => {
    const target = resolveTarget("https://legacy.example.com/ingest", "http://localhost:3000");
    assert.equal(target.baseUrl, "https://legacy.example.com");
    assert.equal(target.submissionsUrl, "https://legacy.example.com/ingest");
  });

  it("reads AI_SCORE_ENDPOINT for back-compat", () => {
    process.env.AI_SCORE_ENDPOINT = "https://env.example.com/ingest";
    assert.equal(
      resolveTarget(undefined, undefined).submissionsUrl,
      "https://env.example.com/ingest",
    );
  });
});
