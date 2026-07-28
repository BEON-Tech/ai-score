import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, HarnessReport, SessionRecord } from "../types.js";
import {
  databaseSync,
  displayPath,
  emptyReport,
  emptyUsage,
  hash16,
  home,
  NEEDS_SQLITE,
  newSessionRecord,
  toIso,
  toMs,
} from "../util.js";

/**
 * `cursor-agent` stores each conversation as a content-addressed blob store:
 * `~/.cursor/chats/<project>/<agent>/store.db`, with a `meta` row pointing at a
 * root blob and a `blobs` table keyed by the SHA-256 of the contents.
 *
 * Two kinds of blob live in there. The conversation itself is stored as plain
 * JSON — one AI SDK message per blob — which is everything this adapter needs.
 * The rest is a protobuf event log for the UI, undocumented and version-
 * dependent, and it is left alone: nothing read here depends on decoding it,
 * beyond the one structure noted at `messageOrder`.
 */

/** `meta` holds a single JSON row, hex-encoded. */
export interface CliMeta {
  agentId?: string;
  latestRootBlobId?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string;
}

/**
 * The value arrives as a hex string today; older stores wrote the JSON
 * directly, and a driver could hand back a Buffer. Decode all three rather than
 * bet on one.
 */
export function parseMeta(value: unknown): CliMeta | null {
  let text: string;
  if (value instanceof Uint8Array) text = Buffer.from(value).toString("utf8");
  else if (typeof value === "string") {
    text =
      /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0
        ? Buffer.from(value, "hex").toString("utf8")
        : value;
  } else return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as CliMeta) : null;
  } catch {
    return null;
  }
}

/**
 * The root blob opens with the conversation's message blobs as a repeated
 * protobuf field 1 of 32-byte digests — so every reference is the three-part
 * sequence `0x0a 0x20 <digest>`, and reading the run of them off the front
 * needs no protobuf decoder and no knowledge of the fields that follow.
 *
 * Order matters: it is the only thing that says which messages belong to which
 * turn. When the root is unreadable the caller falls back to the unordered set
 * of JSON blobs, which still yields correct counts.
 */
export function messageOrder(root: Uint8Array | null | undefined): string[] {
  const ids: string[] = [];
  if (!root) return ids;
  const buf = Buffer.from(root);
  let i = 0;
  while (i + 34 <= buf.length && buf[i] === 0x0a && buf[i + 1] === 0x20) {
    ids.push(buf.subarray(i + 2, i + 34).toString("hex"));
    i += 34;
  }
  return ids;
}

/** JSON blobs are AI SDK messages; anything else in the store is not one. */
export function asMessage(data: Uint8Array): any | null {
  if (data.length === 0 || data[0] !== 0x7b) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.role === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Folds an ordered message list into a session record. Exported for the tests,
 * which build message arrays directly rather than a SQLite fixture.
 */
export function foldMessages(messages: any[], s: SessionRecord): { reasoning: number } {
  let reasoning = 0;
  let inTurn = false;
  let turnTools = 0;

  const closeTurn = () => {
    if (!inTurn) return;
    s.agentic.maxToolCallsPerTurn = Math.max(s.agentic.maxToolCallsPerTurn, turnTools);
    inTurn = false;
    turnTools = 0;
  };

  for (const m of messages) {
    const content = Array.isArray(m.content) ? m.content : [];
    switch (m.role) {
      case "user":
        closeTurn();
        s.counts.userPrompts++;
        s.agentic.turns++;
        inTurn = true;
        break;
      case "assistant":
        s.counts.assistantMessages++;
        for (const block of content) {
          if (block?.type === "reasoning") reasoning++;
          if (block?.type !== "tool-call") continue;
          const name = typeof block.toolName === "string" ? block.toolName : "unknown";
          s.counts.toolCalls++;
          s.tools[name] = (s.tools[name] ?? 0) + 1;
          turnTools++;
        }
        break;
      // `tool` messages mirror the calls already counted above, and the system
      // prompt is not a turn. Neither adds a count.
    }
  }
  closeTurn();
  return { reasoning };
}

/**
 * The CLI installs itself under a date-stamped directory, which is the only
 * place its version is written down — the session stores do not record it.
 */
async function installedVersion(): Promise<string | null> {
  try {
    const versions = await readdir(home(".local", "share", "cursor-agent", "versions"));
    return versions.sort().pop() ?? null;
  } catch {
    return null;
  }
}

async function parseSession(
  file: string,
  project: string,
  mtimeMs: number,
  DatabaseSync: any,
  report: HarnessReport,
): Promise<SessionRecord | null> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = parseMeta(db.prepare("SELECT value FROM meta LIMIT 1").get()?.value) ?? {};
    const blobs = new Map<string, Uint8Array>();
    for (const row of db.prepare("SELECT id, data FROM blobs").all()) {
      blobs.set(String(row.id), row.data as Uint8Array);
    }

    const ordered = messageOrder(meta.latestRootBlobId ? blobs.get(meta.latestRootBlobId) : null);
    const ids = ordered.length > 0 ? ordered : [...blobs.keys()];
    const messages: any[] = [];
    for (const id of ids) {
      const blob = blobs.get(id);
      if (!blob) continue;
      const message = asMessage(blob);
      if (message) messages.push(message);
    }

    const s = newSessionRecord(hash16(meta.agentId ?? file), hash16(project));
    const { reasoning } = foldMessages(messages, s);
    if (s.counts.userPrompts === 0 && s.counts.assistantMessages === 0) return null;

    // Neither timestamps nor token counts survive into the JSON messages, so a
    // session is bracketed by the store's own clock: the recorded creation time
    // and the file's last write.
    const createdAt = toMs(meta.createdAt);
    s.startedAt = toIso(createdAt);
    s.endedAt = toIso(Math.max(mtimeMs, createdAt ?? mtimeMs));

    // The model is named but never accounted for, so it is reported with an
    // empty usage bucket rather than omitted — knowing which model ran is worth
    // more than the zeros cost.
    if (meta.lastUsedModel) s.models[meta.lastUsedModel] = emptyUsage();

    s.flags = {
      modes: meta.mode ? [meta.mode] : [],
      models: meta.lastUsedModel ? [meta.lastUsedModel] : [],
      mcpCalls: Object.entries(s.tools)
        .filter(([name]) => name.startsWith("mcp"))
        .reduce((sum, [, n]) => sum + n, 0),
      reasoningBlocks: reasoning,
    };
    return s;
  } finally {
    try {
      db.close();
    } catch {
      report.parseErrors++;
    }
  }
}

export const cursorCli: Adapter = {
  harness: "cursor-cli",
  async collect(ctx) {
    const root = home(".cursor", "chats");
    const report = emptyReport("cursor-cli", displayPath(root));
    let projects: string[];
    try {
      projects = await readdir(root);
    } catch {
      return report;
    }
    report.detected = true;
    report.latestVersion = await installedVersion();
    const DatabaseSync = await databaseSync();
    if (!DatabaseSync) {
      report.skippedReason = `reading Cursor CLI data ${NEEDS_SQLITE}`;
      return report;
    }

    for (const project of projects) {
      let agents: string[];
      try {
        agents = await readdir(join(root, project));
      } catch {
        continue;
      }
      for (const agent of agents) {
        const file = join(root, project, agent, "store.db");
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(file)).mtimeMs;
        } catch {
          continue;
        }
        report.sessionsScanned++;
        if (mtimeMs < ctx.since.getTime()) continue;
        ctx.verbose(`cursor-cli: parsing ${displayPath(file)}`);
        try {
          const session = await parseSession(file, project, mtimeMs, DatabaseSync, report);
          if (session) {
            report.sessions.push(session);
            report.sessionsIncluded++;
          }
        } catch {
          report.parseErrors++;
        }
      }
    }
    return report;
  },
};
