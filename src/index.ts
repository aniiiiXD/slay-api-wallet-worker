/* ------------------------------------------------------------------ *
 *  Slay — wallet provider API
 *
 *  A separate Worker from `slay-money-api`, on purpose.
 *
 *  WHY THIS EXISTS
 *
 *  The main Worker serves ~425 handlers: markets, rewards, swaps, admin,
 *  prediction, the dashboard, the extension. Partners use five of them.
 *  Measured over the last 199 commits that touched src/, 123 — 61% — changed
 *  nothing a partner calls, yet every one of them reshipped the code serving
 *  partners. That is the risk this Worker removes: partner traffic no longer
 *  moves when Slay ships.
 *
 *  WHAT IT DOES NOT REMOVE — read before trusting it
 *
 *  Partners and Slay users share one Postgres and one Canton validator, and
 *  they must: a partner's CC is real CC in the same ledger. So this Worker
 *  isolates CODE, not DATA. A migration that renames a column still reaches
 *  partners, and it reaches them at the worst possible moment — when nobody
 *  deployed anything here. See MIGRATIONS in README.md; the rule is
 *  expand/contract, and it is not optional.
 *
 *  Likewise, the money path (wallet/service.ts, fees/send-fees.ts) is code
 *  partners genuinely run. Isolation protects them from the 86% of the
 *  codebase they never touch. It does not protect them from a bug in `send()`.
 *  What protects them from that is release cadence: this Worker deploys from
 *  a reviewed tag, after the main app has run the same code in production.
 *
 *  SCOPE
 *
 *  Basic wallet, and nothing else. Balance, history, send, transfer lookup.
 *  Every feature added here is a feature that can break here, which defeats
 *  the point of building it. New surface belongs in the main Worker until it
 *  has been stable there long enough to be boring.
 * ------------------------------------------------------------------ */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./env";
import agentV1 from "./agents/v1";
import docsRoutes from "./docs/routes";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());

/*
 * CORS is wide open because every route here is authenticated by a bearer
 * token rather than a cookie. A browser cannot be tricked into attaching an
 * agent key the way it would attach a session automatically, so the
 * same-origin restriction that protects the main Worker buys nothing here —
 * and partners call this from their own servers and origins.
 *
 * `credentials` stays false. If a cookie is ever accepted on this Worker,
 * this policy becomes unsafe and must change with it.
 */
app.use("*", cors({ origin: "*", credentials: false }));

/** Liveness. No database, so it answers even when Postgres is unreachable —
 *  which is exactly when a partner needs to know whether it is us or them. */
app.get("/", (c) =>
  c.json({
    name: "slay-api-wallet-providers",
    status: "ok",
    surface: "wallet",
    docs: "/docs",
    openapi: "/openapi.json",
  })
);

/**
 * Readiness — distinct from liveness, and the distinction matters.
 *
 * `/` says the Worker is running. This says it can actually serve a request,
 * which requires the shared database. A partner alerting on `/` alone would
 * page nobody during a database outage.
 */
app.get("/health", async (c) => {
  const started = Date.now();
  try {
    const { createDb } = await import("./db");
    const db = createDb(c.env.DATABASE_URL);
    await db.execute("select 1");
    return c.json({ ok: true, db: "up", ms: Date.now() - started });
  } catch (err) {
    console.error("[health]", err);
    return c.json({ ok: false, db: "down", ms: Date.now() - started }, 503);
  }
});

/*  The entire partner surface. Five handlers.
 *
 *  Mounted on the root app with no middleware above it beyond CORS and the
 *  logger. There is deliberately no banGuard, no appLockdown, no session
 *  matcher — those exist to police Slay's own product surface, and every one
 *  of them is a way for a Slay decision to take a partner offline. */
app.route("/api/v1", agentV1);

/*  Public reference, generated from openapi.yaml at build time. */
app.route("/", docsRoutes);

app.notFound((c) =>
  c.json(
    {
      error:
        "Not found. This Worker serves the wallet provider API only: " +
        "/api/v1/balance, /api/v1/transactions, /api/v1/transfers, " +
        "/api/v1/transfers/{clientTxId}, /api/v1/config. " +
        "Everything else — issuing keys, applying for approval, prices — " +
        "lives on the main Slay API, not here. See /docs.",
      code: "not_found",
    },
    404
  )
);

app.onError((err, c) => {
  console.error("[unhandled]", err);
  return c.json({ error: "Internal error", code: "internal" }, 500);
});

export default app;
