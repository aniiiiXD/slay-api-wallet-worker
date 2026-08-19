/* ------------------------------------------------------------------ *
 *  prices/cc.ts                                                        *
 *                                                                      *
 *  Canton Coin (CC) → USD price.                                       *
 *                                                                      *
 *  Source: CoinGecko public API, id "canton-network". Free, no key,    *
 *  ~10–30 req/min soft cap. We stay miles under it with aggressive     *
 *  Worker-side caching — every consumer of /api/prices/cc shares one   *
 *  upstream call per ~60s.                                             *
 *                                                                      *
 *  Three-layer fallback so the Home screen never has to fake a price:  *
 *                                                                      *
 *    1. Hot cache (in-memory, 60s TTL). Module-level.                  *
 *    2. Live fetch from CoinGecko.                                     *
 *    3. Persistent cache (Postgres, see prices/store.ts) — survives    *
 *       isolate restarts. Marked `stale: true` when serving from here. *
 *    4. If literally nothing has ever been cached, return `usd: null`. *
 *       The app renders this as "—" instead of the bogus $1.00 floor  *
 *       it used to show.                                               *
 *                                                                      *
 *  On every successful live fetch we update the persistent store. So   *
 *  the only way to land at usd:null is a brand-new deploy that has     *
 *  never once reached CoinGecko — vanishingly rare in practice.        *
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import { loadPrice, rememberPrice } from "./store";

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=canton-network&vs_currencies=usd";

const TTL_MS = 60 * 1000;
const STORE_KEY = "cc";

type CacheEntry = { usd: number; at: number };
let cache: CacheEntry | null = null;

export type CcPrice = {
  /** Null when we genuinely have no data — app shows "—". Never $1.00 floor. */
  usd: number | null;
  /** ISO timestamp of the underlying data point (live or last good). */
  asOf: string;
  /** True when serving cached / persistent / fallback data. */
  stale: boolean;
};

export async function getCcUsdPrice(env: Env): Promise<CcPrice> {
  const now = Date.now();

  // 1. Hot in-memory cache.
  if (cache && now - cache.at < TTL_MS) {
    return {
      usd: cache.usd,
      asOf: new Date(cache.at).toISOString(),
      stale: false,
    };
  }

  // 2. Live fetch.
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: {
        accept: "application/json",
        "user-agent": "slay-money-api/1.0 (+https://slay.money)",
      },
      // Workers-specific RequestInit extension — concurrent isolates
      // share the upstream response, keeps us under CoinGecko's RL.
      cf: { cacheTtl: 60, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`coingecko HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    const body = (await res.json()) as
      | { "canton-network"?: { usd?: number } }
      | undefined;
    const usd = body?.["canton-network"]?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) {
      throw new Error("coingecko returned no usd field");
    }
    cache = { usd, at: now };
    // Persist in the background — don't block the response.
    void rememberPrice(env, STORE_KEY, usd);
    return { usd, asOf: new Date(now).toISOString(), stale: false };
  } catch (err) {
    console.warn(
      "[prices/cc] live fetch failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // 3. Stale memory cache (past TTL but better than nothing).
  if (cache) {
    return {
      usd: cache.usd,
      asOf: new Date(cache.at).toISOString(),
      stale: true,
    };
  }

  // 4. Persistent Postgres cache — survives Worker restarts.
  const persisted = await loadPrice(env, STORE_KEY);
  if (persisted) {
    cache = { usd: persisted.usd, at: persisted.fetchedAt.getTime() };
    return {
      usd: persisted.usd,
      asOf: persisted.fetchedAt.toISOString(),
      stale: true,
    };
  }

  // 5. We've never seen a price. Don't lie with $1.00 — return null
  //    and let the UI show "—" / "Loading…" until CoinGecko recovers.
  return { usd: null, asOf: new Date(now).toISOString(), stale: true };
}
