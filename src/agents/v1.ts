/* ------------------------------------------------------------------ *
 *  /api/v1 — the surface an agent actually calls
 *
 *  Authenticated by an agent key, never a session. Mounted outside the
 *  session-guarded /api tree so the two credentials cannot cross over: a
 *  key that worked on the management API could mint another key, and a
 *  session that worked here would bypass every restriction the owner set.
 *
 *  Amounts arrive as DECIMAL STRINGS. Caps are compared exactly against
 *  them, and only the final conversion to the wallet's internal micro-CC
 *  integer touches a number — see `ccStringToMicro`, which does that
 *  digit-wise rather than via a float.
 * ------------------------------------------------------------------ */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { Env } from "../env";
import { createDb } from "../db";
import * as schema from "../db/schema";
import { HttpError, microToCc, send } from "../wallet/service";
import { agentAuth, type AgentVariables } from "../middleware/agentAuth";
import {
  checkRecipient,
  getTradingStatus,
  requireCapability,
  reserveSpend,
} from "./service";

const v1 = new Hono<{ Bindings: Env; Variables: AgentVariables }>();

v1.use("*", agentAuth);

/**
 * Fail with a machine code and a human message.
 *
 * An agent branches on `code`; a person reads `error`. Returning only one of
 * the two forces the other party to guess — string-matching a message, or
 * staring at a bare code with no idea what to do about it.
 *
 * The code is also stashed on the context so the request log records it,
 * which is what makes the Logs screen useful during an incident.
 */
function fail(c: any, status: number, code: string, message: string) {
  c.set("errorCode", code);
  return c.json({ error: message, code }, status);
}

function fromHttpError(c: any, err: unknown) {
  if (err instanceof HttpError) {
    const head = err.message.split(/\s+[—–-]\s+/)[0]?.trim() ?? "";
    const code = /^[a-z][a-z0-9_]*$/.test(head) ? head : "error";
    return fail(c, err.status, code, err.message);
  }
  console.error("[v1]", err);
  return fail(c, 500, "internal", "Internal error");
}

/**
 * Decimal CC string → micro-CC integer, exactly.
 *
 * `ccToMicro` in wallet/service.ts multiplies a float by 1e6 and rounds,
 * which is fine for a number that arrived as a number. Here the value
 * arrived as a string and has already been compared against spend caps
 * exactly — routing it through a float at the last step would reintroduce
 * precisely the imprecision the string was carrying to avoid.
 */
export function ccStringToMicro(cc: string): number {
  const [whole = "0", frac = ""] = cc.trim().split(".");
  const micro = frac.padEnd(6, "0").slice(0, 6);
  return Number(whole) * 1_000_000 + Number(micro || "0");
}

/* ── Idempotency tags ────────────────────────────────────────────────
 *
 * `send()` records a clientTxId by appending `[idem:<id>]` to the memo —
 * there is no column for it. So reading one back means parsing the memo,
 * and showing a memo to a caller means stripping the tag first.
 *
 * ⚠️ That dedupe only scans the last 20 transactions within 5 minutes
 * (findExistingSendByClientTxId in wallet/service.ts). An agent retrying
 * after a longer outage — which is exactly when agents retry — can fall
 * outside the window and pay twice. A `client_tx_id` column with a unique
 * index would close it properly; noted here rather than worked around,
 * because a client-side workaround would not actually fix it.
 * ─────────────────────────────────────────────────────────────────────── */

const IDEM_RE = /\[idem:([^\]]+)\]/;

export function readIdem(memo: string | null): string | null {
  return memo ? (IDEM_RE.exec(memo)?.[1] ?? null) : null;
}

export function stripIdem(memo: string | null): string | null {
  if (!memo) return memo;
  const out = memo.replace(IDEM_RE, "").trim();
  return out || null;
}

/** Accept a decimal string; tolerate a number for callers that send one. */
function readAmount(v: unknown): string | null {
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(v);
  return null;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

v1.get("/balance", async (c) => {
  const agent = c.get("agent");
  try {
    requireCapability(agent, "balance:read");
  } catch (err) {
    return fromHttpError(c, err);
  }

  const db = createDb(c.env.DATABASE_URL);
  const [w] = await db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.userId, c.get("userId")))
    .limit(1);

  if (!w) return fail(c, 404, "not_found", "No wallet for this account.");

  const balance = microToCc(w.balance ?? 0);
  const locked = microToCc(w.locked ?? 0);

  return c.json({
    balanceCc: balance,
    lockedCc: locked,
    availableCc: balance - locked,
    cantonAddress: w.cantonAddress,
  });
});

v1.get("/transactions", async (c) => {
  const agent = c.get("agent");
  try {
    requireCapability(agent, "tx:read");
  } catch (err) {
    return fromHttpError(c, err);
  }

  const db = createDb(c.env.DATABASE_URL);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.userId, c.get("userId")))
    .orderBy(desc(schema.transactions.createdAt))
    .limit(limit);

  return c.json({
    items: rows.map((t) => ({
      id: t.id,
      type: t.type,
      amountCc: microToCc(t.amount ?? 0),
      status: t.status,
      memo: stripIdem(t.memo),
      clientTxId: readIdem(t.memo),
      createdAt: t.createdAt.toISOString(),
    })),
  });
});

/* ------------------------------------------------------------------ */
/*  Transfers                                                          */
/* ------------------------------------------------------------------ */

/**
 * Move money.
 *
 * The checks run in a deliberate order, cheapest and most-certain first, so
 * a request that was never going to succeed does not consume a spend
 * reservation on its way to being refused.
 */
v1.post("/transfers", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const agent = c.get("agent");
  const userId = c.get("userId");

  const body = await c.req
    .json<{ clientTxId?: string; to?: string; amountCc?: unknown; memo?: string }>()
    .catch(() => ({}) as Record<string, never>);

  // 1. Idempotency key is REQUIRED, not optional.
  //
  //    Agents run unattended and retry after failures — that is normal
  //    operation, not an edge case. Without a caller-supplied key the wallet
  //    cannot tell a retry from a second payment, and it would make the wrong
  //    choice silently.
  const clientTxId = typeof body.clientTxId === "string" ? body.clientTxId.trim() : "";
  if (!clientTxId) {
    return fail(
      c,
      400,
      "client_tx_id_required",
      "clientTxId is required. Reuse the same id when retrying — it is how a retry is told apart from a second payment."
    );
  }

  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to) return fail(c, 400, "bad_request", "`to` is required.");

  const amountCc = readAmount(body.amountCc);
  if (!amountCc) {
    return fail(
      c,
      400,
      "bad_request",
      "amountCc must be a positive decimal, sent as a string."
    );
  }

  try {
    // 2. Trading approval, re-checked on EVERY request.
    //
    //    Not stamped onto the key at creation: suspending an account has to
    //    disable every one of its agents at once, with no key hunting and no
    //    propagation delay. That only works if the check lives here.
    const trading = await getTradingStatus(db, userId);
    if (trading.state !== "approved") {
      return fail(
        c,
        403,
        "trading_not_approved",
        trading.state === "suspended"
          ? "Trading is suspended for this account. Reads still work."
          : "This account is not approved to move money programmatically."
      );
    }

    // 3. Does this key carry the capability at all?
    requireCapability(agent, "tx:write");

    // 4. Is this recipient permitted for this key?
    checkRecipient(agent, to);

    // 5. Reserve against the caps — atomic, and BEFORE the transfer.
    //
    //    Reserving first means a failed transfer leaves the day overstated.
    //    That is the safe direction: over-counting refuses a later spend,
    //    under-counting permits one that should have been blocked.
    await reserveSpend(db, agent, amountCc);

    // 6. The transfer itself — the same service call POST /api/wallet/send
    //    uses, so an agent and a human move money through identical code.
    const result = await send(
      db,
      c.env,
      userId,
      to,
      ccStringToMicro(amountCc),
      typeof body.memo === "string" ? body.memo : undefined,
      clientTxId
    );

    return c.json(
      {
        clientTxId,
        status: "settled",
        amountCc,
        id: result.transaction.id,
        createdAt: new Date().toISOString(),
      },
      201
    );
  } catch (err) {
    return fromHttpError(c, err);
  }
});

/** Status of a transfer this agent's account made. */
v1.get("/transfers/:clientTxId", async (c) => {
  const agent = c.get("agent");
  try {
    requireCapability(agent, "tx:read");
  } catch (err) {
    return fromHttpError(c, err);
  }

  const db = createDb(c.env.DATABASE_URL);
  const wanted = c.req.param("clientTxId");

  // No column to query — the id lives inside the memo, so this is a scan.
  // Bounded to keep it cheap; a transfer old enough to fall outside this
  // window is also outside send()'s dedupe window, so it is not findable
  // by design rather than by oversight.
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.userId, c.get("userId")))
    .orderBy(desc(schema.transactions.createdAt))
    .limit(200);

  const row = rows.find((r) => readIdem(r.memo) === wanted);

  if (!row) {
    return fail(
      c,
      404,
      "not_found",
      "No recent transfer with that clientTxId. Only the last 200 are searchable."
    );
  }

  return c.json({
    clientTxId: wanted,
    status: row.status,
    amountCc: microToCc(row.amount ?? 0),
    createdAt: row.createdAt.toISOString(),
  });
});

export default v1;
