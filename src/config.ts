export const DEFAULT_BASE_URL = "https://ai-score.beon.tech";
export const SUBMISSIONS_PATH = "/api/v1/submissions";

export interface Target {
  /** Origin used for auth endpoints and as the credential cache key. */
  baseUrl: string;
  /** Exact URL the payload is POSTed to. */
  submissionsUrl: string;
}

/**
 * Resolves where to talk to. `--endpoint` / $AI_SCORE_ENDPOINT predate
 * authentication, when a full submissions URL was the only configurable thing;
 * they still win, and the origin is derived from them.
 */
export function resolveTarget(endpoint?: string, url?: string): Target {
  const explicitEndpoint = endpoint ?? process.env.AI_SCORE_ENDPOINT;
  if (explicitEndpoint) {
    return {
      baseUrl: new URL(explicitEndpoint).origin,
      submissionsUrl: explicitEndpoint,
    };
  }
  const base = (url ?? process.env.AI_SCORE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    baseUrl: new URL(base).origin,
    submissionsUrl: `${base}${SUBMISSIONS_PATH}`,
  };
}
