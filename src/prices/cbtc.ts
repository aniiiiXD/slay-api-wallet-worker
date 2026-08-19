/* ------------------------------------------------------------------ *
 *  prices/cbtc.ts                                                      *
 *                                                                      *
 *  CBTC (Canton Bitcoin, by BitSafe) → USD price.                      *
 *                                                                      *
 *  CBTC is custodial 1:1 BTC. The CBTC USD value is therefore exactly  *
 *  BTC's USD value — we read CoinGecko's `bitcoin` quote and surface   *
 *  it under the CBTC label. Same caching pattern as cc.ts:             *
 *                                                                      *
 *    1. Hot in-memory (60s TTL)                                        *
 *    2. Live CoinGecko fetch                                           *
 *    3. Stale memory cache (post-TTL)                                  *
 *    4. Postgres persistent cache (survives isolate restart)           *
 *    5. usd: null if nothing has ever been cached — UI shows "—".     *
 *                                                                      *
 *  The 1:1 BTC↔CBTC peg is enforced by the BitSafe Attestor network;  *
 *  the moment that peg breaks (it won't), Slay would source the price *
 *  directly from BitSafe instead of inferring from BTC.                *
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import { loadPrice, rememberPrice } from "./store";

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

const TTL_MS = 60 * 1000;
const STORE_KEY = "cbtc";

type CacheEntry = { usd: number; at: number };
let cache: CacheEntry | null = null;

export type CbtcPrice = {
  /** USD per 1 CBTC. Null when literally no price has ever been cached. */
  usd: number | null;
  asOf: string;
  stale: boolean;
};

export async function getCbtcUsdPrice(env: Env): Promise<CbtcPrice> {
  const now = Date.now();

  if (cache && now - cache.at < TTL_MS) {
    return {
      usd: cache.usd,
      asOf: new Date(cache.at).toISOString(),
      stale: false,
    };
  }

  try {
    const res = await fetch(COINGECKO_URL, {
      headers: {
        accept: "application/json",
        "user-agent": "slay-money-api/1.0 (+https://slay.money)",
      },
      cf: { cacheTtl: 60, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`coingecko HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    const body = (await res.json()) as
      | { bitcoin?: { usd?: number } }
      | undefined;
    const usd = body?.bitcoin?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) {
      throw new Error("coingecko returned no usd field for bitcoin");
    }
    cache = { usd, at: now };
    void rememberPrice(env, STORE_KEY, usd);
    return { usd, asOf: new Date(now).toISOString(), stale: false };
  } catch (err) {
    console.warn(
      "[prices/cbtc] live fetch failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  if (cache) {
    return {
      usd: cache.usd,
      asOf: new Date(cache.at).toISOString(),
      stale: true,
    };
  }

  const persisted = await loadPrice(env, STORE_KEY);
  if (persisted) {
    cache = { usd: persisted.usd, at: persisted.fetchedAt.getTime() };
    return {
      usd: persisted.usd,
      asOf: persisted.fetchedAt.toISOString(),
      stale: true,
    };
  }

  return { usd: null, asOf: new Date(now).toISOString(), stale: true };
}
