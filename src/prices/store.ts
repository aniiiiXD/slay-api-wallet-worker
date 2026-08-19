/* ------------------------------------------------------------------ *
 *  prices/store.ts                                                    *
 *                                                                      *
 *  Persistent USD price cache backed by Postgres. Read by the per-     *
 *  asset price modules (cc.ts, cbtc.ts) as the second-tier fallback   *
 *  when the in-memory cache is cold and the live fetch fails.         *
 *                                                                      *
 *  Why Postgres and not Workers KV: we already pay for Postgres and   *
 *  the read/write volume is trivial (one row per asset, updated every *
 *  ~60s). Saves wiring a second persistence layer. The Neon HTTP      *
 *  driver makes each call a single subrequest.                         *
 *                                                                      *
 *  This module exposes a tiny API:                                     *
 *    rememberPrice(env, key, usd)   — upsert latest price             *
 *    loadPrice(env, key)            — read latest cached price         *
 *                                                                      *
 *  Failure modes are silent — store errors must NEVER prevent serving *
 *  the in-memory cache. Worst case: we serve old data with stale=true.*
 * ------------------------------------------------------------------ */

import { eq } from "drizzle-orm";
import { createDb, schema } from "../db";
import type { Env } from "../env";

export type StoredPrice = {
  usd: number;
  fetchedAt: Date;
};

/** Upsert a successful live fetch result so the next isolate cold-start
 *  has something better than $1 to fall back to. */
export async function rememberPrice(
  env: Env,
  key: string,
  usd: number
): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  try {
    const db = createDb(env.DATABASE_URL);
    await db
      .insert(schema.priceCache)
      .values({ key, usd: usd.toString(), fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.priceCache.key,
        set: { usd: usd.toString(), fetchedAt: new Date() },
      });
  } catch (err) {
    console.warn(
      `[prices.store] remember ${key} failed:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Read the last cached price, no staleness filter — the caller decides
 *  whether the age is acceptable based on its own freshness budget. */
export async function loadPrice(
  env: Env,
  key: string
): Promise<StoredPrice | null> {
  try {
    const db = createDb(env.DATABASE_URL);
    const [row] = await db
      .select()
      .from(schema.priceCache)
      .where(eq(schema.priceCache.key, key))
      .limit(1);
    if (!row) return null;
    const usd = Number(row.usd);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return {
      usd,
      fetchedAt: row.fetchedAt as Date,
    };
  } catch (err) {
    console.warn(
      `[prices.store] load ${key} failed:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
