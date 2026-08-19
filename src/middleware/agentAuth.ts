/* ------------------------------------------------------------------ *
 *  Agent authentication middleware
 *
 *  Resolves `Authorization: Bearer sk_live_…` to an agent row and stashes
 *  it on the context for the /api/v1 handlers.
 *
 *  This middleware deliberately knows NOTHING about Better Auth. A session
 *  cookie must not authenticate here, and an agent key must not authenticate
 *  on the session-backed management API. Two credentials, two surfaces, no
 *  overlap — the moment either one works on both, a leaked key stops being a
 *  capped, revocable, audited credential and becomes account takeover.
 * ------------------------------------------------------------------ */

import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../env";
import { createDb } from "../db";
import type * as schema from "../db/schema";
import { authenticateAgent, logRequest, touchAgent } from "../agents/service";
import { HttpError } from "../wallet/service";

export type AgentRow = typeof schema.agents.$inferSelect;

export type AgentVariables = {
  agent: AgentRow;
  userId: string;
  agentId: string;
  /**
   * Set by a handler when it returns an error, so the request log records the
   * machine-readable code and not just the status. Nothing outside this file
   * and the v1 routes reads it.
   */
  errorCode?: string | null;
};

/**
 * Generic fallbacks used when a message carries no embedded code. An agent
 * branches on `code`, so "there is no code" is never an acceptable answer —
 * a status-derived one is at least stable.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "invalid_key",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "gone",
  422: "unprocessable",
  429: "rate_limited",
  503: "unavailable",
};

/**
 * Pull the machine code out of a service-layer message.
 *
 * The service layer writes messages as `code — human explanation` (or the bare
 * code when there is nothing to add), so the first token is the code whenever
 * it looks like one. Anything else falls back to a status-derived code rather
 * than inventing one from prose.
 */
export function codeFromMessage(message: string, status: number): string {
  const head = message.split(/\s+[—–-]\s+/)[0]?.trim() ?? "";
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(head)) return head;
  return CODE_BY_STATUS[status] ?? "error";
}

/**
 * Caller IP. Cloudflare sets `CF-Connecting-IP` on every request that reaches
 * a Worker and it cannot be spoofed by the client; `X-Forwarded-For` is only a
 * fallback for local/dev and proxied setups, where the first entry is the
 * original client.
 */
export function callerIp(headers: Headers): string | null {
  const cf = headers.get("CF-Connecting-IP");
  if (cf?.trim()) return cf.trim();
  const xff = headers.get("X-Forwarded-For");
  const first = xff?.split(",")[0]?.trim();
  return first ? first : null;
}

export const agentAuth = createMiddleware<{
  Bindings: Env;
  Variables: AgentVariables;
}>(async (c, next) => {
  const startedAt = Date.now();
  const ip = callerIp(c.req.raw.headers);

  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) {
    return c.json(
      {
        error:
          "invalid_key — send the API key as `Authorization: Bearer sk_live_…`. Session cookies do not authenticate here.",
        code: "invalid_key",
      },
      401
    );
  }

  const db = createDb(c.env.DATABASE_URL);

  let authed;
  try {
    authed = await authenticateAgent(db, match[1]!, ip);
  } catch (err) {
    if (err instanceof HttpError) {
      // No agentId is in hand for a failed auth (authenticateAgent throws
      // before returning the row), so there is nothing to write to
      // agent_requests — its agent_id is NOT NULL by design.
      return c.json(
        { error: err.message, code: codeFromMessage(err.message, err.status) },
        err.status as ContentfulStatusCode
      );
    }
    console.error("[agentAuth]", err);
    return c.json({ error: "Internal error", code: "internal" }, 500);
  }

  c.set("agent", authed.row);
  c.set("userId", authed.userId);
  c.set("agentId", authed.row.id);

  await next();

  /* ---- Request log + last-used, off the response path ---------------- *
   *  Every agent request is recorded: it is the debugging surface and the
   *  audit trail, and the first thing anyone asks for during an incident.
   *  It must never be something the caller waits on, so it goes through
   *  waitUntil. `executionCtx` throws when there is no ExecutionContext
   *  (unit tests, some local runners) — there we await instead, because a
   *  slower test is better than a hole in the audit trail.
   * ------------------------------------------------------------------- */
  const entry = {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latencyMs: Date.now() - startedAt,
    ip,
    errorCode: c.get("errorCode") ?? null,
  };

  const flush = (async () => {
    await logRequest(db, authed.row.id, entry);
    await touchAgent(db, authed.row.id, ip);
  })().catch((err) => console.error("[agentAuth] request log failed:", err));

  try {
    c.executionCtx.waitUntil(flush);
  } catch {
    await flush;
  }
});

export default agentAuth;
