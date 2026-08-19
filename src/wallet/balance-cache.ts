/**
 * Cached wrapper around fetchOnChainCcBalance — the ~2s active-contracts query
 * that dominated /api/wallet latency. DISPLAY-ONLY: this feeds the pending-
 * deposit indicator + the deposit watermark auto-credit. The user's SPENDABLE
 * balance is `wallets.balance` read fresh from Postgres and is NEVER cached.
 *
 * Safety: a user's own on-chain party balance only RISES (omnibus model — bets/
 * sends/wins never add Amulets to the user's own party; only real deposits do).
 * So a stale cached value is always ≤ current → it can delay showing a fresh
 * deposit by at most the TTL, but can NEVER over-credit. The inbound-mirror
 * cron is the backstop for any lag.
 *
 * Layers: single-flight (collapse concurrent same-party fetches) → KV fresh
 * cache (TTL) → circuit breaker around the ledger → serve-stale on failure.
 */
import type { Env } from "../env";
import { fetchOnChainCcBalance } from "../splice/amulet";
import { singleFlight, getBreaker } from "../lib/reliability";

const FRESH_MS = 20_000; // return cached without hitting the ledger if younger
const STALE_TTL_S = 600; // keep for serve-stale up to 10 min

type Cached = { cc: number | null; ts: number };

export async function getCachedOnChainCcBalance(env: Env, party: string): Promise<number | null> {
  const kv = env.M2M_TOKEN_CACHE;
  const key = `bal:${party}`;
  const now = Date.now();

  let cached: Cached | null = null;
  if (kv) {
    const raw = await kv.get(key).catch(() => null);
    if (raw) {
      try {
        cached = JSON.parse(raw) as Cached;
      } catch {
        /* corrupt entry → ignore */
      }
    }
    if (cached && now - cached.ts < FRESH_MS) return cached.cc; // fresh hit
  }

  // Coalesce concurrent misses for the same party into one ledger query.
  return singleFlight(`onchain-bal:${party}`, async () => {
    // Re-read inside the flight in case a sibling call just populated it.
    if (kv) {
      const raw = await kv.get(key).catch(() => null);
      if (raw) {
        try {
          const c = JSON.parse(raw) as Cached;
          if (Date.now() - c.ts < FRESH_MS) return c.cc;
          cached = c;
        } catch {
          /* ignore */
        }
      }
    }
    try {
      const cc = await getBreaker("ledger-balance", {
        failureThreshold: 4,
        cooldownMs: 20_000,
        timeoutMs: 10_000,
      }).exec(() => fetchOnChainCcBalance(env, party));
      if (kv) {
        await kv.put(key, JSON.stringify({ cc, ts: Date.now() } satisfies Cached), { expirationTtl: STALE_TTL_S }).catch(() => {});
      }
      return cc;
    } catch {
      // Ledger down / circuit open → serve stale (safe: stale ≤ current) or
      // null (route treats null as "on-chain unknown", never inflates balance).
      return cached ? cached.cc : null;
    }
  });
}

/** Drop a party's cached balance so the next read is fresh — call after a
 *  credited deposit so the pending indicator clears immediately. */
export async function invalidateOnChainCcBalance(env: Env, party: string): Promise<void> {
  await env.M2M_TOKEN_CACHE?.delete(`bal:${party}`).catch(() => {});
}
