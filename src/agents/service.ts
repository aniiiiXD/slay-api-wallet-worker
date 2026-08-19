/* ------------------------------------------------------------------ *
 *  Agent API — service layer
 *
 *  An agent is a credential a program uses to operate a wallet under
 *  restrictions the owner sets. One rule shapes everything here:
 *
 *      An agent cannot exist without restrictions.
 *
 *  There is no default, no "add limits later", and no unrestricted state
 *  reachable by any code path. `tx:write` additionally requires explicit
 *  per-transaction and per-day caps, because an uncapped money-moving key
 *  is an unbounded liability the moment it leaks.
 * ------------------------------------------------------------------ */

import { and, desc, eq, isNull, or, gt, sql } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type { Env } from "../env";
import { HttpError } from "../wallet/service";

export const CAPABILITIES = ["balance:read", "tx:read", "tx:write"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Restrictions {
  capabilities: Capability[];
  limits?: {
    perTransactionCc?: string;
    perDayCc?: string;
    perMonthCc?: string;
  };
  allowedRecipients?: string[] | null;
  allowedIps?: string[] | null;
  expiresAt?: string | null;
  requireApprovalAboveCc?: string | null;
}

const newId = () => crypto.randomUUID();

/** A plain decimal string. Never parsed to a float anywhere in this file. */
const isDecimal = (v: unknown): v is string =>
  typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) && v.trim() !== "";

/* ------------------------------------------------------------------ */
/*  Key generation and hashing                                         */
/* ------------------------------------------------------------------ */

/**
 * Mint a key.
 *
 * Format: `sk_live_<prefix>_<secret>`. The prefix is stored in clear so a key
 * appearing in a log can be identified without being usable; only the SHA-256
 * of the whole string is persisted.
 *
 * SHA-256 rather than argon2/scrypt is a deliberate trade for this input
 * shape: the secret is 256 bits of CSPRNG output, not a human-chosen password,
 * so there is no dictionary to attack and key-stretching buys nothing. It also
 * has to run on every request inside a Worker's CPU budget — a deliberately
 * slow hash there would be a self-inflicted rate limit.
 */
function randomSegment(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, bytes * 2);
}

export async function hashKey(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function mintKey(live: boolean): { secret: string; prefix: string } {
  const env = live ? "live" : "test";
  const short = randomSegment(2);
  const prefix = `sk_${env}_${short}`;
  return { secret: `${prefix}_${randomSegment(24)}`, prefix };
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Enforce the restrictions contract.
 *
 * The dashboard runs the same checks client-side so a user gets a fast, local
 * answer — but that is a courtesy, not a gate. A client can always be
 * bypassed, so every rule is re-checked here and this is the one that counts.
 */
export function validateRestrictions(
  r: Restrictions | undefined,
  tradingApproved: boolean,
  ceiling: { perTxCc?: string | null; perDayCc?: string | null }
): { caps: Capability[]; limits: Record<string, string | null> } {
  if (!r || typeof r !== "object") {
    throw new HttpError(422, "restrictions is required. There is no default.");
  }

  const caps = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is Capability =>
        (CAPABILITIES as readonly string[]).includes(c)
      )
    : [];

  if (caps.length === 0) {
    throw new HttpError(
      422,
      "At least one valid capability is required: " + CAPABILITIES.join(", ")
    );
  }

  const canWrite = caps.includes("tx:write");

  if (canWrite && !tradingApproved) {
    throw new HttpError(
      403,
      "trading_not_approved — this account cannot create money-moving keys yet."
    );
  }

  const lim = r.limits ?? {};

  if (canWrite) {
    if (!isDecimal(lim.perTransactionCc)) {
      throw new HttpError(
        422,
        "tx:write requires limits.perTransactionCc as a decimal string."
      );
    }
    if (!isDecimal(lim.perDayCc)) {
      throw new HttpError(
        422,
        "tx:write requires limits.perDayCc as a decimal string."
      );
    }
  }

  for (const [k, v] of Object.entries(lim)) {
    if (v !== undefined && v !== null && v !== "" && !isDecimal(v)) {
      throw new HttpError(422, `limits.${k} must be a decimal string.`);
    }
  }

  if (
    r.requireApprovalAboveCc != null &&
    r.requireApprovalAboveCc !== "" &&
    !isDecimal(r.requireApprovalAboveCc)
  ) {
    throw new HttpError(422, "requireApprovalAboveCc must be a decimal string.");
  }

  if (r.expiresAt) {
    const t = Date.parse(r.expiresAt);
    if (!Number.isFinite(t)) throw new HttpError(422, "expiresAt is not a date.");
    if (t <= Date.now()) {
      throw new HttpError(422, "expiresAt is in the past.");
    }
  }

  // Clamp to the account ceiling rather than rejecting. The owner asked for
  // more than the account allows, which is a misunderstanding rather than an
  // error — but silently storing a number we will not honour would be worse,
  // so the response returns what was actually saved.
  const clamp = (want: string | undefined, max: string | null | undefined) => {
    if (!isDecimal(want)) return want ?? null;
    if (!isDecimal(max ?? undefined)) return want;
    return cmpDecimal(want, max as string) > 0 ? (max as string) : want;
  };

  return {
    caps,
    limits: {
      perTxCc: clamp(lim.perTransactionCc, ceiling.perTxCc) ?? null,
      perDayCc: clamp(lim.perDayCc, ceiling.perDayCc) ?? null,
      perMonthCc: isDecimal(lim.perMonthCc) ? lim.perMonthCc : null,
      requireApprovalAboveCc: isDecimal(r.requireApprovalAboveCc ?? undefined)
        ? (r.requireApprovalAboveCc as string)
        : null,
    },
  };
}

/** Compare two decimal strings exactly. -1 | 0 | 1. Never uses parseFloat. */
export function cmpDecimal(a: string, b: string): -1 | 0 | 1 {
  const [ai = "0", af = ""] = a.trim().split(".");
  const [bi = "0", bf = ""] = b.trim().split(".");
  const ia = ai.replace(/^0+(?=\d)/, "");
  const ib = bi.replace(/^0+(?=\d)/, "");
  if (ia.length !== ib.length) return ia.length > ib.length ? 1 : -1;
  if (ia !== ib) return ia > ib ? 1 : -1;
  const len = Math.max(af.length, bf.length);
  const fa = af.padEnd(len, "0");
  const fb = bf.padEnd(len, "0");
  if (fa === fb) return 0;
  return fa > fb ? 1 : -1;
}

/* ------------------------------------------------------------------ */
/*  Trading approval                                                   */
/* ------------------------------------------------------------------ */

export async function getTradingStatus(db: DB, userId: string) {
  const [row] = await db
    .select()
    .from(schema.tradingApprovals)
    .where(eq(schema.tradingApprovals.userId, userId))
    .limit(1);

  if (!row) {
    return { state: "none" as const, appliedAt: null, decidedAt: null };
  }
  return {
    state: row.state,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason,
    limits: {
      perTransactionCc: row.ceilingPerTxCc,
      perDayCc: row.ceilingPerDayCc,
    },
  };
}

export async function applyForTrading(
  db: DB,
  userId: string,
  useCase: string,
  expectedMonthlyVolumeCc: string
) {
  if (!useCase?.trim()) throw new HttpError(400, "useCase is required.");
  if (!isDecimal(expectedMonthlyVolumeCc)) {
    throw new HttpError(400, "expectedMonthlyVolumeCc must be a decimal string.");
  }

  const existing = await getTradingStatus(db, userId);
  if (existing.state === "approved") {
    throw new HttpError(409, "Trading is already approved for this account.");
  }
  if (existing.state === "pending") {
    throw new HttpError(409, "An application is already pending.");
  }

  await db
    .insert(schema.tradingApprovals)
    .values({
      userId,
      state: "pending",
      useCase: useCase.trim(),
      expectedMonthlyVolumeCc,
      appliedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.tradingApprovals.userId,
      set: {
        state: "pending",
        useCase: useCase.trim(),
        expectedMonthlyVolumeCc,
        appliedAt: new Date(),
        decidedAt: null,
        reason: null,
      },
    });

  return getTradingStatus(db, userId);
}

/* ------------------------------------------------------------------ */
/*  Agents                                                             */
/* ------------------------------------------------------------------ */

type AgentRow = typeof schema.agents.$inferSelect;

/** Public shape. Never includes the secret or the hash. */
export function publicAgent(a: AgentRow) {
  return {
    id: a.id,
    name: a.name,
    prefix: a.keyPrefix,
    restrictions: {
      capabilities: a.capabilities,
      limits: {
        perTransactionCc: a.perTxCc,
        perDayCc: a.perDayCc,
        perMonthCc: a.perMonthCc,
      },
      allowedRecipients: a.allowedRecipients,
      allowedIps: a.allowedIps,
      expiresAt: a.expiresAt?.toISOString() ?? null,
      requireApprovalAboveCc: a.requireApprovalAboveCc,
    },
    frozen: a.frozen,
    createdAt: a.createdAt.toISOString(),
    lastUsedAt: a.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: a.lastUsedIp,
  };
}

export async function listAgents(db: DB, userId: string) {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.userId, userId), isNull(schema.agents.revokedAt)))
    .orderBy(desc(schema.agents.createdAt));
  return rows.map(publicAgent);
}

export async function createAgent(
  db: DB,
  userId: string,
  actor: string,
  name: string,
  restrictions: Restrictions,
  live = true
) {
  if (!name?.trim()) {
    throw new HttpError(422, "name is required — it identifies the key in logs.");
  }

  const trading = await getTradingStatus(db, userId);
  const { caps, limits } = validateRestrictions(
    restrictions,
    trading.state === "approved",
    {
      perTxCc: trading.limits?.perTransactionCc,
      perDayCc: trading.limits?.perDayCc,
    }
  );

  const { secret, prefix } = mintKey(live);
  const id = newId();

  await db.insert(schema.agents).values({
    id,
    userId,
    name: name.trim(),
    keyHash: await hashKey(secret),
    keyPrefix: prefix,
    capabilities: caps,
    perTxCc: limits.perTxCc,
    perDayCc: limits.perDayCc,
    perMonthCc: limits.perMonthCc,
    requireApprovalAboveCc: limits.requireApprovalAboveCc,
    allowedRecipients: restrictions.allowedRecipients ?? null,
    allowedIps: restrictions.allowedIps ?? null,
    expiresAt: restrictions.expiresAt ? new Date(restrictions.expiresAt) : null,
  });

  await audit(db, userId, actor, "agent.create", id, `${name} · ${caps.join(", ")}`);

  const [row] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .limit(1);

  // The only moment this value exists in a response.
  return { ...publicAgent(row!), secret };
}

export async function revokeAgent(
  db: DB,
  userId: string,
  actor: string,
  agentId: string
) {
  const res = await db
    .update(schema.agents)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.userId, userId)))
    .returning({ id: schema.agents.id });

  if (res.length === 0) throw new HttpError(404, "No such key.");
  await audit(db, userId, actor, "agent.revoke", agentId);
}

export async function setFrozen(
  db: DB,
  userId: string,
  actor: string,
  agentId: string,
  frozen: boolean
) {
  const res = await db
    .update(schema.agents)
    .set({ frozen })
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.userId, userId)))
    .returning();

  if (res.length === 0) throw new HttpError(404, "No such key.");
  await audit(
    db,
    userId,
    actor,
    frozen ? "agent.freeze" : "agent.unfreeze",
    agentId
  );
  return publicAgent(res[0]!);
}

/** The incident button. One call, every agent. */
export async function freezeAll(db: DB, userId: string, actor: string) {
  const res = await db
    .update(schema.agents)
    .set({ frozen: true })
    .where(
      and(
        eq(schema.agents.userId, userId),
        eq(schema.agents.frozen, false),
        isNull(schema.agents.revokedAt)
      )
    )
    .returning({ id: schema.agents.id });

  await audit(db, userId, actor, "agent.freeze_all", null, `${res.length} frozen`);
  return { frozen: res.length };
}

/**
 * Rotate.
 *
 * The successor is created first and the predecessor is given an expiry
 * window rather than being killed, so rotating is not an outage for a running
 * integration. Past the window the old key stops authenticating.
 */
export async function rotateAgent(
  db: DB,
  userId: string,
  actor: string,
  agentId: string,
  graceSeconds = 3600
) {
  const [old] = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.userId, userId)))
    .limit(1);

  if (!old) throw new HttpError(404, "No such key.");

  const grace = Math.min(Math.max(graceSeconds, 0), 86400);
  const oldExpiresAt = new Date(Date.now() + grace * 1000);
  const { secret, prefix } = mintKey(true);
  const id = newId();

  await db.insert(schema.agents).values({
    id,
    userId,
    name: old.name,
    keyHash: await hashKey(secret),
    keyPrefix: prefix,
    capabilities: old.capabilities,
    perTxCc: old.perTxCc,
    perDayCc: old.perDayCc,
    perMonthCc: old.perMonthCc,
    requireApprovalAboveCc: old.requireApprovalAboveCc,
    allowedRecipients: old.allowedRecipients,
    allowedIps: old.allowedIps,
    expiresAt: old.expiresAt,
  });

  await db
    .update(schema.agents)
    .set({ supersededAt: oldExpiresAt })
    .where(eq(schema.agents.id, agentId));

  await audit(db, userId, actor, "agent.rotate", agentId, `→ ${id}`);

  const [row] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .limit(1);

  return {
    ...publicAgent(row!),
    secret,
    oldExpiresAt: oldExpiresAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Authentication + enforcement                                       */
/* ------------------------------------------------------------------ */

export interface AuthedAgent {
  row: AgentRow;
  userId: string;
}

/**
 * Resolve a bearer key to an agent, enforcing everything that does not
 * depend on the request body.
 *
 * Order matters: expiry and revocation are checked before capabilities, so a
 * dead key never gets a message about scopes — that would send an integrator
 * off widening a permission on a credential that can no longer work.
 */
export async function authenticateAgent(
  db: DB,
  secret: string,
  ip: string | null
): Promise<AuthedAgent> {
  const hash = await hashKey(secret);

  const [row] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.keyHash, hash))
    .limit(1);

  if (!row) throw new HttpError(401, "invalid_key");
  if (row.revokedAt) throw new HttpError(401, "invalid_key — revoked.");

  // A superseded key keeps working until its grace window closes.
  if (row.supersededAt && row.supersededAt.getTime() < Date.now()) {
    throw new HttpError(401, "invalid_key — rotated out.");
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new HttpError(401, "invalid_key — expired.");
  }
  if (row.frozen) throw new HttpError(409, "frozen");

  if (row.allowedIps?.length) {
    if (!ip || !ipAllowed(ip, row.allowedIps)) {
      throw new HttpError(403, "ip_not_allowed");
    }
  }

  return { row, userId: row.userId };
}

/** Exact match, or a /24-style prefix. Deliberately simple and conservative. */
function ipAllowed(ip: string, allowed: string[]): boolean {
  for (const entry of allowed) {
    const e = entry.trim();
    if (e === ip) return true;
    const slash = e.indexOf("/");
    if (slash > 0) {
      const base = e.slice(0, slash);
      const baseParts = base.split(".");
      const ipParts = ip.split(".");
      const bits = parseInt(e.slice(slash + 1), 10);
      if (!Number.isFinite(bits) || baseParts.length !== 4) continue;
      const octets = Math.floor(bits / 8);
      if (
        octets > 0 &&
        baseParts.slice(0, octets).join(".") === ipParts.slice(0, octets).join(".")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function requireCapability(agent: AgentRow, cap: Capability): void {
  if (!agent.capabilities.includes(cap)) {
    throw new HttpError(403, `capability_missing — this key lacks "${cap}".`);
  }
}

/**
 * Reserve spend against the caps, atomically.
 *
 * This is the one genuinely hard part of the whole API. Two requests from the
 * same agent arriving together must not both pass a shared daily cap. A
 * read-then-write across two statements is a race, and its failure mode is
 * silent: nothing errors, and the total is simply wrong afterwards.
 *
 * So the check and the increment are a single conditional UPDATE. The row
 * lock serialises concurrent callers, and `rowCount === 0` means the cap was
 * exceeded — the same statement that would have spent decides whether it may.
 *
 * Reserving before the transfer means a failed transfer leaves the day's
 * counter overstated. That is the safe direction: over-counting refuses a
 * later spend, under-counting permits one that should have been blocked.
 */
export async function reserveSpend(
  db: DB,
  agent: AgentRow,
  amountCc: string
): Promise<void> {
  if (!isDecimal(amountCc)) {
    throw new HttpError(400, "amount must be a decimal string.");
  }

  if (agent.perTxCc && cmpDecimal(amountCc, agent.perTxCc) > 0) {
    throw new HttpError(
      429,
      `limit_exceeded — per-transaction cap is ${agent.perTxCc} CC.`
    );
  }

  if (!agent.perDayCc) return;

  const day = new Date().toISOString().slice(0, 10);

  await db
    .insert(schema.agentSpend)
    .values({ agentId: agent.id, day, spentCc: "0" })
    .onConflictDoNothing();

  const updated = await db
    .update(schema.agentSpend)
    .set({ spentCc: sql`${schema.agentSpend.spentCc} + ${amountCc}::numeric` })
    .where(
      and(
        eq(schema.agentSpend.agentId, agent.id),
        eq(schema.agentSpend.day, day),
        // The cap check lives INSIDE the update. This is what makes it atomic.
        sql`${schema.agentSpend.spentCc} + ${amountCc}::numeric <= ${agent.perDayCc}::numeric`
      )
    )
    .returning({ spent: schema.agentSpend.spentCc });

  if (updated.length === 0) {
    const [cur] = await db
      .select()
      .from(schema.agentSpend)
      .where(
        and(
          eq(schema.agentSpend.agentId, agent.id),
          eq(schema.agentSpend.day, day)
        )
      )
      .limit(1);

    throw new HttpError(
      429,
      `limit_exceeded — daily cap ${agent.perDayCc} CC, already spent ${cur?.spentCc ?? "0"} CC. Resets at 00:00 UTC.`
    );
  }
}

export function checkRecipient(agent: AgentRow, to: string): void {
  const allowed = agent.allowedRecipients;
  if (!allowed?.length) return;
  if (!allowed.includes(to.trim())) {
    throw new HttpError(
      403,
      "recipient_not_allowed — this key may only send to its configured recipients."
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Logging                                                            */
/* ------------------------------------------------------------------ */

export async function logRequest(
  db: DB,
  agentId: string,
  entry: {
    method: string;
    path: string;
    status: number;
    latencyMs: number;
    ip?: string | null;
    errorCode?: string | null;
  }
) {
  await db.insert(schema.agentRequests).values({
    id: newId(),
    agentId,
    method: entry.method,
    path: entry.path,
    status: entry.status,
    latencyMs: entry.latencyMs,
    ip: entry.ip ?? null,
    errorCode: entry.errorCode ?? null,
  });
}

export async function touchAgent(db: DB, agentId: string, ip: string | null) {
  await db
    .update(schema.agents)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip })
    .where(eq(schema.agents.id, agentId));
}

export async function listRequests(
  db: DB,
  userId: string,
  agentId: string,
  limit = 100
) {
  const [owned] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.userId, userId)))
    .limit(1);
  if (!owned) throw new HttpError(404, "No such key.");

  return db
    .select()
    .from(schema.agentRequests)
    .where(eq(schema.agentRequests.agentId, agentId))
    .orderBy(desc(schema.agentRequests.at))
    .limit(Math.min(limit, 500));
}

/** Append-only. Nothing in this file updates or deletes an audit row. */
export async function audit(
  db: DB,
  userId: string,
  actor: string,
  action: string,
  target?: string | null,
  detail?: string | null
) {
  await db.insert(schema.agentAudit).values({
    id: newId(),
    userId,
    actor,
    action,
    target: target ?? null,
    detail: detail ?? null,
  });
}

export async function listAudit(db: DB, userId: string, limit = 100) {
  return db
    .select()
    .from(schema.agentAudit)
    .where(eq(schema.agentAudit.userId, userId))
    .orderBy(desc(schema.agentAudit.at))
    .limit(Math.min(limit, 500));
}
