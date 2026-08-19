/**
 * CBTC holding cid cache — see comment block on schema.cbtcHoldingCache
 * for the full rationale. TL;DR: Canton 3.5.1's JSON v2 API caps active-
 * contracts responses at 200 elements regardless of filter shape, and
 * the operator party crosses that limit easily. We can't query the
 * participant for "which CBTC Holding does treasury currently own", so
 * we cache one cid per sender party and refresh it after every transfer.
 */

import { eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db";
import { schema } from "../db";

export type CachedHolding = {
  partyId: string;
  holdingCid: string;
  amountRaw: number;
  updatedAt: Date;
};

/** Read the cached cid for a party. Null if no row. */
export async function getCachedHolding(
  db: DB,
  partyId: string
): Promise<CachedHolding | null> {
  const [row] = await db
    .select({
      partyId: schema.cbtcHoldingCache.partyId,
      holdingCid: schema.cbtcHoldingCache.holdingCid,
      amountRaw: schema.cbtcHoldingCache.amountRaw,
      updatedAt: schema.cbtcHoldingCache.updatedAt,
    })
    .from(schema.cbtcHoldingCache)
    .where(eq(schema.cbtcHoldingCache.partyId, partyId))
    .limit(1);
  if (!row) return null;
  return row;
}

/**
 * Upsert the cached cid for a party. Called from two paths:
 *  1. POST /api/admin/cbtc/seed-holding-cid — initial operator setup
 *  2. transferCbtc after a successful transfer — picks up the new
 *     change Holding cid from the transaction tree
 */
export async function setCachedHolding(
  db: DB,
  partyId: string,
  holdingCid: string,
  amountRaw: number
): Promise<void> {
  await db
    .insert(schema.cbtcHoldingCache)
    .values({
      partyId,
      holdingCid,
      amountRaw,
    })
    .onConflictDoUpdate({
      target: schema.cbtcHoldingCache.partyId,
      set: {
        holdingCid,
        amountRaw,
        updatedAt: sql`NOW()`,
      },
    });
}

/**
 * Batch lookup — returns a Map<partyId, amountRaw> for the given parties.
 * Used by the synth volume picker to cap pick amounts at the bot's actual
 * on-chain holding instead of postgres balance (which drifts).
 */
export async function getCachedHoldingAmounts(
  db: DB,
  partyIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (partyIds.length === 0) return result;
  const rows = await db
    .select({
      partyId: schema.cbtcHoldingCache.partyId,
      amountRaw: schema.cbtcHoldingCache.amountRaw,
    })
    .from(schema.cbtcHoldingCache)
    .where(inArray(schema.cbtcHoldingCache.partyId, partyIds));
  for (const r of rows) result.set(r.partyId, r.amountRaw);
  return result;
}

/**
 * Drop the cached cid for a party. Called on transfer failure when we
 * suspect the cached cid was consumed but we couldn't capture the new
 * one — better to fail loud than to use a stale cid on next attempt.
 */
export async function invalidateCachedHolding(
  db: DB,
  partyId: string
): Promise<void> {
  await db
    .delete(schema.cbtcHoldingCache)
    .where(eq(schema.cbtcHoldingCache.partyId, partyId));
}
