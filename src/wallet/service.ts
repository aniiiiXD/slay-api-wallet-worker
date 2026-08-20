import { eq, sql, desc, isNull, and, isNotNull, gte } from "drizzle-orm";
import type { DB } from "../db";
import { schema } from "../db";
import type { Env } from "../env";
import {
  allocateUserParty,
  createHolding,
  exerciseTopup,
  exerciseTransfer,
  queryHoldings,
} from "../canton/client";
import {
  onboardUser as spliceOnboardUser,
  devnetTap as spliceDevnetTap,
  transfer as spliceTransfer,
} from "../splice/client";
import { grantUserActAs } from "../canton/ledger";
import { isPartyCreationDisabled } from "../slay-rewards/config";
import { selfCustodyOnboarding } from "../kms/provision";
import {
  fetchTransferPreapproval,
  transferAmulet,
  transferViaPreapprovalDirect,
} from "../splice/amulet";
import { SpliceError, transferViaPreapproval } from "../splice/client";
import { ccSendFeeCc } from "../fees/send-fees";
// `spliceTransfer` (the wallet-API path) is kept imported only for the
// devnet-tap and legacy fallback flows. For user→user @handle sends we
// now use `transferAmulet` (the Daml AmuletRules_Transfer path via the
// JSON Ledger API), because /api/validator/v0/wallet/transfer-offers
// gates calls on `sub ∈ validator-wallet-users` and rejects party-ID
// subjects with 403. See task #92 + #76 for the full diagnosis.
void spliceTransfer;
// (Re-export tightly typed helpers as needed; kept lean for tree-shaking.)

/**
 * Toggle between local Daml sandbox (canton/client.ts) and real Splice
 * validator (splice/client.ts) based on whether SPLICE_VALIDATOR_URL is set.
 *
 * - Unset → use canton/client against local `daml start` sandbox. This is
 *   the developer-loop path: no validator needed, fast iteration, but no
 *   real Canton Coin.
 * - Set   → use splice/client against the real Splice Validator API.
 *   Currency is real (Devnet) Canton Coin; transfers move on the global
 *   synchronizer.
 *
 * The two clients are intentionally kept in parallel because:
 *   1. Local dev shouldn't require a running DevNet box.
 *   2. We can fall back to sandbox if the validator is down (CI, demo).
 *   3. Removing canton/client is a one-line change once DevNet is stable.
 */
function useSpliceBackend(env: Env): boolean {
  return !!env.SPLICE_VALIDATOR_URL;
}

/**
 * All amounts in micro-CC (1 CC = 1_000_000 micro-CC). Integer math only —
 * no floating point. Matches USDC's on-chain precision and avoids the classic
 * "0.1 + 0.2 != 0.3" payout drift on settlement.
 *
 * Stored as plain JS `number` (not BigInt) because:
 *   - Drizzle's bigint columns use `mode: "number"` (so they JSON-serialize)
 *   - 2^53 / 1_000_000 ≈ 9 billion CC of headroom — past any plausible balance
 */
const MICRO_PER_CC = 1_000_000;

export const ccToMicro = (cc: number): number =>
  Math.round(cc * MICRO_PER_CC);

export const microToCc = (micro: number): number =>
  micro / MICRO_PER_CC;

export const newId = () => crypto.randomUUID();

/* ------------------------------------------------------------------ */
/*  Wallet provisioning                                                */
/*                                                                     */
/*  cantonAddress stays in the schema but is null until v2 wires real  */
/*  Canton — at which point it'll hold the user's Canton Party ID      */
/*  (e.g. "slayuser-abc::1220...::slay-participant"). For v1 we route  */
/*  100% via @handle.                                                  */
/* ------------------------------------------------------------------ */

/** Idempotently ensure the user has a wallet row. */
/**
 * The chain update id, or null when there isn't one.
 *
 * Canton update ids are blake2b multihashes: lowercase hex behind a "1220"
 * prefix. `chainTxId` in this file is NOT always one — when the on-chain leg
 * cannot be confirmed it becomes a `pending-…` placeholder (see the
 * chain_pending_reconciliation branch below), and other paths carry contract
 * ids or uuids.
 *
 * This gates what reaches transactions.chain_update_id, the join key to
 * canton_tx_fees. A placeholder written there would attach a real fee lookup
 * to a transaction that never hit the chain — and a miss on that join is read
 * as "no fee record", which the KPI endpoint reports as UNKNOWN. Wrong either
 * way, so only a real id goes in.
 */
function chainUpdateIdOf(refId: string | null | undefined): string | null {
  return refId && /^1220[0-9a-f]{60,}$/i.test(refId) ? refId : null;
}

export async function ensureWallet(db: DB, userId: string) {
  const existing = await db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.userId, userId))
    .limit(1);

  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(schema.wallets)
    .values({
      id: newId(),
      userId,
      balance: 0,
      locked: 0,
      // cantonAddress = null until real Canton Party ID assignment in v2
    })
    .returning();

  return created;
}

export async function getWallet(db: DB, userId: string) {
  const [w] = await db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.userId, userId))
    .limit(1);
  return w ?? null;
}


/* ------------------------------------------------------------------ */
/*  Canton party + initial SlayHolding contract                        */
/*  Called from the Better Auth user.create.after hook.                */
/* ------------------------------------------------------------------ */

export async function attachCantonParty(
  env: Env,
  db: DB,
  userId: string,
  email: string
) {
  const local = email.split("@")[0] || "user";
  const hint =
    local
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 30) || "user";

  // SELF-CUSTODY (the model). Everything below this block onboards through the
  // Splice validator, which mints a CUSTODIAL party hinted with the user's
  // email local part. looksExternalParty() only recognises `slay-money::`, so
  // such a user silently lands outside self-custody: balances read from the pg
  // shadow, sends can't be KMS-signed, no key of their own. Every party created
  // since the cutover went that way — including the leaderboard and coupon
  // paths, which call this directly to bypass the party-creation freeze.
  if (selfCustodyOnboarding(env)) {
    const { provisionSelfCustodyParty } = await import("../kms/provision");
    const r = await provisionSelfCustodyParty(env, db, userId);
    console.log(
      `[wallet.attachCantonParty] self-custody party user=${userId.slice(0, 8)}… ${r.partyId} reused=${r.reused}`
    );
    return;
  }

  // Splice path — onboard via the Validator API. Splice handles the party
  // allocation + holding-account setup atomically server-side. Returns the
  // user's party ID which we mirror into wallets.cantonAddress.
  if (useSpliceBackend(env)) {
    const onboarded = await spliceOnboardUser(env, hint);
    await db
      .update(schema.wallets)
      .set({ cantonAddress: onboarded.partyId })
      .where(eq(schema.wallets.userId, userId));

    // V2 on-chain wiring: grant the backend's service user actAs rights
    // on this party so we can submit bets/trades/etc on their behalf
    // via the Daml v2 Ledger API. Skip silently if the JSON_API isn't
    // configured yet — the call is best-effort, the user can still
    // function via the Splice Validator API endpoints.
    if (env.JSON_API_URL && env.LEDGER_USER_ID) {
      try {
        await grantUserActAs(env, env.LEDGER_USER_ID, onboarded.partyId);
      } catch (err) {
        // Logged but not thrown — Postgres state is committed; ops can
        // backfill the right later via the participant admin CLI.
        console.error("[wallet.attachCantonParty] grantUserActAs failed:", err);
      }
    }

    // ── Publish TransferPreapproval for inbound external CC ──────────
    // Without this, external Splice wallets fall back to the two-phase
    // TransferInstruction pattern when sending CC here, and the funds
    // get stuck pending Accept (buasku4 case 2026-06-19). With it,
    // sends route through TransferPreapproval_Send → direct settle.
    // Best-effort: a chain or auth failure here doesn't block signup;
    // the renewal/backfill cron picks it up later.
    try {
      const { ensureTransferPreapproval } = await import(
        "../splice/preapproval-setup"
      );
      await ensureTransferPreapproval(env, onboarded.partyId, { db });
    } catch (err) {
      console.error(
        "[wallet.attachCantonParty] ensureTransferPreapproval failed (non-fatal):",
        err instanceof Error ? err.message : String(err)
      );
    }
    return;
  }

  // Local sandbox path — kept as a fallback for dev without DevNet.
  //
  // 1. Mint a Canton party for this user
  const party = await allocateUserParty(env, hint);
  // 2. Create an initial empty SlayHolding (amount 0). Future top-ups will
  //    exercise Topup on this contract instead of creating new ones.
  await createHolding(env, party.identifier, 0);
  // 3. Mirror the party ID into the wallet row. cantonAddress was reserved
  //    for exactly this purpose (the column name pre-dated the realization
  //    that Canton parties aren't bech32 addresses).
  await db
    .update(schema.wallets)
    .set({ cantonAddress: party.identifier })
    .where(eq(schema.wallets.userId, userId));
}

/* ------------------------------------------------------------------ */
/*  Canton party RETRY path                                            */
/*                                                                     */
/*  attachCantonParty runs once in the signup hook (auth.ts) but is    */
/*  best-effort: if the Canton/Splice link is slow or down at that     */
/*  moment the catch swallows the error and the user is left with      */
/*  cantonAddress = NULL forever — no on-chain identity, external      */
/*  sends 409. We used to lazy-backfill inside GET /wallet but that    */
/*  could hang the wallet read (and AuthGate) for up to 30s, so it was */
/*  removed. These two helpers restore retry WITHOUT that hang:        */
/*                                                                     */
/*    - ensureCantonParty: idempotent, single-flight allocate. Safe to */
/*      call from a non-blocking GET /wallet trigger (waitUntil) AND    */
/*      from the cron — the in-flight guard stops the two from         */
/*      double-allocating a party in the same warm isolate, and the    */
/*      NULL re-check stops a re-allocate once one has landed.          */
/*    - backfillMissingCantonParties: cron sweep over party-less        */
/*      wallets, capped per tick to fit the Worker subrequest budget.   */
/* ------------------------------------------------------------------ */

// userIds with an attachCantonParty call in flight in THIS isolate.
// Allocation is not idempotent (a second call mints a second party), so
// we must never run two concurrently for the same user. Cross-isolate
// races are still possible but rare and low-cost; the NULL re-check
// below makes a duplicate run a no-op the moment the first one commits.
const partyInFlight = new Set<string>();

/**
 * Idempotent, single-flight Canton party allocation. No-ops when the
 * wallet already has a party or one is already being allocated for this
 * user. Throws on a genuine allocation failure so callers can log/retry.
 */
export async function ensureCantonParty(
  env: Env,
  db: DB,
  userId: string,
  email: string
): Promise<"created" | "exists" | "in-flight"> {
  const w = await getWallet(db, userId);
  if (w?.cantonAddress) return "exists";
  // Slay Reward program: party-less users must never get a party lazily.
  if (isPartyCreationDisabled(env)) return "exists";
  if (partyInFlight.has(userId)) return "in-flight";

  partyInFlight.add(userId);
  try {
    // Re-check under the in-flight guard in case another path landed a
    // party between our read and acquiring the slot.
    const fresh = await getWallet(db, userId);
    if (fresh?.cantonAddress) return "exists";
    await attachCantonParty(env, db, userId, email);
    return "created";
  } finally {
    partyInFlight.delete(userId);
  }
}

/**
 * Cron sweep: find wallets that never got a Canton party and retry, a
 * few per tick. Best-effort per user — one failure doesn't stop the rest.
 */
export async function backfillMissingCantonParties(
  env: Env,
  db: DB,
  maxPerTick = 5
): Promise<{ scanned: number; created: number; failed: number }> {
  if (isPartyCreationDisabled(env)) return { scanned: 0, created: 0, failed: 0 };
  const rows = await db
    .select({ userId: schema.wallets.userId })
    .from(schema.wallets)
    .where(isNull(schema.wallets.cantonAddress))
    .limit(Math.max(1, Math.min(maxPerTick, 25)));

  let created = 0;
  let failed = 0;
  for (const row of rows) {
    const [u] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, row.userId))
      .limit(1);
    if (!u?.email) continue;
    try {
      const r = await ensureCantonParty(env, db, row.userId, u.email);
      if (r === "created") {
        created++;
        console.log(
          `[cantonBackfill] allocated party user=${row.userId.slice(0, 8)}…`
        );
      }
    } catch (err) {
      failed++;
      console.warn(
        `[cantonBackfill] failed user=${row.userId.slice(0, 8)}…: ${
          err instanceof Error ? err.message.slice(0, 160) : String(err)
        }`
      );
    }
  }
  return { scanned: rows.length, created, failed };
}

/* ------------------------------------------------------------------ */
/*  Send (P2P transfer — recipient by @handle OR slay1... address)     */
/* ------------------------------------------------------------------ */

/** Strip whatever decoration the user typed and return the canonical handle. */
function normalizeHandleInput(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^@/, "")        // legacy "@maya" form
    .replace(/^slay@/, "")    // brand "slay@maya" form
    .replace(/@slay$/, "");   // older "maya@slay" form (back-compat)
}

/** Resolve a recipient string to either an internal user or an external
 * Canton party. Single source of truth for "what does this string mean".
 *
 * Returns a tagged union so `doSend()` can branch cleanly:
 *
 *   { kind: "internal", userId, displayHandle }
 *     → Slay-on-Slay transfer. Debit sender + credit recipient in
 *       Postgres, mirror via on-chain AmuletRules_Transfer.
 *
 *   { kind: "external", party, displayHandle }
 *     → Sender is paying out to a wallet outside Slay. Debit sender in
 *       Postgres, fire a single on-chain AmuletRules_Transfer to the
 *       external party. No recipient credit (they're not on Slay).
 *
 * Accepted input shapes:
 *   1. Slay handle ("@maya" / "slay@maya" / "maya")  → handle lookup
 *   2. Canton party id ("<name>::<hex-fingerprint>") → wallet lookup;
 *      falls through to external if no Slay wallet matches.
 *   3. Bare partial → treated as handle (back-compat).
 *
 * The old behaviour bounced external party ids to /withdraw via a 404.
 * That path used the Splice transfer-offers wallet API which now 403s,
 * so every external send was failing. transferAmulet (the JSON Ledger
 * API path used here) doesn't have that limitation — it takes any raw
 * party id on both sides — so a unified send path is both correct and
 * resilient.
 */
type ResolvedRecipient =
  | { kind: "internal"; userId: string; displayHandle: string }
  | { kind: "external"; party: string; displayHandle: string };

async function resolveRecipient(
  db: DB,
  to: string
): Promise<ResolvedRecipient> {
  const raw = to.trim();

  // Party-id shape: "<name>::<hex>". Try this BEFORE handle lookup so a
  // paste like "karan::1220..." doesn't get mangled by normalizeHandleInput.
  if (raw.includes("::")) {
    const [walletRow] = await db
      .select({ userId: schema.wallets.userId })
      .from(schema.wallets)
      .where(eq(schema.wallets.cantonAddress, raw))
      .limit(1);
    if (walletRow) {
      // Internal: party belongs to a Slay user. Look up their handle for
      // a friendlier display label.
      const [handleRow] = await db
        .select({ handle: schema.handles.handle })
        .from(schema.handles)
        .where(eq(schema.handles.userId, walletRow.userId))
        .limit(1);
      const display = handleRow?.handle
        ? `${handleRow.handle}@slay`
        : raw.split("::")[0];
      return { kind: "internal", userId: walletRow.userId, displayHandle: display };
    }
    // External party id. Display label is "<name>…" so the activity feed
    // shows something readable instead of the 80-char raw id.
    const namePart = raw.split("::")[0] ?? raw;
    const display = namePart.length > 18 ? `${namePart.slice(0, 18)}…` : namePart;
    return { kind: "external", party: raw, displayHandle: display };
  }

  // Otherwise treat as a Slay handle.
  const handle = normalizeHandleInput(raw);
  const [recipient] = await db
    .select({ userId: schema.handles.userId })
    .from(schema.handles)
    .where(eq(schema.handles.handle, handle))
    .limit(1);
  if (!recipient) throw new HttpError(404, `No user found for ${handle}@slay.`);
  return { kind: "internal", userId: recipient.userId, displayHandle: `${handle}@slay` };
}

/**
 * Feature flag — when USE_ONCHAIN_SEND is set, the Splice transfer
 * becomes the source of truth: we submit it FIRST, and only mirror
 * Postgres state if the chain leg succeeds. Same-validator transfers
 * with auto-accept settle in under a second on Splice, so the user
 * doesn't perceive a difference.
 *
 * Off: the original Postgres-first / best-effort-chain behaviour.
 */
function useOnchainSend(env: Env | null | undefined): boolean {
  if (!env) return false;
  const v = env.USE_ONCHAIN_SEND;
  return v === "1" || v === "true";
}

/* ------------------------------------------------------------------ *
 *  Send idempotency / singleflight                                     *
 *                                                                      *
 *  We've seen users back out of the Send screen during the slow chain *
 *  leg and retry, double-spending. The Send screen now generates a    *
 *  per-mount `clientTxId` and sends it in the request body; the       *
 *  server dedupes against that id, returning the first result for     *
 *  the second call instead of submitting the transfer twice.          *
 *                                                                      *
 *  Two layers of dedupe:                                              *
 *                                                                      *
 *    1. Isolate-local in-flight map. Catches the common case where    *
 *       both requests are in-flight on the same Worker isolate at the *
 *       same time (the user mashed retry before the first completed). *
 *                                                                      *
 *    2. Database lookback. We tag the resulting send transaction's    *
 *       memo with a `[idem:<clientTxId>]` suffix. On a subsequent     *
 *       request with the same clientTxId from the same user, we find *
 *       that row and return its id rather than re-executing. The      *
 *       in-memo tagging avoids a schema migration; we strip the       *
 *       suffix back out when serving the activity feed (see           *
 *       listTransactions).                                            *
 *                                                                      *
 *  Window is 5 minutes — same as the Send-screen mount lifetime.      *
 *  Beyond that, a "retry" is conceptually a new transaction.          *
 * ------------------------------------------------------------------ */

const IDEM_TAG_RE = /\s*\[idem:[A-Za-z0-9_]+\]\s*$/;
const inFlightSends = new Map<
  string,
  Promise<{ recipientUserId: string; transaction: { id: string } }>
>();

/** Strip the `[idem:xxx]` suffix when returning a memo to the user. */
export function stripIdemTag(memo: string | null | undefined): string | null {
  if (!memo) return memo ?? null;
  const cleaned = memo.replace(IDEM_TAG_RE, "").trim();
  return cleaned || null;
}

/** Look for a recent send tx from this user tagged with the same clientTxId. */
async function findExistingSendByClientTxId(
  db: DB,
  fromUserId: string,
  clientTxId: string
): Promise<{ id: string; counterpartyHandle: string | null } | null> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const rows = await db
    .select({
      id: schema.transactions.id,
      memo: schema.transactions.memo,
      counterpartyHandle: schema.transactions.counterpartyHandle,
      createdAt: schema.transactions.createdAt,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.userId, fromUserId))
    .orderBy(desc(schema.transactions.createdAt))
    .limit(20);
  for (const r of rows) {
    if (new Date(r.createdAt as unknown as string).getTime() < fiveMinAgo.getTime()) break;
    const m = r.memo ?? "";
    if (m.includes(`[idem:${clientTxId}]`)) {
      return { id: r.id, counterpartyHandle: r.counterpartyHandle };
    }
  }
  return null;
}

export async function send(
  db: DB,
  env: Env,
  fromUserId: string,
  to: string,
  amountMicro: number,
  memo?: string,
  clientTxId?: string
) {
  if (amountMicro <= 0) {
    throw new HttpError(400, "Send amount must be positive.");
  }

  /* ----- Singleflight + idempotency dedupe ------------------------- *
   *  If a clientTxId was provided, check both layers BEFORE we touch  *
   *  the database. The cheapest path is "second concurrent call" —    *
   *  the in-memory map has the in-flight promise and we just await    *
   *  the original. Falls back to DB lookback for cross-isolate retry. *
   * ----------------------------------------------------------------- */
  if (clientTxId) {
    const key = `${fromUserId}::${clientTxId}`;
    const existing = inFlightSends.get(key);
    if (existing) {
      console.log(`[send] singleflight HIT in-flight user=${fromUserId.slice(0, 8)} ctx=${clientTxId.slice(0, 10)}`);
      return existing;
    }
    const dbHit = await findExistingSendByClientTxId(db, fromUserId, clientTxId);
    if (dbHit) {
      console.log(`[send] singleflight HIT db user=${fromUserId.slice(0, 8)} ctx=${clientTxId.slice(0, 10)} tx=${dbHit.id.slice(0, 12)}`);
      // We don't have the recipientUserId on the tx row directly, but the
      // counterpartyHandle is enough for the client (it only uses the
      // returned id for navigation).
      return {
        recipientUserId: dbHit.counterpartyHandle ?? "",
        transaction: { id: dbHit.id } as never,
      };
    }
    // Reserve the slot, populate the promise below, evict on settle.
    const promise = (async () => doSend(db, env, fromUserId, to, amountMicro, memo, clientTxId))();
    inFlightSends.set(key, promise);
    // Evict ~60s after settle so a late retry still hits the DB lookback,
    // not a stale promise.
    promise.finally(() => {
      setTimeout(() => inFlightSends.delete(key), 60_000);
    });
    return promise;
  }

  return doSend(db, env, fromUserId, to, amountMicro, memo, undefined);
}

async function doSend(
  db: DB,
  env: Env,
  fromUserId: string,
  to: string,
  amountMicro: number,
  memo: string | undefined,
  clientTxId: string | undefined
) {
  const fromWallet = await getWallet(db, fromUserId);
  if (!fromWallet) throw new HttpError(404, "Sender wallet not found.");

  // SELF-CUSTODY (post-cutover): the spendable balance is the on-chain party
  // balance, not pg. Validate against it — the send draws from the party via
  // the KMS write-stack, so pg (which may hold non-deposit bonuses/winnings)
  // must NOT authorize spending funds that aren't on the user's key.
  const selfCustody = !!fromWallet.cantonAddress && (await import("../kms/router")).looksExternalParty(env, fromWallet.cantonAddress);
  if (selfCustody) {
    const { getCachedOnChainCcBalance } = await import("./balance-cache");
    const onCc = (await getCachedOnChainCcBalance(env, fromWallet.cantonAddress!)) ?? 0;
    if (Math.round(onCc * 1_000_000) < amountMicro) {
      throw new HttpError(400, "Insufficient balance.");
    }
  } else if (fromWallet.balance < amountMicro) {
    throw new HttpError(400, "Insufficient balance.");
  }

  const recipient = await resolveRecipient(db, to);
  if (recipient.kind === "internal" && recipient.userId === fromUserId) {
    throw new HttpError(400, "Can't send to yourself.");
  }
  if (recipient.kind === "external" && fromWallet.cantonAddress === recipient.party) {
    throw new HttpError(400, "Can't send to yourself.");
  }

  // Welcome bonus is bettable ONLY — not sendable or withdrawable. Cap EVERY
  // send (external cash-out AND internal Slay→Slay) at the withdrawable amount
  // = balance − non-withdrawable bonus (clamped to balance). This closes the
  // 2-hop leak where a user forwards the bonus to a friend who then cashes out.
  // Skipped for self-custody: their balance is the on-chain party (bonuses are
  // pg-only and never landed on the key), already validated above.
  if (!selfCustody) {
    const nonWithdrawable = Math.min(fromWallet.nonWithdrawable ?? 0, fromWallet.balance);
    if (amountMicro > fromWallet.balance - nonWithdrawable) {
      throw new HttpError(
        400,
        nonWithdrawable > 0
          ? `Your welcome bonus (${(nonWithdrawable / 1_000_000).toFixed(2)} CC) can be used to bet, but can't be sent or withdrawn.`
          : "Insufficient balance."
      );
    }
  }

  // Tag the memo with the idempotency token so the DB lookback can find
  // this row on a retry. User-facing display strips it back off via
  // stripIdemTag() in the activity feed serializer.
  const taggedMemo = clientTxId
    ? `${(memo ?? "").trim()}${memo?.trim() ? " " : ""}[idem:${clientTxId}]`
    : memo;

  /* ──────────────────────────────────────────────────────────────
   *  EXTERNAL SEND PATH
   *
   *  Recipient is a Canton party that doesn't belong to any Slay
   *  user. We fire a single on-chain AmuletRules_Transfer from the
   *  sender's party to the external party, then log a send-only tx
   *  in Postgres (no receive leg — they're not on Slay).
   *
   *  This used to bounce to /withdraw, which queued a Splice
   *  transfer-offers call. That endpoint now 403s on user-wallet
   *  JWT subjects, so every external send was failing. The JSON
   *  Ledger API path (transferAmulet) accepts raw party ids on
   *  both sides and inherits the AmuletRules cache + DSO-mismatch
   *  retry budget, so it just works.
   * ────────────────────────────────────────────────────────────── */
  if (recipient.kind === "external") {
    if (!fromWallet.cantonAddress) {
      throw new HttpError(
        409,
        "Your wallet hasn't been allocated a Canton party yet. Try again in a moment."
      );
    }
    const amountCc = amountMicro / 1_000_000;

    /* PRE-FLIGHT: TransferPreapproval lookup.
     *
     * AmuletRules_Transfer puts the recipient in actAs, which we only
     * have rights for on our own users (grantUserActAs at signup). For
     * external receivers, Splice's TransferPreapproval contract is the
     * receiver's pre-baked consent — without one, the chain leg returns
     * NO_SYNCHRONIZER because there's no synchronizer where all three
     * submitters can co-submit.
     *
     * Today we only USE the lookup to short-circuit with a clear error.
     * Stage 2 will swap the actual transfer to TransferPreapproval_Send,
     * which exercises the preapproval contract directly and skips the
     * recipient-in-actAs requirement.
     *
     * Lookup failure (scan-proxy down) is non-fatal — we let the chain
     * attempt proceed and surface whatever it returns. Failing on a
     * transport blip would be worse UX than the user's existing retry.
     */
    let preapproval = null;
    try {
      preapproval = await fetchTransferPreapproval(env, recipient.party);
    } catch (lookupErr) {
      console.warn(
        `[send.external] preapproval lookup failed (non-fatal) — receiver=${recipient.party.slice(0, 24)}… — ${lookupErr instanceof Error ? lookupErr.message.slice(0, 120) : String(lookupErr).slice(0, 120)}`
      );
    }
    if (preapproval === null) {
      // Confirmed: no preapproval published. The chain leg WILL fail
      // with NO_SYNCHRONIZER, so we don't burn a round-trip. The
      // operator-visible log carries the party for follow-up.
      console.log(
        `[send.external] receiver=${recipient.party.slice(0, 28)}… has no TransferPreapproval — refusing pre-flight`
      );
      throw new HttpError(
        422,
        "That wallet can't receive Slay payments. Ask the recipient to enable receiving in their Canton wallet."
      );
    }
    // Preapproval exists — log the host validator so we have a paper
    // trail when the chain side still fails (Stage 2 will use this).
    if (env.SPLICE_DEBUG === "1") {
      console.log(
        `[send.external] receiver=${recipient.party.slice(0, 24)}… preapproval OK provider=${preapproval.payload.provider.slice(0, 24)}…`
      );
    }

    /* STAGE 3: TransferPreapproval_Send via JSON Ledger API.
     *
     * Direct Daml choice exercise on the receiver's preapproval contract.
     * Authenticates as ledger-api-user (we have actAs on senderParty via
     * grantUserActAs at signup, and TransferPreapproval_Send's controller
     * is `sender` only — receiver doesn't need to be in actAs because
     * the preapproval contract IS their consent).
     *
     * This skips Splice's wallet API entirely, so we sidestep the
     * `sub ∈ validator-wallet-users` gate that 403'd the Stage 2
     * attempt. Same pattern as task #92 used for @handle sends.
     *
     * On failure we attempt one more fallback: the Splice wallet API
     * (transferViaPreapproval). It usually 403s, but if validator-wallet-
     * users was reconfigured at some point it might work. Cheap probe.
     */
    let chainTxId: string;
    try {
      const r = await transferViaPreapprovalDirect(
        env,
        fromWallet.cantonAddress,
        recipient.party,
        amountCc,
        memo ?? "",
        preapproval
      );
      chainTxId = r.updateId;
      console.log(
        `[send.external] direct preapproval-send OK — receiver=${recipient.party.slice(0, 24)}… amount=${amountCc} CC`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[send.external] direct preapproval-send failed — receiver=${recipient.party.slice(0, 24)}… msg=${msg.slice(0, 200)} — trying Splice wallet API`
      );

      // Fallback: Splice's wallet API. Same target choice on chain,
      // different transport. Almost always 403s for our users today,
      // but kept as a probe in case the validator config changes.
      try {
        const r = await transferViaPreapproval(
          env,
          fromWallet.cantonAddress,
          recipient.party,
          amountCc,
          memo
        );
        chainTxId = r.transactionId;
        console.log(
          `[send.external] wallet-api preapproval-send OK — receiver=${recipient.party.slice(0, 24)}… amount=${amountCc} CC status=${r.status}`
        );
      } catch (fallbackErr) {
        const fmsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        const fstatus = fallbackErr instanceof SpliceError ? fallbackErr.status : 0;
        console.error(
          `[send.external] both preapproval paths failed — receiver=${recipient.party.slice(0, 24)}… ` +
            `direct: ${msg.slice(0, 100)} | wallet-api ${fstatus}: ${fmsg.slice(0, 100)}`
        );

        // Map a couple of known terminal cases to actionable copy. Other
        // failures keep the generic retry message.
        if (msg.includes("NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT")) {
          throw new HttpError(
            422,
            "That wallet isn't reachable from Slay right now. Double-check the address."
          );
        }
        if (msg.includes("no Amulet with at least")) {
          throw new HttpError(
            409,
            "Your CC is split across several holdings, so this amount can't go out in one transfer. Try a smaller amount, or contact support to consolidate."
          );
        }
        if (msg.includes("Preapproval DSO mismatch")) {
          throw new HttpError(
            422,
            "That wallet is on a different Canton governance group. We can't reach it right now."
          );
        }
        // SPLICE_DEBUG surfaces the underlying ledger rejection to the caller
        // (operator diagnostics only — users always get the generic copy).
        throw new HttpError(
          502,
          env.SPLICE_DEBUG === "1"
            ? `send failed [direct: ${msg.slice(0, 300)}] [wallet-api ${fstatus}: ${fmsg.slice(0, 200)}]`
            : "Couldn't send to that wallet right now. Try again in a minute."
        );
      }
    }

    // Chain leg succeeded — charge the flat external fee (in CC, ADDED ON
    // TOP, to SLAY_FEES_PARTY as a SEPARATE transfer since preapproval-send
    // is single-output). Best-effort: a fee failure never reverses the
    // already-settled send.
    const extFeeCc = await ccSendFeeCc(db, env, fromUserId, /* isInternal */ false);
    let extFeeMicro = 0;
    if (extFeeCc > 0 && !!env.SLAY_FEES_PARTY && recipient.party !== env.SLAY_FEES_PARTY) {
      try {
        await transferAmulet(
          env,
          fromWallet.cantonAddress,
          env.SLAY_FEES_PARTY,
          extFeeCc,
          "Transfer fee",
          null,
          null
        );
        extFeeMicro = Math.round(extFeeCc * 1_000_000);
      } catch (feeErr) {
        console.warn(
          `[send.external] fee leg failed (send already settled) — ${feeErr instanceof Error ? feeErr.message.slice(0, 160) : String(feeErr)}`
        );
      }
    }

    // Mirror the debit (amount + fee if charged) in Postgres and log it.
    await db
      .update(schema.wallets)
      .set({ balance: sql`${schema.wallets.balance} - ${amountMicro + extFeeMicro}` })
      .where(eq(schema.wallets.id, fromWallet.id));

    const [extTx] = await db
      .insert(schema.transactions)
      .values({
        id: newId(),
        walletId: fromWallet.id,
        userId: fromUserId,
        type: "send",
        amount: -amountMicro,
        status: "confirmed",
        counterpartyHandle: recipient.displayHandle,
        memo: taggedMemo,
        refType: "chain_tx",
        refId: chainTxId,
        chainUpdateId: chainUpdateIdOf(chainTxId),
      })
      .returning();

    if (extFeeMicro > 0) {
      await db.insert(schema.transactions).values({
        id: newId(),
        walletId: fromWallet.id,
        userId: fromUserId,
        type: "house_fee",
        amount: -extFeeMicro,
        status: "confirmed",
        counterpartyHandle: "slay-fees",
        memo: `Transfer fee (${extFeeCc} CC)`,
        refType: "chain_tx",
        refId: chainTxId,
        chainUpdateId: chainUpdateIdOf(chainTxId),
      });
    }

    return { recipientUserId: "", transaction: extTx };
  }

  const toWallet = await ensureWallet(db, recipient.userId);
  const senderHandle = await getHandleForUser(db, fromUserId);

  /* ----------------------------------------------------------------
   *  ON-CHAIN PATH (USE_ONCHAIN_SEND=1) — Splice transfer first.
   *  If the chain leg fails the request errors and Postgres state
   *  is unchanged. If it succeeds we mirror the balances + log txs.
   *  Cross-validator transfers come back as "pending" — we still
   *  mirror as if settled because the Splice client guarantees
   *  eventual delivery (and the V1 audience is single-validator).
   * ---------------------------------------------------------------- */
  if (useOnchainSend(env)) {
    if (!fromWallet.cantonAddress || !toWallet.cantonAddress) {
      throw new HttpError(
        409,
        "On-chain send requires both parties to have a Canton party. Try Refresh."
      );
    }
    // CC transfer fee, taken FROM the amount (recipient gets amount − fee;
    // sender pays exactly what they typed). Fee is a 2nd atomic output to
    // SLAY_FEES_PARTY. Taking it from the amount (not on top) means the transfer
    // always fits the sender's single amulet — so it can NEVER be stripped for
    // "no spare balance", which was the intermittent "fee sometimes not
    // deducted" bug on whole-balance sends. Internal Slay→Slay send here.
    const flatFeeCc = await ccSendFeeCc(db, env, fromUserId, /* isInternal */ true);
    const applyFee =
      flatFeeCc > 0 &&
      !!env.SLAY_FEES_PARTY &&
      toWallet.cantonAddress !== env.SLAY_FEES_PARTY &&
      Math.round(flatFeeCc * 1_000_000) < amountMicro; // fee must be < amount
    const feeMicro = applyFee ? Math.round(flatFeeCc * 1_000_000) : 0;
    const netMicro = amountMicro - feeMicro; // recipient receives amount − fee
    const amountCc = amountMicro / 1_000_000;
    const feeCc = feeMicro / 1_000_000;
    let chainTxId: string;
    let chainTxRefType: "chain_tx" | "chain_pending_reconciliation" = "chain_tx";
    // Only the fee that ACTUALLY settled on-chain (2nd output survived the
    // transferAmulet retry fallback). Guards against phantom fees: DB charged
    // but slay-fees received nothing.
    let feeChargedMicro = 0;
    /* What the recipient actually received.
     *
     * `netMicro` is what we intended to send them — amount minus a fee we
     * hoped to collect. If the fee output is stripped during the retry, the
     * ledger hands that fee back to the recipient in the same submission, and
     * they receive the full amount instead. Which happened is knowable only
     * after the call, so every balance, watermark and row below reads this
     * rather than `netMicro`.
     *
     * Either way the sender is debited `recipientMicro + feeChargedMicro`,
     * which is always exactly the amount they asked to send. */
    let recipientMicro = netMicro;
    try {
      // transferAmulet submits a Daml AmuletRules_Transfer via the JSON
      // Ledger API (auth = ledger-user JWT), so it accepts raw party IDs
      // on both sides and inherits all our resilience: pre-flight DSO
      // check + 12-refetch loop + retry wrapper.
      const r = await transferAmulet(
        env,
        fromWallet.cantonAddress,
        toWallet.cantonAddress,
        netMicro / 1_000_000, // recipient gets amount − fee (fee taken from amount)
        memo ?? "",
        undefined,
        applyFee ? { receiver: env.SLAY_FEES_PARTY!, amountCc: feeCc } : null
      );
      chainTxId = r.updateId;
      // The retry fallback can drop the fee 2nd-output; only charge the fee if
      // it truly landed on-chain.
      feeChargedMicro = r.feeApplied ? feeMicro : 0;
      // Fee stripped → it went to the recipient, not to slay-fees.
      recipientMicro = r.feeApplied ? netMicro : amountMicro;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[send] on-chain leg failed — from=${fromWallet.cantonAddress.slice(0, 20)}… to=${toWallet.cantonAddress.slice(0, 20)}… amount=${amountCc} CC — ${msg.slice(0, 200)}`
      );
      // STRICT on-chain-only (default): the DB balances are mirrored ONLY after
      // the chain leg settles. A failed transfer therefore NEVER creates an
      // unbacked Postgres balance — that Postgres-only fallback is exactly the
      // vector the holdings-reconcile exploit weaponised (deposit → forward
      // Postgres-only → auto re-credit). Reject and let the user retry instead.
      // Flip SEND_POSTGRES_FALLBACK=1 ONLY if the network goes intermittent and
      // you accept the reconciliation risk.
      if (env.SEND_POSTGRES_FALLBACK !== "1") {
        throw new HttpError(
          502,
          "Couldn't complete the transfer on-chain right now. No funds moved — please try again in a moment."
        );
      }
      chainTxId = `pending-${newId().slice(0, 12)}`;
      chainTxRefType = "chain_pending_reconciliation";
    }

    // Mirror balances. Same sequential ordering as the Postgres-only
    // path — debit first so a crash mid-flight can't double-credit.
    // Sender pays net (to recipient) + fee (to slay-fees) = the full amount when
    // the fee settled; just net if the fee leg was dropped. Never more than
    // what left their amulet on-chain.
    await db
      .update(schema.wallets)
      .set({ balance: sql`${schema.wallets.balance} - ${recipientMicro + feeChargedMicro}` })
      .where(eq(schema.wallets.id, fromWallet.id));

    await db
      .update(schema.wallets)
      .set({ balance: sql`${schema.wallets.balance} + ${recipientMicro}` })
      .where(eq(schema.wallets.id, toWallet.id));

    // Deposit-mirror watermark sync — ONLY when the transfer SETTLED on-chain.
    // The on-chain move (sender −X, receiver +X) would otherwise make the
    // deposit-mirror (which credits on-chain INCREASES) re-credit the
    // receiver's +X as a phantom deposit. Bump both watermarks in step to keep
    // them equal to on-chain. A pending/Postgres-only fallback didn't move
    // on-chain, so watermarks stay put. NULL watermarks are left untouched —
    // first-touch baselining handles those correctly.
    if (chainTxRefType === "chain_tx") {
      await db
        .update(schema.wallets)
        .set({ onChainWatermark: sql`${schema.wallets.onChainWatermark} + ${recipientMicro}` })
        .where(and(eq(schema.wallets.id, toWallet.id), isNotNull(schema.wallets.onChainWatermark)));
      await db
        .update(schema.wallets)
        .set({ onChainWatermark: sql`${schema.wallets.onChainWatermark} - ${recipientMicro + feeChargedMicro}` })
        .where(and(eq(schema.wallets.id, fromWallet.id), isNotNull(schema.wallets.onChainWatermark)));
    }

    await db.insert(schema.transactions).values({
      id: newId(),
      walletId: fromWallet.id,
      userId: fromUserId,
      type: "send",
      // What actually reached the recipient. Send row + the house_fee row below
      // sum to the full amount debited, so a user's tx rows reconcile to their
      // balance change. In the free tier — and when the fee output was stripped
      // and returned to the recipient — feeChargedMicro is 0 and this is the
      // full amount.
      amount: -recipientMicro,
      status: "confirmed",
      counterpartyHandle: recipient.displayHandle,
      // Tagged memo carries the [idem:xxx] suffix so we can dedupe a
      // retry. Stripped before display by stripIdemTag().
      memo: taggedMemo,
      refType: chainTxRefType,
      refId: chainTxId,
      chainUpdateId: chainUpdateIdOf(chainTxId),
    });

    const [recvTxOnchain] = await db
      .insert(schema.transactions)
      .values({
        id: newId(),
        walletId: toWallet.id,
        userId: recipient.userId,
        type: "receive",
        amount: recipientMicro,
        status: "confirmed",
        counterpartyHandle: senderHandle,
        // Recipient's row uses the clean memo — the idem tag is the
        // sender's bookkeeping, not theirs.
        memo,
        refType: chainTxRefType,
        refId: chainTxId,
        chainUpdateId: chainUpdateIdOf(chainTxId),
      })
      .returning();

    if (feeChargedMicro > 0) {
      await db.insert(schema.transactions).values({
        id: newId(),
        walletId: fromWallet.id,
        userId: fromUserId,
        type: "house_fee",
        amount: -feeChargedMicro,
        status: "confirmed",
        counterpartyHandle: "slay-fees",
        memo: `Transfer fee (${flatFeeCc} CC)`,
        refType: chainTxRefType,
        refId: chainTxId,
        chainUpdateId: chainUpdateIdOf(chainTxId),
      });
    }

    return { recipientUserId: recipient.userId, transaction: recvTxOnchain };
  }
  // Fall through to the original Postgres-first / best-effort-chain path.

  // Neon HTTP driver doesn't support multi-statement transactions, so the
  // send is split into four sequential statements. Order matters:
  //   1. Debit sender FIRST. If we credit first and the debit fails, the
  //      recipient ends up with money the sender still has — money printer.
  //   2. Credit recipient.
  //   3. Log sender leg.
  //   4. Log receiver leg.
  // A crash between (1) and (2) leaves a debited sender with no recipient
  // credit — a hold we can refund manually. A crash between (2) and (3/4)
  // leaves wallet balances correct but missing a tx row, which is
  // reconcilable from the wallet history. Both are recoverable; the
  // money-printer case isn't.
  //
  // Long-term fix when we move off HTTP: switch to neon's pooled tcp driver
  // (or the canton ledger itself) and re-wrap this in a real transaction.

  await db
    .update(schema.wallets)
    .set({ balance: sql`${schema.wallets.balance} - ${amountMicro}` })
    .where(eq(schema.wallets.id, fromWallet.id));

  await db
    .update(schema.wallets)
    .set({ balance: sql`${schema.wallets.balance} + ${amountMicro}` })
    .where(eq(schema.wallets.id, toWallet.id));

  await db.insert(schema.transactions).values({
    id: newId(),
    walletId: fromWallet.id,
    userId: fromUserId,
    type: "send",
    amount: -amountMicro,
    status: "confirmed",
    counterpartyHandle: recipient.displayHandle,
    // Tagged memo carries the [idem:xxx] suffix for dedupe; stripped on read.
    memo: taggedMemo,
  });

  const [recvTx] = await db
    .insert(schema.transactions)
    .values({
      id: newId(),
      walletId: toWallet.id,
      userId: recipient.userId,
      type: "receive",
      amount: amountMicro,
      status: "confirmed",
      counterpartyHandle: senderHandle,
      // Recipient sees the clean memo — no idem tag.
      memo,
    })
    .returning();

  // Ledger leg — mirror the transfer on Canton via the configured backend.
  // Best-effort: Postgres is the source of truth for the user-facing balance;
  // a ledger failure logs but doesn't fail the send. Reconciliation job in v1.5.
  if (fromWallet.cantonAddress && toWallet.cantonAddress) {
    try {
      const amountCc = amountMicro / 1_000_000;
      if (useSpliceBackend(env)) {
        // Use the AmuletRules_Transfer path (JSON Ledger API) instead of
        // the wallet-API transfer-offer, for the same reason as the
        // primary onchain-send path above: the wallet API gates on
        // `sub ∈ validator-wallet-users` and rejects party-ID subjects
        // with 403.
        await transferAmulet(
          env,
          fromWallet.cantonAddress,
          toWallet.cantonAddress,
          amountCc,
          memo ?? ""
        );
      } else {
        // Sandbox — exercise Transfer on the sender's SlayHolding contract.
        const senderHoldings = await queryHoldings(env, fromWallet.cantonAddress);
        // Pick the first holding with enough balance. The model creates a
        // remainder contract on every Transfer, so a long-lived user will
        // accumulate multiple holdings — picking the largest one minimises
        // contract churn but "first sufficient" is fine for the spike.
        const sourceHolding = senderHoldings.find(
          (h) => parseFloat(h.payload.amount) >= amountCc
        );
        if (!sourceHolding) {
          console.error(
            "[ledger send] no holding with sufficient balance — Postgres and ledger now out of sync"
          );
        } else {
          await exerciseTransfer(
            env,
            sourceHolding.contractId,
            fromWallet.cantonAddress,
            toWallet.cantonAddress,
            amountCc
          );
        }
      }
    } catch (err) {
      console.error("[ledger send]", err);
    }
  }

  return { recipientUserId: recipient.userId, transaction: recvTx };
}

async function getHandleForUser(
  db: DB,
  userId: string
): Promise<string | null> {
  const [row] = await db
    .select({ handle: schema.handles.handle })
    .from(schema.handles)
    .where(eq(schema.handles.userId, userId))
    .limit(1);
  return row ? `slay@${row.handle}` : null;
}

/* ------------------------------------------------------------------ */
/*  Read endpoints                                                     */
/* ------------------------------------------------------------------ */

export async function listTransactions(
  db: DB,
  userId: string,
  limit: number = 50
) {
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.userId, userId))
    .orderBy(desc(schema.transactions.createdAt))
    .limit(limit);
  // Strip the `[idem:xxx]` suffix used by the singleflight layer in send().
  // It's an implementation detail; the user should only see what they typed.
  return rows.map((r) => ({ ...r, memo: stripIdemTag(r.memo) }));
}

export type WalletTransactionRow = typeof schema.transactions.$inferSelect;

/**
 * Hard ceiling on a time-windowed read (see listTransactionsSince).
 *
 * 5000 because:
 *   - A serialized activity row is ~250-350 bytes of JSON, so a full page is
 *     ~1.5 MB — comfortably inside the Worker's response/memory budget, and
 *     still one round trip.
 *   - Over the 30-day window the KPI dashboard asks for, 5000 rows is ~166
 *     transactions a day, sustained. The busiest real Slay account is two
 *     orders of magnitude under that, so in practice the cap never binds.
 *   - `transactions` has NO index on (user_id, created_at) today — only the
 *     PK and the FKs — so this is a filtered scan + sort, same as the
 *     existing limit path. The cap bounds what we ship, not what Postgres
 *     reads; if windowed reads ever get hot, that composite index is the
 *     fix, and it belongs in the schema, not here.
 * It exists so `since=1970-01-01` can't ask Postgres (or the isolate) to
 * materialise an account's entire lifetime. When it DOES bind the caller is
 * told — see the `truncated` flag; a cap that lies is the bug this whole
 * parameter was added to fix.
 */
export const MAX_SINCE_ROWS = 5000;

/**
 * Every transaction for `userId` with createdAt >= `since`, newest first,
 * capped at `maxRows`.
 *
 * Ordering is deliberately the same DESC as listTransactions, which means
 * the cap (when it bites) drops the OLDEST rows in the window, never the
 * newest. That keeps the truncation direction predictable: the caller still
 * gets a contiguous window ending at "now", it just starts later than asked
 * — and `truncated` + the createdAt of the last row say exactly where.
 */
export async function listTransactionsSince(
  db: DB,
  userId: string,
  since: Date,
  maxRows: number = MAX_SINCE_ROWS
): Promise<{ rows: WalletTransactionRow[]; truncated: boolean }> {
  const rows = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        gte(schema.transactions.createdAt, since)
      )
    )
    .orderBy(desc(schema.transactions.createdAt))
    // Ask for one row MORE than we'll return: if it comes back, the window
    // overflowed the cap. Cheaper than a second COUNT(*) round trip, and it
    // can't disagree with the page we just read.
    .limit(maxRows + 1);

  const truncated = rows.length > maxRows;
  const page = truncated ? rows.slice(0, maxRows) : rows;
  return {
    rows: page.map((r) => ({ ...r, memo: stripIdemTag(r.memo) })),
    truncated,
  };
}

/* ------------------------------------------------------------------ *
 *  User positions (unified bets + trades)                              *
 *                                                                      *
 *  Bets live in `bets` (parimutuel markets) and trades live in         *
 *  `positions` (Long/Short directional). The app's new Positions page  *
 *  shows them as one list with All / Open / Closed filtering. We       *
 *  serialize both into a single shape on the server so the client      *
 *  doesn't have to maintain two parallel lists or merge-sort by date.  *
 * ------------------------------------------------------------------ */

export type UnifiedPosition = {
  id: string;
  kind: "bet" | "trade";
  // 'open' covers placed bets + open trades.
  // 'closed' covers won/lost/refunded bets and closed trades.
  status: "open" | "closed";
  amountCc: number;
  /** Bet payout or trade close stake+pnl on settle. Null while open. */
  payoutCc: number | null;
  /** Realised pnl for trades; nullable for bets (we use payout instead). */
  pnlCc: number | null;
  createdAt: string;
  closedAt: string | null;

  // Bet-only fields
  marketId?: string;
  marketQuestion?: string;
  marketEmoji?: string | null;
  optionId?: string;
  optionLabel?: string;
  // Trade-only fields
  assetId?: string;
  side?: "long" | "short";
  entryPriceUsd?: string;
  exitPriceUsd?: string | null;
};

export async function listPositions(
  db: DB,
  userId: string
): Promise<UnifiedPosition[]> {
  const [betRows, tradeRows] = await Promise.all([
    db
      .select({
        id: schema.bets.id,
        marketId: schema.bets.marketId,
        optionId: schema.bets.optionId,
        amount: schema.bets.amount,
        status: schema.bets.status,
        payout: schema.bets.payout,
        createdAt: schema.bets.createdAt,
        settledAt: schema.bets.settledAt,
        marketQuestion: schema.markets.question,
        marketEmoji: schema.markets.emoji,
        marketOptions: schema.markets.options,
      })
      .from(schema.bets)
      .leftJoin(schema.markets, eq(schema.markets.id, schema.bets.marketId))
      .where(eq(schema.bets.userId, userId))
      .orderBy(desc(schema.bets.createdAt)),
    db
      .select()
      .from(schema.positions)
      .where(eq(schema.positions.userId, userId))
      .orderBy(desc(schema.positions.openedAt)),
  ]);

  const bets: UnifiedPosition[] = betRows.map((b) => {
    const optionLabel =
      (b.marketOptions as Array<{ id: string; label: string }> | null)?.find(
        (o) => o.id === b.optionId
      )?.label ?? b.optionId;
    return {
      id: b.id,
      kind: "bet",
      status: b.status === "placed" ? "open" : "closed",
      amountCc: microToCc(b.amount),
      payoutCc: b.payout != null ? microToCc(b.payout) : null,
      pnlCc: null,
      createdAt: (b.createdAt as unknown as Date).toISOString(),
      closedAt:
        b.settledAt != null
          ? (b.settledAt as unknown as Date).toISOString()
          : null,
      marketId: b.marketId,
      marketQuestion: b.marketQuestion ?? undefined,
      marketEmoji: b.marketEmoji ?? null,
      optionId: b.optionId,
      optionLabel,
    };
  });

  const trades: UnifiedPosition[] = tradeRows.map((t) => ({
    id: t.id,
    kind: "trade",
    status: t.status === "open" ? "open" : "closed",
    amountCc: microToCc(t.amount),
    payoutCc:
      t.pnl != null ? microToCc(t.amount) + microToCc(t.pnl) : null,
    pnlCc: t.pnl != null ? microToCc(t.pnl) : null,
    createdAt: (t.openedAt as unknown as Date).toISOString(),
    closedAt:
      t.closedAt != null
        ? (t.closedAt as unknown as Date).toISOString()
        : null,
    assetId: t.assetId,
    side: t.side as "long" | "short",
    entryPriceUsd: t.entryPriceUsd as unknown as string,
    exitPriceUsd:
      t.exitPriceUsd != null ? (t.exitPriceUsd as unknown as string) : null,
  }));

  // Merge + sort by createdAt desc.
  return [...bets, ...trades].sort((a, b) =>
    a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0
  );
}

/* ------------------------------------------------------------------ */
/*  Handle reservation                                                 */
/* ------------------------------------------------------------------ */

const HANDLE_RE = /^[a-z0-9._-]{2,32}$/;

export async function setHandle(db: DB, userId: string, handle: string) {
  const normalized = handle.toLowerCase().replace(/^@/, "");
  if (!HANDLE_RE.test(normalized)) {
    throw new HttpError(
      400,
      "Handles must be 2–32 chars, lowercase letters/digits/.-_ only."
    );
  }

  // Neon HTTP driver doesn't support multi-statement transactions, so we do
  // this sequentially and rely on the table's unique constraints
  //   - handles.handle is PRIMARY KEY (one owner per handle)
  //   - uniqueIndex on handles.user_id (one handle per user)
  // to keep us honest. There's a tiny race window between the lookup and the
  // insert; the PK violation in step 4 catches that case.

  // 1. See who (if anyone) currently owns this handle.
  const [taken] = await db
    .select({ userId: schema.handles.userId })
    .from(schema.handles)
    .where(eq(schema.handles.handle, normalized))
    .limit(1);

  // 2. Already mine → idempotent success.
  if (taken && taken.userId === userId) {
    return { handle: `slay@${normalized}` };
  }
  // 3. Owned by someone else → conflict.
  if (taken) {
    throw new HttpError(409, `@${normalized} is already taken.`);
  }

  // 4. Drop any previous handle this user had (handle changes).
  await db.delete(schema.handles).where(eq(schema.handles.userId, userId));

  // 5. Insert the new row. If a competing request beat us to it between
  // steps 1 and 5, the PK on `handle` will throw — we surface that as 409.
  try {
    await db.insert(schema.handles).values({ handle: normalized, userId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique constraint/i.test(msg)) {
      throw new HttpError(409, `@${normalized} is already taken.`);
    }
    throw err;
  }

  return { handle: `slay@${normalized}` };
}

/* ------------------------------------------------------------------ */
/*  KYC fields — legal name + country                                  */
/*                                                                     */
/*  Stored on the wallets row (1:1 with users) so AuthGate can route   */
/*  based on which is still missing without joining tables.            */
/* ------------------------------------------------------------------ */

export async function setProfile(
  db: DB,
  userId: string,
  firstName: string,
  lastName: string
) {
  const fn = firstName.trim();
  const ln = lastName.trim();
  if (fn.length < 1 || fn.length > 64) {
    throw new HttpError(400, "First name must be 1–64 characters.");
  }
  if (ln.length < 1 || ln.length > 64) {
    throw new HttpError(400, "Last name must be 1–64 characters.");
  }
  await ensureWallet(db, userId);
  await db
    .update(schema.wallets)
    .set({ firstName: fn, lastName: ln })
    .where(eq(schema.wallets.userId, userId));
  return { firstName: fn, lastName: ln };
}

export async function setCountry(db: DB, userId: string, country: string) {
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new HttpError(400, "Country must be a 2-letter ISO code (e.g. US, IN, GB).");
  }
  await ensureWallet(db, userId);
  await db
    .update(schema.wallets)
    .set({ country: code })
    .where(eq(schema.wallets.userId, userId));
  return { country: code };
}

/* ------------------------------------------------------------------ */
/*  Auto-provision (called from Better Auth user.create.after hook)    */
/*  Creates the wallet + address. Handle is NOT auto-generated — the   */
/*  user picks it on the (auth)/pick-handle onboarding step.           */
/* ------------------------------------------------------------------ */

export async function autoProvisionUser(
  db: DB,
  userId: string,
  _email: string,
  fullName?: string | null
) {
  const wallet = await ensureWallet(db, userId);
  // If Better Auth's user.name is populated (OAuth providers like Google
  // pass through the verified display name), split into first + last and
  // pre-fill the wallet so the user skips the /legal-name screen entirely.
  // Empty name (email-OTP — no profile available) leaves the fields null,
  // and AuthGate routes the user through /legal-name as normal.
  //
  // Don't overwrite if firstName is already set — handles the case where
  // a returning OTP user gets account-linked to a Google account on a
  // later sign-in (we don't want to clobber the name they typed manually).
  if (
    fullName &&
    fullName.trim().length > 0 &&
    !wallet.firstName &&
    !wallet.lastName
  ) {
    const trimmed = fullName.trim().replace(/\s+/g, " ");
    const parts = trimmed.split(" ");
    const firstName = parts[0];
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
    await db
      .update(schema.wallets)
      .set({ firstName, lastName })
      .where(eq(schema.wallets.userId, userId));
  }
  // Handle is intentionally left null. AuthGate routes the user to
  // /pick-handle on first launch and they choose their own.
}

/* ------------------------------------------------------------------ */
/*  Handle availability check (used by the pick-handle screen)         */
/* ------------------------------------------------------------------ */

export type HandleCheck =
  | { available: true }
  | { available: false; reason: "INVALID_FORMAT" | "TAKEN" };

export async function checkHandleAvailable(
  db: DB,
  handle: string,
  excludeUserId?: string
): Promise<HandleCheck> {
  const normalized = handle.toLowerCase().replace(/^@/, "");
  if (!HANDLE_RE.test(normalized)) {
    return { available: false, reason: "INVALID_FORMAT" };
  }
  const [taken] = await db
    .select({ userId: schema.handles.userId })
    .from(schema.handles)
    .where(eq(schema.handles.handle, normalized))
    .limit(1);
  if (!taken) return { available: true };
  if (excludeUserId && taken.userId === excludeUserId) return { available: true };
  return { available: false, reason: "TAKEN" };
}

/* ------------------------------------------------------------------ */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
