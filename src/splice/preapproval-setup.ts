/**
 * Splice CC TransferPreapproval — INBOUND setup.
 *
 * Why this file exists
 * --------------------
 * Slay users receive external CC sends. Without a published
 * TransferPreapproval contract, external Splice wallets fall back to the
 * two-phase TransferInstruction pattern — sender creates an instruction,
 * receiver must exercise TransferInstruction_Accept. We don't run that
 * accept-side cron for CC (and even if we did, the choice requires a
 * complex ChoiceContext — external-party-config-state and friends).
 *
 * Result before this module existed: every external CC send to a Slay
 * user got stuck as a pending TI until the 24h expiry. The buasku4 case
 * (2026-06-19) caught one mid-air.
 *
 * The fix is what Splice's standard wallet has done all along: publish a
 * TransferPreapproval contract for each user. Once it's on chain, the
 * sender's wallet looks it up via scan-proxy and routes through
 * TransferPreapproval_Send (direct settlement). The CC lands as an
 * Amulet for the receiver instantly. Event-mirror catches the creation
 * and credits Postgres.
 *
 * Endpoint
 * --------
 * Splice validator-app exposes:
 *
 *   POST /api/validator/v0/wallet/transfer-preapprovals/setup
 *
 * Authenticated as the RECEIVER's wallet user (sub = receiver's party id
 * when registered, or an administrator user with actAs over the receiver).
 * Returns the new contract id. We persist it on wallets.transfer_-
 * preapproval_cid + expires_at so the renewal cron can spot near-expiry
 * entries and refresh them.
 *
 * Idempotency
 * -----------
 * Endpoint is idempotent server-side — re-calling for a user who already
 * has a live preapproval returns the existing cid. We also short-circuit
 * client-side if our cache row is fresh AND not within the renewal window.
 *
 * Renewal cadence
 * ---------------
 * Splice's default validity window is ~90 days. We refresh when within 7
 * days of expiry via renewExpiringPreapprovals() called from the 5-min
 * cron (cheap no-op if nothing is expiring).
 */

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Env } from "../env";
import type { DB } from "../db";
import { createDb, schema } from "../db";
import { SpliceError } from "./client";
import { recordNetworkFee } from "../fees/network-fees";
import { exercise, operatorParty, LedgerCallError, type TemplateId } from "../canton/ledger";
import {
  getAmuletRulesDisclosed,
  getOpenAndIssuingRoundsDisclosed,
  findOperatorAmulet,
  setCachedOperatorAmulet,
  invalidateCachedOperatorAmulet,
} from "./amulet";
import type { DisclosedContract } from "../canton/ledger";

/* ────────── Constants ────────── */

/** Splice's default preapproval validity is ~90 days. */
const EXPECTED_VALIDITY_DAYS = 90;
/** Recreate when within this window of expiry. */
const RENEWAL_THRESHOLD_DAYS = 7;
/** Per-batch cap on renewal cron (Worker CPU budget). */
const DEFAULT_RENEW_BATCH = 25;

/* ────────── Public API ────────── */

export type EnsurePreapprovalResult = {
  partyId: string;
  preapprovalCid: string;
  expiresAt: Date | null;
  /** True if we reused a cached row; false if we just minted via Splice. */
  fromCache: boolean;
};

/**
 * Ensure a TransferPreapproval is published for `receiverParty`.
 *
 *   - If a fresh row exists in wallets.transfer_preapproval_cid AND it's
 *     more than RENEWAL_THRESHOLD_DAYS from expiry → return it.
 *   - Otherwise → call Splice's setup endpoint, cache the result, return.
 *
 * Throws on real failures (Splice unreachable, party not registered,
 * etc.). Caller decides whether to retry.
 */
export async function ensureTransferPreapproval(
  env: Env,
  receiverParty: string,
  options: { db?: DB; forceFresh?: boolean } = {}
): Promise<EnsurePreapprovalResult> {
  if (!env.SPLICE_VALIDATOR_URL) {
    throw new SpliceError(
      500,
      "SPLICE_VALIDATOR_URL not set — required to publish TransferPreapprovals."
    );
  }
  if (!receiverParty) {
    throw new SpliceError(400, "receiverParty required.");
  }

  const db = options.db ?? createDb(env.DATABASE_URL);

  // ── Cache fast-path ────────────────────────────────────────────────
  if (!options.forceFresh) {
    const [row] = await db
      .select({
        cid: schema.wallets.transferPreapprovalCid,
        exp: schema.wallets.transferPreapprovalExpiresAt,
      })
      .from(schema.wallets)
      .where(eq(schema.wallets.cantonAddress, receiverParty))
      .limit(1);

    if (row?.cid) {
      const renewalCutoff = new Date(
        Date.now() + RENEWAL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
      );
      const expiryOk =
        !row.exp || row.exp.getTime() > renewalCutoff.getTime();
      if (expiryOk) {
        return {
          partyId: receiverParty,
          preapprovalCid: row.cid,
          expiresAt: row.exp ?? null,
          fromCache: true,
        };
      }
      console.log(
        `[preapproval-setup] cache STALE (expiring) party=${receiverParty.slice(0, 30)}… ` +
          `expiresAt=${row.exp?.toISOString() ?? "<none>"} — minting fresh`
      );
    }
  }

  // ── Mint via direct Daml exercise ──────────────────────────────────
  // Splice's REST API doesn't expose admin-create for preapprovals
  // (verified 2026-06-19 via OpenAPI grep — only GET/DELETE/LIST). So
  // we exercise AmuletRules_CreateTransferPreapproval directly via the
  // JSON Ledger API, using our actAs grants on both operator and the
  // receiver party. Same pattern as splice/amulet.ts:transferAmulet.
  const result = await exerciseCreateTransferPreapproval(env, receiverParty);

  await db
    .update(schema.wallets)
    .set({
      transferPreapprovalCid: result.preapprovalCid,
      transferPreapprovalExpiresAt: result.expiresAt,
    })
    .where(eq(schema.wallets.cantonAddress, receiverParty));

  console.log(
    `[preapproval-setup] OK party=${receiverParty.slice(0, 30)}… ` +
      `cid=${result.preapprovalCid.slice(0, 24)}… expires=${result.expiresAt.toISOString()}`
  );

  return {
    partyId: receiverParty,
    preapprovalCid: result.preapprovalCid,
    expiresAt: result.expiresAt,
    fromCache: false,
  };
}

/**
 * Invalidate the cached preapproval cid. Used when chain rejects a
 * referenced preapproval as inactive (race between cache write and
 * archive).
 */
export async function invalidateCachedPreapproval(
  env: Env,
  receiverParty: string
): Promise<void> {
  const db = createDb(env.DATABASE_URL);
  await db
    .update(schema.wallets)
    .set({
      transferPreapprovalCid: null,
      transferPreapprovalExpiresAt: null,
    })
    .where(eq(schema.wallets.cantonAddress, receiverParty));
}

/* ────────── Renewal cron ────────── */

export type RenewalResult = {
  scanned: number;
  renewed: number;
  failed: number;
  failures: Array<{ partyId: string; error: string }>;
};

/**
 * Find preapprovals expiring within RENEWAL_THRESHOLD_DAYS days (or with
 * NULL expiry — happens when the original setup didn't surface an
 * expiry timestamp) and recreate them. Bounded by maxBatch so a backlog
 * doesn't blow the Worker CPU budget — excess rows roll to the next tick.
 */
export async function renewExpiringPreapprovals(
  env: Env,
  options: { maxBatch?: number } = {}
): Promise<RenewalResult> {
  const stats: RenewalResult = {
    scanned: 0,
    renewed: 0,
    failed: 0,
    failures: [],
  };
  if (!env.SPLICE_VALIDATOR_URL) return stats;

  const maxBatch = options.maxBatch ?? DEFAULT_RENEW_BATCH;
  const db = createDb(env.DATABASE_URL);
  const cutoff = new Date(
    Date.now() + RENEWAL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  );

  // Renew rows that:
  //   - HAVE a canton party (else we can't address the wallet user)
  //   - Either have NULL expiresAt OR expire within the threshold
  //   - But excluding rows with NULL cid AND NULL expiry (means we never
  //     successfully published; backfill endpoint handles those)
  const rows = await db
    .select({
      partyId: schema.wallets.cantonAddress,
      exp: schema.wallets.transferPreapprovalExpiresAt,
    })
    .from(schema.wallets)
    .where(
      and(
        sql`${schema.wallets.cantonAddress} IS NOT NULL`,
        sql`${schema.wallets.transferPreapprovalCid} IS NOT NULL`,
        or(
          isNull(schema.wallets.transferPreapprovalExpiresAt),
          lte(schema.wallets.transferPreapprovalExpiresAt, cutoff)
        )
      )
    )
    .limit(maxBatch);

  stats.scanned = rows.length;
  if (rows.length === 0) return stats;

  console.log(
    `[preapproval-setup.renew] scanning ${rows.length} entries up to ${cutoff.toISOString()}`
  );

  for (const r of rows) {
    if (!r.partyId) continue;
    try {
      await ensureTransferPreapproval(env, r.partyId, {
        db,
        forceFresh: true,
      });
      stats.renewed++;
    } catch (err) {
      stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      stats.failures.push({ partyId: r.partyId, error: msg.slice(0, 200) });
      console.error(
        `[preapproval-setup.renew] FAIL party=${r.partyId.slice(0, 30)}… — ${msg.slice(0, 200)}`
      );
    }
  }

  console.log(
    `[preapproval-setup.renew] done scanned=${stats.scanned} renewed=${stats.renewed} failed=${stats.failed}`
  );
  return stats;
}

/* ────────── Bulk backfill (admin endpoint) ────────── */

export type BackfillResult = {
  requested: number;
  candidatesFound: number;
  setup: number;
  failed: number;
  failures: Array<{ partyId: string; error: string }>;
  partyIds: string[];
  /** True if the loop stopped mid-batch due to a credit-exhaustion signal. */
  bailedEarly: boolean;
};

/**
 * Find users who have a Canton party allocated but NO preapproval cached,
 * and publish one for each. Used to backfill existing users post-deploy.
 *
 * Caps at `count` per call to keep the Worker tick under budget.
 */
export async function backfillPreapprovalsForAllUsers(
  env: Env,
  count: number
): Promise<BackfillResult> {
  const stats: BackfillResult = {
    requested: count,
    candidatesFound: 0,
    setup: 0,
    failed: 0,
    failures: [],
    partyIds: [],
    bailedEarly: false,
  };
  if (!env.SPLICE_VALIDATOR_URL) {
    throw new SpliceError(500, "SPLICE_VALIDATOR_URL not set.");
  }
  if (!Number.isFinite(count) || count <= 0) {
    throw new SpliceError(400, "count must be a positive integer.");
  }

  const db = createDb(env.DATABASE_URL);
  const candidates = await db
    .select({ partyId: schema.wallets.cantonAddress })
    .from(schema.wallets)
    .innerJoin(schema.users, eq(schema.users.id, schema.wallets.userId))
    .where(
      and(
        sql`${schema.wallets.cantonAddress} IS NOT NULL`,
        isNull(schema.wallets.transferPreapprovalCid),
        eq(schema.wallets.preapprovalSkipped, false),
        // Skip synthetic/bot accounts (@slay.synthetic) — they never receive
        // external CC, so minting a preapproval just burns operator fee CC.
        sql`${schema.users.email} NOT LIKE '%@slay.synthetic'`
      )
    )
    .limit(count);

  stats.candidatesFound = candidates.length;
  if (candidates.length === 0) {
    console.log(
      `[preapproval-setup.backfill] no candidates — every party already has a preapproval cached.`
    );
    return stats;
  }

  console.log(
    `[preapproval-setup.backfill] backfilling ${candidates.length} preapprovals sequentially`
  );

  for (const c of candidates) {
    if (!c.partyId) continue;
    try {
      const r = await ensureTransferPreapproval(env, c.partyId, { db });
      if (!r.fromCache) {
        stats.setup++;
        stats.partyIds.push(c.partyId);
      }
    } catch (err) {
      stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      stats.failures.push({ partyId: c.partyId, error: msg.slice(0, 200) });
      console.error(
        `[preapproval-setup.backfill] FAIL party=${c.partyId.slice(0, 30)}… — ${msg.slice(0, 200)}`
      );

      // Permanent failures — mark the wallet so we stop trying.
      // UNKNOWN_SUBMITTERS = party hosted on a different participant; we
      // can never actAs on it. NO_SYNCHRONIZER = no synchronizer where
      // operator + receiver can both submit; structural, never resolves.
      const isPermanent =
        msg.includes("UNKNOWN_SUBMITTERS") ||
        msg.includes("NO_SYNCHRONIZER");
      if (isPermanent) {
        try {
          const reason = msg.includes("UNKNOWN_SUBMITTERS")
            ? "UNKNOWN_SUBMITTERS"
            : "NO_SYNCHRONIZER";
          await db
            .update(schema.wallets)
            .set({
              preapprovalSkipped: true,
              preapprovalSkipReason: reason,
            })
            .where(eq(schema.wallets.cantonAddress, c.partyId));
          console.warn(
            `[preapproval-setup.backfill] SKIPPED party=${c.partyId.slice(0, 30)}… reason=${reason} — wallet flagged, excluded from future ticks`
          );
        } catch (markErr) {
          console.error(
            `[preapproval-setup.backfill] failed to flag party=${c.partyId.slice(0, 30)}… as skipped: ${markErr instanceof Error ? markErr.message : String(markErr)}`
          );
        }
        continue;
      }

      // Bail out on traffic-credit exhaustion — every subsequent attempt
      // in this batch will fail the same way, burning the sequencer's
      // backpressure queue for nothing. Next cron tick retries.
      if (
        msg.includes("SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT") ||
        msg.includes("AboveTrafficLimit")
      ) {
        stats.bailedEarly = true;
        console.warn(
          "[preapproval-setup.backfill] BAILED — validator traffic credit exhausted. Skipping remainder of batch."
        );
        break;
      }
    }
  }

  console.log(
    `[preapproval-setup.backfill] done setup=${stats.setup} failed=${stats.failed} of ${candidates.length}${stats.bailedEarly ? " (bailed early on traffic exhaustion)" : ""}`
  );
  return stats;
}

/* ────────── Direct Daml exercise of AmuletRules_CreateTransferPreapproval ────────── *
 *                                                                                       *
 *  Why this isn't a REST call                                                            *
 *  --------------------------                                                            *
 *  Splice's validator-internal.yaml exposes only GET/DELETE/LIST for                     *
 *  /api/validator/v0/admin/transfer-preapprovals (per OpenAPI grep                       *
 *  2026-06-19). The only CREATE endpoint is                                              *
 *  POST /api/validator/v0/wallet/transfer-preapproval which operates                     *
 *  on the AUTHENTICATED user — and only "administrator" is in Splice's                  *
 *  validator-wallet-users list. There's no admin-side endpoint to                        *
 *  create preapprovals for arbitrary parties.                                            *
 *                                                                                        *
 *  The Daml choice IS available — AmuletRules_CreateTransferPreapproval                  *
 *  on AmuletRules (Splice/AmuletRules.daml:215). Controllers are                          *
 *  [provider, receiver]. Slay's backend has actAs on the operator                        *
 *  party (it IS the operator) AND on every onboarded user via                            *
 *  grantUserActAs (task #34). So we exercise the choice directly,                        *
 *  same way transferAmulet exercises AmuletRules_Transfer.                               *
 *                                                                                        *
 *  Fee model                                                                              *
 *  ---------                                                                              *
 *  The provider (validator) pays the preapproval fee — a small amount                    *
 *  in CC that scales with the validity window. For 90-day windows on                     *
 *  mainnet this is ~0.5 CC ($0.12) per user. The fee is consumed from                    *
 *  an operator-owned Amulet which we pass as the `inputs` field.                          *
 *  findOperatorAmulet picks the smallest amulet ≥ the expected fee.                      *
 * ────────────────────────────────────────────────────────────────────────────────── */

const VALIDITY_DAYS = 90;
/** Minimum amulet size to pick for the fee input — covers worst-case
 *  90-day fee with margin so the choice doesn't reject for low inputs. */
const FEE_BUDGET_CC = 2;

type CreateTransferPreapprovalArg = {
  context: {
    amuletRules: string;
    context: {
      openMiningRound: string;
      issuingMiningRounds: Array<unknown>;
      validatorRights: Array<unknown>;
      featuredAppRight: null;
    };
  };
  inputs: Array<{ tag: "InputAmulet"; value: string }>;
  receiver: string;
  provider: string;
  /** Daml `Time` — ISO-8601 microsecond-precision string. */
  expiresAt: string;
  /** Optional Party — pass live DSO so a swapped-out malicious
   *  AmuletRules can't trick us into routing through someone else's
   *  governance. */
  expectedDso: string;
};

type CreateTransferPreapprovalResult = {
  transferPreapprovalCid?: string;
  transfer_preapproval_cid?: string;
  // Plus transferResult, amuletPaid, meta — not needed here
};

async function exerciseCreateTransferPreapproval(
  env: Env,
  receiverParty: string
): Promise<{ preapprovalCid: string; expiresAt: Date }> {
  const operator = operatorParty(env);
  if (!operator) {
    throw new SpliceError(
      500,
      "SPLICE_VALIDATOR_PARTY_ID not set — required as the preapproval provider."
    );
  }

  // 1. Fetch AmuletRules + OpenMiningRound disclosed contracts. Same
  //    helpers transferAmulet uses; warm-cached by the worker between
  //    calls so the backfill loop doesn't re-fetch per user.
  const amuletRulesInfo = await getAmuletRulesDisclosed(env);
  const rounds = await getOpenAndIssuingRoundsDisclosed(env);

  // 2. Pick an operator-owned Amulet large enough to pay the fee.
  //    The fee is < 1 CC for a 90-day window in steady state, but pad
  //    so we don't fail at the chain-level fee check.
  const inputAmulet = await findOperatorAmulet(env, FEE_BUDGET_CC);
  if (!inputAmulet) {
    throw new SpliceError(
      409,
      `Operator party has no Amulet ≥ ${FEE_BUDGET_CC} CC available as ` +
        `fee input for preapproval setup. Top up the operator wallet or ` +
        `wait for a merge cycle.`
    );
  }

  // 3. Compute expiry — 90 days from now. Daml Time is ISO-8601 with
  //    microsecond precision (ends in "Z").
  const expiresAt = new Date(
    Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000
  );

  // 4. Build the choice argument matching the Daml signature.
  // PaymentTransferContext wraps amuletRules (the rules cid) around an
  // inner TransferContext (rounds + rights + featured-app). Same wrap
  // shape transferViaPreapproval uses for TransferPreapproval_Send.
  // Earlier omission caused: Missing non-optional fields: Set(amuletRules)
  const arg: CreateTransferPreapprovalArg = {
    context: {
      amuletRules: amuletRulesInfo.disclosed.contractId,
      context: {
        openMiningRound: rounds.openMiningRound.contractId,
        // Same rationale as transferAmulet — issuing rounds are only
        // consumed for reward redemption, not simple preapproval setup.
        // Including stale rounds breaks LOCAL_VERDICT_INACTIVE_CONTRACTS.
        issuingMiningRounds: [],
        validatorRights: [],
        featuredAppRight: null,
      },
    },
    inputs: [{ tag: "InputAmulet", value: inputAmulet.contractId }],
    receiver: receiverParty,
    provider: operator,
    expiresAt: expiresAt.toISOString(),
    expectedDso: amuletRulesInfo.dsoParty,
  };

  // 5. actAs = [operator, receiverParty]. Both are controllers per the
  //    Daml choice signature. We have actAs on operator (it's us) and
  //    on every onboarded user via grantUserActAs (task #34).
  const actAs = Array.from(new Set([operator, receiverParty]));

  // Only AmuletRules + OpenMiningRound need explicit disclosure — the
  // operator's input amulet is already in the participant's visible set
  // (operator is signatory). Same as transferAmulet's disclosed list.
  const disclosed: DisclosedContract[] = [
    amuletRulesInfo.disclosed,
    rounds.openMiningRound,
  ];

  // Use the CURRENT AmuletRules package (from scan's disclosed contract)
  // instead of a pinned SPLICE_AMULET_PACKAGE_ID. The pinned id goes stale on
  // every Daml model upgrade: the 2026-07-08 mainnet upgrade added an optional
  // AmuletRules field (index 9), so exercising against the old package fails
  // with INTERPRETATION_UPGRADE_ERROR_TRANSLATION_FAILED ("may not be dropped
  // during downgrade"). Reading the package from the live disclosed contract
  // makes this self-heal across future upgrades.
  const [arPkg, arModule, arEntity] =
    amuletRulesInfo.disclosed.templateId.split(":");
  const currentAmuletRulesTemplate: TemplateId = {
    packageId: arPkg,
    moduleName: arModule,
    entityName: arEntity,
  };

  // 6. Exercise.
  let result: Awaited<
    ReturnType<typeof exercise<CreateTransferPreapprovalArg, CreateTransferPreapprovalResult>>
  >;
  try {
    result = await exercise<
      CreateTransferPreapprovalArg,
      CreateTransferPreapprovalResult
    >(
      env,
      actAs,
      currentAmuletRulesTemplate,
      amuletRulesInfo.disclosed.contractId,
      "AmuletRules_CreateTransferPreapproval",
      arg,
      { disclosedContracts: disclosed }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // CONTRACT_NOT_FOUND on a referenced cid means our cached operator
    // Amulet (most common) or AmuletRules was archived between when we
    // read it and when we submitted. Self-heal: invalidate both caches
    // so the next call (this tick's retry, or next cron) re-fetches.
    const isCidStale =
      msg.includes("CONTRACT_NOT_FOUND") ||
      msg.includes("INACTIVE_CONTRACTS") ||
      msg.includes("LOCAL_VERDICT_INACTIVE");
    if (isCidStale) {
      try {
        await invalidateCachedOperatorAmulet(env);
      } catch {
        /* swallow */
      }
      const { invalidateAmuletRulesCache } = await import("./amulet");
      try {
        invalidateAmuletRulesCache();
      } catch {
        /* swallow */
      }
      console.warn(
        `[preapproval-setup] cid-stale recovery — operator amulet + amulet-rules caches invalidated. Next call will re-fetch.`
      );
      throw new SpliceError(
        409,
        `Stale cid during preapproval setup — caches invalidated, next call will recover. Underlying: ${msg.slice(0, 300)}`
      );
    }

    // DSO-mismatch retry path — same pattern as transferAmulet.
    if (msg.includes("DSO") || msg.includes("dso")) {
      throw new SpliceError(
        409,
        `DSO mismatch during preapproval setup — refetch AmuletRules and retry. Underlying: ${msg.slice(0, 200)}`
      );
    }
    if (err instanceof LedgerCallError) {
      throw new SpliceError(err.status, err.message);
    }
    throw err;
  }

  /* Preapproval creation burns CC — amuletPaid plus outputFee, which the
   * Splice docs note is NOT included in amuletPaid. At roughly half a CC per
   * onboarded user this is a material share of lifetime burn, and it was the
   * one supported formula with no call site. Best-effort by construction:
   * recordNetworkFee never throws, so a capture failure cannot fail an
   * onboarding. */
  await recordNetworkFee(env, {
    choice: "AmuletRules_CreateTransferPreapproval",
    exerciseResult: result.exerciseResult,
    updateId: result.updateId,
    source: "live",
  });

  // Extract the new TransferPreapproval cid. Try the choice's structured
  // return value first (exerciseResult.transferPreapprovalCid), then fall
  // back to scanning created events for a :Splice.AmuletRules:TransferPreapproval
  // template — same pattern as transferAmulet uses to find the
  // sender-change Amulet.
  let cid: string | null =
    result.exerciseResult?.transferPreapprovalCid ??
    result.exerciseResult?.transfer_preapproval_cid ??
    null;
  if (!cid) {
    for (const ev of result.events) {
      if (
        ev.kind === "created" &&
        ev.templateId.includes(":TransferPreapproval")
      ) {
        cid = ev.contractId;
        break;
      }
    }
  }
  if (!cid) {
    throw new SpliceError(
      502,
      `AmuletRules_CreateTransferPreapproval succeeded but no TransferPreapproval cid in result. exerciseResult=${JSON.stringify(result.exerciseResult).slice(0, 150)} events=${JSON.stringify(result.events).slice(0, 200)}`
    );
  }

  // Roll the operator amulet cache forward: the choice consumed the
  // seeded input and produced a new senderChange amulet owned by operator.
  // If parsing fails we INVALIDATE the cache so next call auto-seeds
  // from scan (don't leave a known-archived cid in place — guaranteed
  // CONTRACT_NOT_FOUND next call).
  try {
    let newCid: string | null = null;
    let newAmount = 0;
    const amuletEvents: string[] = [];
    for (const ev of result.events) {
      if (ev.kind !== "created") continue;
      const tplId = ev.templateId ?? "";
      amuletEvents.push(`${tplId.slice(-40)}`);
      // Tolerant template-id match — Daml 3.x can ship templateIds with or
      // without the leading package hash, and via package-name resolution.
      const isAmulet = tplId.includes("Splice.Amulet:Amulet");
      if (!isAmulet) continue;
      const p = ev.payload as {
        owner?: string;
        amount?: { initialAmount?: string };
      };
      if (p?.owner !== operator) continue;
      const amt = Number(p.amount?.initialAmount ?? "0");
      if (!Number.isFinite(amt) || amt <= 0) continue;
      if (amt > newAmount) {
        newAmount = amt;
        newCid = ev.contractId;
      }
    }
    if (newCid) {
      await setCachedOperatorAmulet(env, newCid, newAmount);
    } else {
      // Couldn't find senderChange — log what we DID see for diagnosis,
      // then invalidate cache. Next call auto-seeds from scan.
      console.warn(
        `[preapproval-setup] no operator senderChange found in ${result.events.length} events. Created-templateIds: ${amuletEvents.slice(0, 8).join(" | ")} — cache invalidated, next call auto-seeds`
      );
      await invalidateCachedOperatorAmulet(env);
    }
  } catch (err) {
    console.warn(
      `[preapproval-setup] cache refresh threw: ${err instanceof Error ? err.message : String(err)} — invalidating cache, next call auto-seeds`
    );
    await invalidateCachedOperatorAmulet(env).catch(() => {});
  }

  return { preapprovalCid: cid, expiresAt };
}

/* ────────── v2 (cross-participant) preapproval publish ────────── *
 *  Publishes a TransferPreapproval for a party hosted on validator-2 so v1
 *  senders can deposit CC to it (bet stakes → prediction party). Unlike the
 *  v1 path above: provider + receiver are explicit v2 parties, the fee input
 *  amulet is supplied by the caller (queried from v2), and the exercise
 *  targets the v2 ledger as participant_admin. AmuletRules + mining round are
 *  DSO-global, so the v1 scan-proxy copies are valid on v2 (same domain).   */
export async function createTransferPreapprovalV2(
  env: Env,
  args: { provider: string; receiver: string; inputAmuletCid: string }
): Promise<{ preapprovalCid: string; expiresAt: Date }> {
  const { provider, receiver, inputAmuletCid } = args;
  const amuletRulesInfo = await getAmuletRulesDisclosed(env);
  const rounds = await getOpenAndIssuingRoundsDisclosed(env);
  const expiresAt = new Date(Date.now() + EXPECTED_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const arg: CreateTransferPreapprovalArg = {
    context: {
      amuletRules: amuletRulesInfo.disclosed.contractId,
      context: {
        openMiningRound: rounds.openMiningRound.contractId,
        issuingMiningRounds: [],
        validatorRights: [],
        featuredAppRight: null,
      },
    },
    inputs: [{ tag: "InputAmulet", value: inputAmuletCid }],
    receiver,
    provider,
    expiresAt: expiresAt.toISOString(),
    expectedDso: amuletRulesInfo.dsoParty,
  };

  const [arPkg, arModule, arEntity] = amuletRulesInfo.disclosed.templateId.split(":");
  const amuletRulesTemplate: TemplateId = { packageId: arPkg, moduleName: arModule, entityName: arEntity };
  const disclosed: DisclosedContract[] = [amuletRulesInfo.disclosed, rounds.openMiningRound];

  const result = await exercise<CreateTransferPreapprovalArg, CreateTransferPreapprovalResult>(
    env,
    [provider, receiver],
    amuletRulesTemplate,
    amuletRulesInfo.disclosed.contractId,
    "AmuletRules_CreateTransferPreapproval",
    arg,
    { disclosedContracts: disclosed, target: "v2", subOverride: "participant_admin" }
  );

  /* Preapproval creation burns CC — amuletPaid plus outputFee, which the
   * Splice docs note is NOT included in amuletPaid. At roughly half a CC per
   * onboarded user this is a material share of lifetime burn, and it was the
   * one supported formula with no call site. Best-effort by construction:
   * recordNetworkFee never throws, so a capture failure cannot fail an
   * onboarding. */
  await recordNetworkFee(env, {
    choice: "AmuletRules_CreateTransferPreapproval",
    exerciseResult: result.exerciseResult,
    updateId: result.updateId,
    source: "live",
  });

  let cid: string | null =
    result.exerciseResult?.transferPreapprovalCid ??
    result.exerciseResult?.transfer_preapproval_cid ??
    null;
  if (!cid) {
    for (const ev of result.events) {
      if (ev.kind === "created" && ev.templateId.includes(":TransferPreapproval")) {
        cid = ev.contractId;
        break;
      }
    }
  }
  if (!cid) {
    throw new SpliceError(
      502,
      `v2 AmuletRules_CreateTransferPreapproval succeeded but no TransferPreapproval cid. events=${JSON.stringify(result.events).slice(0, 200)}`
    );
  }
  return { preapprovalCid: cid, expiresAt };
}
