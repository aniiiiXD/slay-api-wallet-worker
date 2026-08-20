/* ------------------------------------------------------------------ *
 *  Which account pays
 *
 *  A partner's sub-account sends money; the partner is billed for it. That
 *  one sentence is the whole file, and it is the hinge the partner surface
 *  turns on:
 *
 *    free tier   three sends per UTC day belong to the PARTNER, not to each
 *                of their users. A provider sharding across 10,000
 *                sub-accounts would otherwise collect 30,000 free sends a
 *                day — earning their own fee, which has no free tier, on
 *                every one of them, while Slay earns on none. Nobody has to
 *                be devious for that; it is the default behaviour of
 *                sharding users, which is exactly what a provider does.
 *
 *    ceilings    a 250 CC/day approval is 250 CC/day for the partner, not
 *                250 × the number of wallets they chose to create.
 *
 *  NOTHING IMPORTS THIS YET. It lands as its own deploy, ahead of the code
 *  that will use it, so that the change which alters live money-path
 *  behaviour arrives alone and can be reasoned about alone.
 * ------------------------------------------------------------------ */

import { eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";

export interface BillingAccount {
  /** The account that pays: the provider, or the sender if unowned. */
  userId: string;
  /** The account that sent. Equal to `userId` for an ordinary wallet. */
  walletUserId: string;
  /** Null unless this wallet belongs to a partner. */
  providerUserId: string | null;
  /** The partner's own id for this wallet, for logs and error messages. */
  externalRef: string | null;
}

/**
 * Resolve the account that pays for `walletUserId`.
 *
 * ONE HOP, never a chain. A partner is not itself a sub-account — creation
 * refuses that, and the table's CHECK forbids the degenerate self-owning row
 * — so there is no ladder to walk. Following a chain here would turn a
 * malformed row into an unbounded loop on the send path, and the send path is
 * not where that should be discovered.
 *
 * An account with no owner bills to itself, which is what makes this safe to
 * introduce: with no rows in `partner_wallets`, every caller gets back exactly
 * the id it passed in, and behaviour is unchanged by construction.
 */
export async function resolveBillingAccount(
  db: DB,
  walletUserId: string
): Promise<BillingAccount> {
  const [row] = await db
    .select({
      providerUserId: schema.partnerWallets.providerUserId,
      externalRef: schema.partnerWallets.externalRef,
    })
    .from(schema.partnerWallets)
    .where(eq(schema.partnerWallets.walletUserId, walletUserId))
    .limit(1);

  if (!row) {
    return {
      userId: walletUserId,
      walletUserId,
      providerUserId: null,
      externalRef: null,
    };
  }

  return {
    userId: row.providerUserId,
    walletUserId,
    providerUserId: row.providerUserId,
    externalRef: row.externalRef,
  };
}

/**
 * The paying account id, for callers that want nothing else.
 *
 * Deliberately NOT written to swallow a database error. A lookup that fails
 * would fall back to the sender's own id, which is the answer that grants a
 * fresh free tier and a fresh daily ceiling — so an outage would quietly
 * become the most expensive possible behaviour. Let it throw; a refused send
 * is recoverable and an unbilled one is not.
 */
export async function billingAccountId(db: DB, walletUserId: string): Promise<string> {
  return (await resolveBillingAccount(db, walletUserId)).userId;
}

/** Whether a wallet belongs to a partner. */
export async function isPartnerWallet(db: DB, walletUserId: string): Promise<boolean> {
  return (await resolveBillingAccount(db, walletUserId)).providerUserId !== null;
}
