import type { Env } from "../env";
import type { DB } from "../db";
import { schema } from "../db";
import { sql, eq, and, gte, inArray, type AnyColumn } from "drizzle-orm";
import { transferAmulet } from "../splice/amulet";
import { getCcUsdPrice } from "../prices/cc";
import { getCbtcUsdPrice } from "../prices/cbtc";
import { fetchOracleSpots } from "../oracle-markets/oracle";
import { fetchLiveMarkerValueUsd } from "../splice/marker";
import { billingAccountId } from "../partner/billing";

// Send fee model:
//   * The first FREE_TXNS_PER_DAY (default 3) outgoing sends per user per UTC
//     day are FREE (no fee), any asset.
//   * From the 4th send onward, a dynamic fee applies — a USD target (base, less
//     a 20% margin and the marker reward Slay earns back) converted to CC at the
//     live CC price, rounded UP to whole CC:
//       CC (Amulet):   (0.427 - 0.427*0.2 - 0.427*m) / p
//       CIP56 (token): (0.976 - 0.976*0.2 - 0.976*m - 0.976*0.5*0.8*0.5*m) / p
//     where m = live network Marker Value, p = CC/USD. Clamped >= 0 (a high m can
//     make the numerator negative; never pay to send). If p is unavailable, fall
//     back to the flat env fee so we never divide by null. Same fee internal/
//     external — the formula has no such term.
const CC_BASE_USD = 0.427;
const TOKEN_BASE_USD = 0.976;
const MARGIN = 0.2;

function syntheticFreeTxnsPerDay(env: Env): number {
  const n = Number(env.SYNTHETIC_FREE_TXNS_PER_DAY ?? "4");
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

function freeTxnsPerDay(env: Env): number {
  const n = Number(env.FREE_TXNS_PER_DAY ?? "3");
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

/* ---- Who the free tier belongs to ---------------------------------- *
 *
 *  Off: exactly what this file has always done — three sends per UTC day per
 *  user, counted against the sender's own id, with the identical query.
 *
 *  On: the allowance belongs to the account that PAYS. A wallet provider
 *  sharding across 10,000 sub-accounts would otherwise collect 30,000 free
 *  sends a day, earning their own fee — which has no free tier — on every one
 *  of them while Slay earns on none. Nobody has to be devious for that; it is
 *  the default behaviour of sharding users, which is what a provider does.
 *
 *  Even switched on this is inert until a partner wallet exists: with no rows
 *  in partner_wallets every account bills to itself, which is asserted
 *  directly in test/billing.contract.test.mts. The flag exists so the extra
 *  query can be switched off too, and so this can be turned back without a
 *  deploy if it misbehaves.                                                */
const partnerBilling = (env: Env): boolean => env.PARTNER_BILLING_ENABLED === "1";

/** Count of the outgoing sends already made today (UTC) on this account. */
async function sendsTodayUtc(
  db: DB,
  userId: string,
  billing = false
): Promise<number> {
  const now = new Date();
  const startUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  if (!billing) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.type, "send"),
          gte(schema.transactions.createdAt, startUtc)
        )
      );
    return Number(row?.n ?? 0);
  }

  /* Counting for a PAYING account: its own sends plus every send made by a
   * wallet it owns.
   *
   * Two queries rather than one join, and the reason is measured. A left join
   * filtered on `coalesce(provider_user_id, user_id) = $1` is not sargable —
   * the planner cannot seek on user_id through a coalesce, so it scans. On
   * production data that plan costs ~5760 against ~8.4 for the indexed
   * equality this replaces: a 680x regression on the send path, for a feature
   * that is inert for almost every account.
   *
   * Collecting the owned ids first and matching `user_id = ANY(...)` keeps the
   * index seek. Measured on the same data: 8.4 for an account that owns
   * nothing — identical to today — 887 at 200 wallets, 1680 at 5000. The
   * common case pays nothing for a feature it does not use.
   *
   * At a few thousand wallets this stops being the right shape and a per-account
   * daily counter does; that is a change to make when a partner is near it,
   * not now. */
  const owned = await db
    .select({ id: schema.partnerWallets.walletUserId })
    .from(schema.partnerWallets)
    .where(eq(schema.partnerWallets.providerUserId, userId));

  const ids = [userId, ...owned.map((o) => o.id)];

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.userId, ids),
        eq(schema.transactions.type, "send"),
        gte(schema.transactions.createdAt, startUtc)
      )
    );
  return Number(row?.n ?? 0);
}

/** True while the user is still inside their free daily-send allowance.
 *  Synthetic bots get their own (higher) allowance so the pool drains more
 *  slowly, without touching what real users get.
 *  `excludeCurrent`: pass 1 from CHARGE-TIME callers that run AFTER the
 *  send's transaction row is inserted — the count then includes the send
 *  being charged, and without the exclusion the user's THIRD send of the
 *  day was billed ("first 3 free" silently became "first 2 free"). */
async function withinFreeTier(
  db: DB,
  env: Env,
  userId: string,
  excludeCurrent = 0
): Promise<boolean> {
  /* The allowance belongs to whoever pays for the send. Unowned accounts
   * resolve to themselves, so this is the same id as before for everyone
   * except a partner's sub-account. */
  const billing = partnerBilling(env) ? await billingAccountId(db, userId) : userId;

  const [u] = await db
    .select({ isSynthetic: schema.users.isSynthetic })
    .from(schema.users)
    .where(eq(schema.users.id, billing))
    .limit(1);
  const free = u?.isSynthetic
    ? syntheticFreeTxnsPerDay(env)
    : freeTxnsPerDay(env);
  if (free <= 0) return false;
  const used =
    (await sendsTodayUtc(db, billing, partnerBilling(env)).catch(() => 0)) - excludeCurrent;
  return used < free;
}

/**
 * The user's free-send allowance for today, for display.
 *
 * The fee routes already know all of this, but they only ever surfaced the
 * RESULTING fee (0 while free), so the Send screen could say "Free" without
 * being able to say "2 of 3 left" — which is the part that tells someone
 * whether their next send costs anything.
 *
 * Synthetic bots get their own higher allowance; this reports whichever one
 * actually applies to the caller.
 */
export async function freeSendAllowance(
  db: DB,
  env: Env,
  userId: string
): Promise<{ perDay: number; used: number; left: number }> {
  /* Reports against the same account the charge is made against. A screen
   * that says "2 of 3 used" while the fee engine counts somewhere else is
   * worse than no screen. */
  const billing = partnerBilling(env) ? await billingAccountId(db, userId) : userId;

  const [u] = await db
    .select({ isSynthetic: schema.users.isSynthetic })
    .from(schema.users)
    .where(eq(schema.users.id, billing))
    .limit(1);
  const perDay = u?.isSynthetic
    ? syntheticFreeTxnsPerDay(env)
    : freeTxnsPerDay(env);
  const used = await sendsTodayUtc(db, billing, partnerBilling(env)).catch(() => 0);
  return { perDay, used, left: Math.max(0, perDay - used) };
}

async function feeInputs(env: Env): Promise<{ p: number | null; m: number }> {
  const [cc, m] = await Promise.all([
    getCcUsdPrice(env).catch(() => ({ usd: null }) as { usd: number | null }),
    fetchLiveMarkerValueUsd(env).catch(() => Number(env.MARKER_VALUE_USD ?? "1") || 1),
  ]);
  return { p: cc.usd, m };
}

// Round UP at micro-CC (the smallest unit CC is stored in), NOT to a whole CC.
// Rounding to integer CC put a hard 1 CC floor on every fee — e.g. a formula
// output of 0.65 CC was charged as 1 CC (+54%), and 0.49 CC as 1 CC (+103%),
// which on small transfers dwarfed the amount being sent.
const MICRO = 1_000_000;
const ceilPos = (x: number): number => (x > 0 ? Math.ceil(x * MICRO) / MICRO : 0);
const flatFallback = (raw: unknown, def: number): number => {
  const n = Number(raw ?? def);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
};

/** Every intermediate of the fee formula, for tracing a surprising charge. */
export async function feeDebug(db: DB, env: Env, userId: string) {
  const { p, m } = await feeInputs(env);
  const free = freeTxnsPerDay(env);
  const billing = userId && partnerBilling(env) ? await billingAccountId(db, userId) : userId;
  const used = billing
    ? await sendsTodayUtc(db, billing, partnerBilling(env)).catch(() => -1)
    : -1;
  const ccUsd = CC_BASE_USD - CC_BASE_USD * MARGIN - CC_BASE_USD * m;
  const tokenUsd =
    TOKEN_BASE_USD -
    TOKEN_BASE_USD * MARGIN -
    TOKEN_BASE_USD * m -
    TOKEN_BASE_USD * 0.5 * 0.8 * 0.5 * m;
  const raw = (usd: number) => (p && p > 0 ? usd / p : null);
  return {
    inputs: {
      markerValueUsd: m,
      ccUsdPrice: p,
      freeTxnsPerDay: free,
      sendsToday: used,
      /* Which account the count was made against — the first thing to check
       * when a charge looks wrong on a partner wallet. */
      billingUserId: billing,
    },
    cc: {
      usdTarget: ccUsd,
      rawFeeCc: raw(ccUsd),
      chargedCc: raw(ccUsd) == null ? null : ceilPos(raw(ccUsd)!),
    },
    token: {
      usdTarget: tokenUsd,
      rawFeeCc: raw(tokenUsd),
      chargedCc: raw(tokenUsd) == null ? null : ceilPos(raw(tokenUsd)!),
    },
    note: "chargedCc is rawFeeCc rounded UP to the nearest micro-CC (0.000001).",
  };
}

export async function ccSendFeeCc(
  db: DB,
  env: Env,
  userId: string,
  _isInternal: boolean
): Promise<number> {
  if (await withinFreeTier(db, env, userId)) return 0;
  const { p, m } = await feeInputs(env);
  if (!p || !(p > 0)) return flatFallback(env.FEE_CC_INTERNAL_CC, 5);
  const usd = CC_BASE_USD - CC_BASE_USD * MARGIN - CC_BASE_USD * m;
  return ceilPos(usd / p);
}

export async function tokenSendFeeCc(
  db: DB,
  env: Env,
  userId: string,
  _isInternal: boolean,
  sendAlreadyLogged = false
): Promise<number> {
  if (await withinFreeTier(db, env, userId, sendAlreadyLogged ? 1 : 0)) return 0;
  const { p, m } = await feeInputs(env);
  if (!p || !(p > 0)) return flatFallback(env.FEE_TOKEN_INTERNAL_CC, 8);
  const usd =
    TOKEN_BASE_USD -
    TOKEN_BASE_USD * MARGIN -
    TOKEN_BASE_USD * m -
    TOKEN_BASE_USD * 0.5 * 0.8 * 0.5 * m;
  return ceilPos(usd / p);
}

/* ------------------------------------------------------------------ *
 *  CIP-56 token fees — charged IN THE ASSET (not CC).
 *
 *  The formula gives a USD target; we convert it to the token being sent
 *  (÷ that token's USD price) and move that many token units from the
 *  sender to the operator party (SLAY_FEES_PARTY can't hold token-standard
 *  tokens — no registry relationship). Logged as a house_fee row in the
 *  token's own currency. Best-effort: never reverses the settled send.
 * ------------------------------------------------------------------ */

type TokenCurrency = "CBTC" | "CETH" | "TUSD" | "HECTO";

// Postgres stores every token at 1e8 units (see each `types.ts` SAT_PER_*).
const TOKEN_UNIT = 100_000_000;

const TOKEN_BAL: Record<
  TokenCurrency,
  { field: "balanceCbtc" | "balanceCeth" | "balanceTusd" | "balanceHecto"; col: AnyColumn }
> = {
  CBTC: { field: "balanceCbtc", col: schema.wallets.balanceCbtc },
  CETH: { field: "balanceCeth", col: schema.wallets.balanceCeth },
  TUSD: { field: "balanceTusd", col: schema.wallets.balanceTusd },
  HECTO: { field: "balanceHecto", col: schema.wallets.balanceHecto },
};

/** USD fee target for a CIP-56 token send. 0 within the free tier or when the
 *  formula goes non-positive (high marker value). Same value internal/external.
 *  `sendAlreadyLogged`: true from charge-time callers (the send row exists). */
export async function tokenFeeUsdTarget(
  db: DB,
  env: Env,
  userId: string,
  sendAlreadyLogged = false
): Promise<number> {
  if (await withinFreeTier(db, env, userId, sendAlreadyLogged ? 1 : 0)) return 0;
  const { m } = await feeInputs(env);
  const usd =
    TOKEN_BASE_USD -
    TOKEN_BASE_USD * MARGIN -
    TOKEN_BASE_USD * m -
    TOKEN_BASE_USD * 0.5 * 0.8 * 0.5 * m;
  return usd > 0 ? usd : 0;
}

/** USD price of one whole token. Null when unavailable (fee is then skipped). */
export async function tokenUsdPrice(env: Env, currency: TokenCurrency): Promise<number | null> {
  switch (currency) {
    case "TUSD":
      return 1;
    case "HECTO": {
      const r = Number(env.HECTO_USD_RATE ?? "0.00279361");
      return Number.isFinite(r) && r > 0 ? r : null;
    }
    case "CBTC": {
      const p = await getCbtcUsdPrice(env).catch(() => null);
      return p?.usd ?? null;
    }
    case "CETH": {
      const spots = await fetchOracleSpots(["eth"]).catch(() => null);
      const eth = spots?.get("eth");
      return eth && eth > 0 ? eth : null;
    }
  }
}

/**
 * Charge the CIP-56 send fee IN the token. `transfer(senderParty, units)` runs
 * the on-chain token transfer to the fee sink and returns its updateId. Returns
 * a short status string (never throws — fee failure must not undo the send).
 */
export async function chargeTokenFeeInAsset(
  db: DB,
  env: Env,
  userId: string,
  currency: TokenCurrency,
  transfer: (senderParty: string, units: number) => Promise<{ updateId: string }>
): Promise<string> {
  const usd = await tokenFeeUsdTarget(db, env, userId, /* sendAlreadyLogged */ true);
  if (usd <= 0) return "no-fee";
  const price = await tokenUsdPrice(env, currency);
  if (!price || !(price > 0)) return "no-price";
  const feeUnits = Math.ceil((usd / price) * TOKEN_UNIT);
  if (feeUnits <= 0) return "no-fee";

  const [w] = await db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.userId, userId))
    .limit(1);
  if (!w?.cantonAddress) return "no-canton";
  const meta = TOKEN_BAL[currency];
  const bal = Number((w as Record<string, unknown>)[meta.field] ?? 0);
  if (bal < feeUnits) return `insufficient-${currency}:${bal}`;

  try {
    const r = await transfer(w.cantonAddress, feeUnits);
    await db
      .update(schema.wallets)
      .set({ [meta.field]: sql`${meta.col} - ${feeUnits}` })
      .where(eq(schema.wallets.id, w.id));
    await db.insert(schema.transactions).values({
      id: crypto.randomUUID(),
      walletId: w.id,
      userId,
      type: "house_fee",
      currency,
      amount: -feeUnits,
      status: "confirmed",
      counterpartyHandle: "slay-fees",
      memo: `Transfer fee (${(feeUnits / TOKEN_UNIT).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} ${currency})`,
      refType: "chain_tx",
      refId: r.updateId,
    });
    return `charged:${feeUnits}`;
  } catch (e) {
    return "chain-failed:" + (e instanceof Error ? e.message.slice(0, 120) : String(e));
  }
}

/**
 * CIP-56 token-send fee, charged in CC (not in the token). The CC fee is moved
 * from the sender's CC amulet to SLAY_FEES_PARTY and logged as a house_fee row.
 * Best-effort: called after the token send settles, and never reverses it — if
 * the sender holds no CC the fee is simply skipped.
 */
export async function chargeTokenFeeCc(
  db: DB,
  env: Env,
  userId: string,
  isInternal: boolean
): Promise<string> {
  const feeCc = await tokenSendFeeCc(db, env, userId, isInternal, /* sendAlreadyLogged */ true);
  if (feeCc <= 0 || !env.SLAY_FEES_PARTY) return "no-fee";
  const [w] = await db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.userId, userId))
    .limit(1);
  if (!w?.cantonAddress) return "no-canton";
  if (w.cantonAddress === env.SLAY_FEES_PARTY) return "is-fees-party";
  const feeMicro = Math.round(feeCc * 1_000_000);
  if ((w.balance ?? 0) < feeMicro) return `insufficient-cc:${w.balance}`;
  try {
    const r = await transferAmulet(env, w.cantonAddress, env.SLAY_FEES_PARTY, feeCc, "Token transfer fee", null, null);
    await db
      .update(schema.wallets)
      .set({ balance: sql`${schema.wallets.balance} - ${feeMicro}` })
      .where(eq(schema.wallets.id, w.id));
    await db.insert(schema.transactions).values({
      id: crypto.randomUUID(),
      walletId: w.id,
      userId,
      type: "house_fee",
      currency: "CC",
      amount: -feeMicro,
      status: "confirmed",
      counterpartyHandle: "slay-fees",
      memo: `Token transfer fee (${feeCc} CC)`,
      refType: "chain_tx",
      refId: r.updateId,
    });
    return `charged:${feeCc}`;
  } catch (e) {
    return "chain-failed:" + (e instanceof Error ? e.message.slice(0, 120) : String(e));
  }
}
