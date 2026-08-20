/* ------------------------------------------------------------------ *
 *  splice/amulet.ts — direct AmuletRules_Transfer from operator party. *
 *                                                                      *
 *  Why this exists                                                     *
 *  ---------------                                                     *
 *  Splice's /wallet/transfer-offers endpoint requires the recipient to *
 *  be in validatorWalletUsers HOCON config — static, can't scale per   *
 *  user. The /wallet/transfer-preapproval/send endpoint requires a     *
 *  TransferPreapproval contract that only a registered wallet user     *
 *  can create. Both block per-user custodial CC movements.             *
 *                                                                      *
 *  This module bypasses both by submitting AmuletRules_Transfer        *
 *  directly via the v2 JSON Ledger API. The operator party is the     *
 *  sender + provider; receiver is any party id. Since AmuletRules_     *
 *  Transfer's controllers are determined by the Transfer payload      *
 *  (typically just the sender for simple operator → user transfers),  *
 *  actAs = [operator] is sufficient — no recipient consent needed.    *
 *                                                                      *
 *  Wire shape                                                          *
 *  ---------                                                           *
 *  Three pieces of data have to be fetched fresh per call:             *
 *    1. AmuletRules contract id    — singleton, DSO-signed, via         *
 *       scan-proxy because operator isn't an observer                  *
 *    2. OpenMiningRound contract id — current round, DSO-signed, via   *
 *       scan-proxy                                                      *
 *    3. A specific operator-owned Amulet contract to consume — picked  *
 *       from the operator's amulet inventory by minimum balance        *
 *                                                                      *
 *  Then we ExerciseCommand(AmuletRules, AmuletRules_Transfer, {        *
 *    transfer: { sender, provider, inputs, outputs, beneficiaries },   *
 *    context: { openMiningRound, issuingMiningRounds, validatorRights, *
 *               featuredAppRight },                                    *
 *    expectedDso: None                                                 *
 *  }).                                                                  *
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import {
  exercise,
  operatorParty,
  query,
  LedgerCallError,
  type TemplateId,
  type DisclosedContract,
} from "../canton/ledger";
import { spliceGet } from "./client";
import { walletFeatured, type FeaturedBundle } from "./featured";
import { recordNetworkFee, type BurntFee } from "../fees/network-fees";

/* ------------------------------------------------------------------ */
/*  Template id helpers (Splice's Amulet DAR)                          */
/* ------------------------------------------------------------------ */

function spliceAmuletTemplate(
  env: Env,
  moduleName: string,
  entityName: string
): TemplateId {
  const pkg = env.SPLICE_AMULET_PACKAGE_ID;
  if (!pkg) {
    throw new LedgerCallError(
      500,
      "SPLICE_AMULET_PACKAGE_ID is not set — can't reference Splice templates."
    );
  }
  return { packageId: pkg, moduleName, entityName };
}

export const AmuletRulesTemplate = (env: Env) =>
  spliceAmuletTemplate(env, "Splice.AmuletRules", "AmuletRules");

export const AmuletTemplate = (env: Env) =>
  spliceAmuletTemplate(env, "Splice.Amulet", "Amulet");

/* ------------------------------------------------------------------ */
/*  Scan-proxy lookups                                                  */
/* ------------------------------------------------------------------ */

type ScanContract<TPayload> = {
  template_id: string;
  contract_id: string;
  payload: TPayload;
  created_event_blob: string;
};

type ScanContractWrap<TPayload> = {
  contract: ScanContract<TPayload>;
  domain_id: string;
};

type AmuletRulesResp = {
  amulet_rules: ScanContractWrap<{ dso: string }>;
};

type OpenAndIssuingRoundsResp = {
  open_mining_rounds: Array<
    ScanContractWrap<{ round: { number: string }; opensAt?: string }>
  >;
  issuing_mining_rounds: Array<
    ScanContractWrap<{ round: { number: string } }>
  >;
};

/** Convert a scan-proxy contract wrapper into the v2-API disclosed form. */
function toDisclosed<T>(w: ScanContractWrap<T>): DisclosedContract {
  return {
    templateId: w.contract.template_id,
    contractId: w.contract.contract_id,
    createdEventBlob: w.contract.created_event_blob,
    synchronizerId: w.domain_id,
  };
}

/**
 * Fetch the current AmuletRules contract from scan-proxy along with the
 * DSO party id it's signed by. The DSO party rotates via Foundation
 * governance, so we MUST read it live per-call — caching or hardcoding
 * in env breaks the moment DSO rotates.
 *
 * NOTE: GSF scan replicas have been observed serving different
 * AmuletRules to clients in different geographies during contentious
 * windows (e.g. mid-rotation). When transfers fail with "Contract group
 * identifier mismatch" or "DSO party expected by caller ... does not
 * match", the runbook is:
 *   1. `docker restart splice-validator-validator-1` — flushes the
 *      validator-app's scan-client cache.
 *   2. Wait 5-10 minutes for GSF replicas to converge.
 *   3. Retry.
 *   4. If still failing, ping Foundation TG with both AmuletRules cids.
 *
 * SPLICE_DEBUG=1 enables a one-line log of what scan-proxy returned, for
 * post-mortem of any future inconsistency window.
 */
/* ------------------------------------------------------------------ *
 *  AmuletRules cache                                                   *
 *                                                                      *
 *  Scan-proxy on MainNet has been observed serving INCONSISTENT        *
 *  AmuletRules contracts — different requests randomly returning a     *
 *  stale/wrong contract with a different DSO. The participant's        *
 *  canonical DSO is stable (verified in our participant logs), so we   *
 *  want to AVOID re-fetching from scan-proxy whenever possible.        *
 *                                                                      *
 *  Strategy: process-local cache with TTL. After any successful        *
 *  transferAmulet, we know the AmuletRules contract we used was the    *
 *  correct one (the participant accepted it). Stash it for 10 min.    *
 *  Next caller skips scan-proxy entirely and uses the cached blob.    *
 *                                                                      *
 *  Cache is invalidated on:                                            *
 *    - TTL expiry (10 min — well under the typical round-rotation      *
 *      cadence that would archive AmuletRules)                         *
 *    - Explicit invalidateAmuletRulesCache() call from the retry       *
 *      loop when it sees an INACTIVE_CONTRACTS error referencing       *
 *      the cached cid                                                  *
 *                                                                      *
 *  Worker isolates live for many requests so cache hits are common;    *
 *  on cold start we pay one scan-proxy round-trip.                     *
 * ------------------------------------------------------------------ */

type AmuletRulesCacheEntry = {
  disclosed: DisclosedContract;
  dsoParty: string;
  cachedAt: number; // ms epoch
};

let amuletRulesCache: AmuletRulesCacheEntry | null = null;
const AMULET_RULES_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Drop the cached AmuletRules — call when we detect the cached cid
 *  has been archived (INACTIVE_CONTRACTS error referencing it). */
export function invalidateAmuletRulesCache(): void {
  amuletRulesCache = null;
}

/** Update the cache with a known-good entry — called by transferAmulet
 *  after a successful submission, so future calls skip scan-proxy. */
export function rememberWorkingAmuletRules(
  disclosed: DisclosedContract,
  dsoParty: string
): void {
  amuletRulesCache = { disclosed, dsoParty, cachedAt: Date.now() };
}

/** Poll scan-proxy aggressively until we get an AmuletRules response
 *  matching `expectedDsoParty`. Use this from admin scripts to prime
 *  the cache before running a batch of transfers — works around the
 *  scan-proxy returning the wrong DSO contract for extended windows.
 *
 *  This is intentionally aggressive (50 polls × 200ms = 10s worst case)
 *  because admin scripts run from a local tsx process, not from a
 *  Cloudflare Worker, so the 50-subrequest cap doesn't apply.
 *
 *  Returns true if cache was primed, false if all polls returned the
 *  wrong DSO (in which case scan-proxy is stuck and Foundation
 *  intervention is needed). */
export async function primeAmuletRulesCache(
  env: Env,
  expectedDsoParty: string,
  maxPolls = 50
): Promise<boolean> {
  invalidateAmuletRulesCache();
  for (let i = 0; i < maxPolls; i++) {
    try {
      const r = await spliceGet<AmuletRulesResp>(
        env,
        "/api/validator/v0/scan-proxy/amulet-rules"
      );
      const dso = r.amulet_rules.contract.payload.dso;
      if (dso === expectedDsoParty) {
        rememberWorkingAmuletRules(toDisclosed(r.amulet_rules), dso);
        console.log(
          `[primeCache] hit on poll ${i + 1}/${maxPolls} — dso=${dso.slice(0, 36)}…`
        );
        return true;
      }
      if (i === 0 || i === maxPolls - 1 || i % 10 === 0) {
        console.log(
          `[primeCache] poll ${i + 1}/${maxPolls} got dso=${dso.slice(0, 36)}… (want ${expectedDsoParty.slice(0, 36)}…)`
        );
      }
    } catch (e) {
      console.warn(`[primeCache] poll ${i + 1} threw: ${(e as Error).message.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function getAmuletRulesDisclosed(env: Env): Promise<{
  disclosed: DisclosedContract;
  dsoParty: string;
}> {
  // Cache hit — skip the buggy scan-proxy entirely.
  if (
    amuletRulesCache &&
    Date.now() - amuletRulesCache.cachedAt < AMULET_RULES_CACHE_TTL_MS
  ) {
    if (env.SPLICE_DEBUG === "1") {
      console.log(
        `[scan-proxy] cache HIT dso=${amuletRulesCache.dsoParty.slice(0, 28)}…`
      );
    }
    return {
      disclosed: amuletRulesCache.disclosed,
      dsoParty: amuletRulesCache.dsoParty,
    };
  }

  const r = await spliceGet<AmuletRulesResp>(
    env,
    "/api/validator/v0/scan-proxy/amulet-rules"
  );
  if (env.SPLICE_DEBUG === "1") {
    console.log(
      `[scan-proxy] amulet-rules MISS cid=${r.amulet_rules.contract.contract_id.slice(0, 24)}… ` +
        `dso=${r.amulet_rules.contract.payload.dso}`
    );
  }
  return {
    disclosed: toDisclosed(r.amulet_rules),
    dsoParty: r.amulet_rules.contract.payload.dso,
  };
}

/* ------------------------------------------------------------------ *
 *  TransferPreapproval lookup                                          *
 *                                                                      *
 *  External sends (to parties NOT hosted on our validator) can't use   *
 *  the simple AmuletRules_Transfer path because that requires actAs   *
 *  on the recipient, and we don't have it for external parties.       *
 *                                                                      *
 *  Splice's answer is the TransferPreapproval contract — receivers     *
 *  publish a pre-authorisation that lets external senders deposit CC  *
 *  without needing the receiver in actAs. Splice wallets create it    *
 *  by default for every user; non-wallet integrations don't.          *
 *                                                                      *
 *  This module only LOOKS UP the preapproval today (Stage 1). Actually *
 *  using it requires exercising `TransferPreapproval_Send` instead of  *
 *  AmuletRules_Transfer — different choice, different actAs, slightly  *
 *  different disclosures. Stage 2.                                     *
 *                                                                      *
 *  For now: callers use this to pre-flight external sends. If no       *
 *  preapproval exists for the receiver, the chain leg will fail with   *
 *  NO_SYNCHRONIZER — so we can short-circuit with a clear message      *
 *  before burning a chain round-trip.                                  *
 * ------------------------------------------------------------------ */

type TransferPreapprovalPayload = {
  /** Receiver party (who's pre-approving). */
  receiver: string;
  /** DSO party id — same as the AmuletRules DSO. */
  dso: string;
  /** Provider party — the validator hosting the receiver (their participant). */
  provider: string;
  /** ISO timestamp — preapprovals can have a validity window. */
  validFrom?: string;
  expiresAt?: string;
};

type TransferPreapprovalResp = {
  // Scan-proxy returns the wrap shape when the contract exists, OR a 404
  // when it doesn't. Some Splice versions wrap under different field
  // names (`transfer_preapproval` vs `preapproval`) — accept either.
  transfer_preapproval?: ScanContractWrap<TransferPreapprovalPayload>;
  preapproval?: ScanContractWrap<TransferPreapprovalPayload>;
};

export type TransferPreapprovalInfo = {
  disclosed: DisclosedContract;
  payload: TransferPreapprovalPayload;
};

/**
 * Look up a TransferPreapproval contract for `receiverParty` via scan-proxy.
 *
 * Returns `null` (NOT throws) when:
 *   - 404 — no preapproval published for this party
 *   - 410 / 412 — preapproval exists but is expired / revoked
 *   - any other "this party can't receive" condition
 *
 * Throws only on transport failures (scan-proxy unreachable, malformed
 * response). Callers should treat a thrown error as "scan-proxy down,
 * retry later" rather than "recipient unreachable".
 */
export async function fetchTransferPreapproval(
  env: Env,
  receiverParty: string
): Promise<TransferPreapprovalInfo | null> {
  const path =
    "/api/validator/v0/scan-proxy/transfer-preapprovals/by-party/" +
    encodeURIComponent(receiverParty);
  try {
    const r = await spliceGet<TransferPreapprovalResp>(env, path);
    const wrap = r.transfer_preapproval ?? r.preapproval;
    if (!wrap) return null;

    // Validity check — drop expired preapprovals defensively. The chain
    // would reject them anyway, but failing fast saves a round trip.
    const payload = wrap.contract.payload;
    if (payload.expiresAt) {
      const expiresMs = Date.parse(payload.expiresAt);
      if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        if (env.SPLICE_DEBUG === "1") {
          console.log(
            `[preapproval] receiver=${receiverParty.slice(0, 24)}… EXPIRED at ${payload.expiresAt}`
          );
        }
        return null;
      }
    }

    if (env.SPLICE_DEBUG === "1") {
      console.log(
        `[preapproval] receiver=${receiverParty.slice(0, 24)}… HIT ` +
          `provider=${payload.provider.slice(0, 20)}… ` +
          `dso=${payload.dso.slice(0, 20)}…`
      );
    }
    return { disclosed: toDisclosed(wrap), payload };
  } catch (err) {
    // 404 is the success-path "no preapproval" signal. Anything else is a
    // real transport failure we should surface upstream — the caller can
    // decide whether to fall back to "try again" vs "not reachable".
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
      if (env.SPLICE_DEBUG === "1") {
        console.log(
          `[preapproval] receiver=${receiverParty.slice(0, 24)}… MISS (404)`
        );
      }
      return null;
    }
    throw err;
  }
}

export async function getOpenAndIssuingRoundsDisclosed(env: Env): Promise<{
  openMiningRound: DisclosedContract;
  /** All currently-open rounds, NEWEST round number first. Callers can
   *  rotate to the next one when the chain rejects the chosen round as
   *  inactive (scan replicas lag and keep listing a just-archived round). */
  openMiningRoundCandidates: DisclosedContract[];
  issuingMiningRounds: Array<{
    round: string;
    disclosed: DisclosedContract;
  }>;
}> {
  const r = await spliceGet<OpenAndIssuingRoundsResp>(
    env,
    "/api/validator/v0/scan-proxy/open-and-issuing-mining-rounds"
  );
  if (!r.open_mining_rounds[0]) {
    throw new LedgerCallError(
      503,
      "No open mining rounds available — synchronizer might be paused."
    );
  }
  // Splice keeps several rounds open at once. Scan replicas sometimes keep
  // listing a just-archived round (replica lag) — and it tends to be the
  // OLDEST one. Sort newest-first by round number so we default to the
  // round least likely to be archived, and hand back the full list so the
  // transfer retry loop can rotate to the next candidate on an
  // INACTIVE_CONTRACTS reject instead of re-pulling the same stale cid.
  const sorted = [...r.open_mining_rounds].sort(
    (a, b) =>
      Number(b.contract.payload.round.number) -
      Number(a.contract.payload.round.number)
  );
  // Drop rounds that haven't OPENED yet — Splice keeps the next round in the
  // list before its opensAt, and using it fails with `deadline-not-exceeded`
  // ("Ledger time is strictly before openRound.opensAt"). Keep only already-
  // open rounds (newest-first); fall back to the full list if opensAt is
  // absent so we never end up with zero candidates.
  const nowMs = Date.now();
  const openedSorted = sorted.filter((w) => {
    const o = w.contract.payload.opensAt;
    return !o || Date.parse(o) <= nowMs;
  });
  const candidates = (openedSorted.length > 0 ? openedSorted : sorted).map(
    toDisclosed
  );
  return {
    openMiningRound: candidates[0],
    openMiningRoundCandidates: candidates,
    issuingMiningRounds: r.issuing_mining_rounds.map((m) => ({
      round: m.contract.payload.round.number,
      disclosed: toDisclosed(m),
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Operator amulet inventory                                          */
/*                                                                      */
/*  We pick a single amulet with balance >= amountCc. Splice's UTXO    */
/*  model allows multi-input transfers (up to maxNumInputs=100 in the  */
/*  current TransferConfig), but for V1 the operator's 1000 CC sits in *
/*  one amulet so single-input is enough. We expand to multi-input if  *
/*  the balance gets fragmented across many small amulets later.       *
/* ------------------------------------------------------------------ */

type AmuletPayload = {
  dso: string;
  owner: string;
  amount: {
    initialAmount: string;
    createdAt: { number: string };
    ratePerRound: { rate: string };
  };
};

export async function findOperatorAmulet(
  env: Env,
  minAmountCc: number
): Promise<{ contractId: string; amount: number; dso?: string } | null> {
  // ── Cache fast-path ──
  // Operator party owns 600+ contracts (1 WalletAppInstall + 1
  // ValidatorRight per Slay user, plus Slay Bets/Markets/Trade
  // positions). A wildcard /v2/state/active-contracts query 413s
  // with JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED. Same pattern
  // as CBTC holdings (cbtc_holding_cache) — we cache the operator's
  // current Amulet cid in cc_amulet_cache and update on every
  // successful transferAmulet.
  const operator = operatorParty(env);
  try {
    const { createDb, schema } = await import("../db");
    const { eq } = await import("drizzle-orm");
    const db = createDb(env.DATABASE_URL);
    const [row] = await db
      .select()
      .from(schema.ccAmuletCache)
      .where(eq(schema.ccAmuletCache.partyId, operator))
      .limit(1);
    if (row) {
      const cachedAmount = Number(row.amountCc);
      if (Number.isFinite(cachedAmount) && cachedAmount >= minAmountCc) {
        if (env.SPLICE_DEBUG === "1") {
          console.log(
            `[amulet] findOperatorAmulet cache HIT cid=${row.amuletCid.slice(0, 24)}… amount=${cachedAmount}`
          );
        }
        return {
          contractId: row.amuletCid,
          amount: cachedAmount,
        };
      }
      if (env.SPLICE_DEBUG === "1") {
        console.log(
          `[amulet] findOperatorAmulet cache HIT but amount=${cachedAmount} < required ${minAmountCc}; falling through`
        );
      }
    }
  } catch (err) {
    console.warn(
      `[amulet] findOperatorAmulet cache read failed (continuing to participant): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Cache empty/stale. PRIMARY discovery: walk the bounded /v2/updates/flats
  // stream for the operator's CURRENT live Amulet. This is a RANGE query, not
  // the full active-contracts snapshot, so it is NOT subject to the 200-element
  // cap (the 413 you keep seeing), and it's reachable from the Worker (unlike
  // public scan, which 403s our egress and only returns stale hourly snapshots
  // anyway). This is the fix for "operator amulet lookup keeps 413/CONTRACT_
  // NOT_FOUND looping".
  try {
    const live = await discoverOperatorAmuletViaLedger(env, minAmountCc);
    if (live && live.amount >= minAmountCc) {
      console.log(
        `[amulet] discovered operator amulet via ledger flats cid=${live.contractId.slice(0, 24)}… amount=${live.amount}`
      );
      return live;
    }
  } catch (err) {
    console.warn(
      `[amulet] ledger-flats discovery failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Fallbacks (best-effort): public scan (may 403 from the Worker + stale),
  // then the full ACS query (may 413). Kept so non-Worker contexts still work.
  try {
    const seeded = await seedOperatorAmuletFromScan(env);
    if (seeded && seeded.amount >= minAmountCc) {
      console.log(
        `[amulet] auto-seeded operator amulet from scan cid=${seeded.contractId.slice(0, 24)}… amount=${seeded.amount}`
      );
      return seeded;
    }
  } catch (err) {
    console.warn(
      `[amulet] auto-seed from scan failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return findAmulet(env, operator, minAmountCc);
}

/**
 * Discover the operator's CURRENT largest live Amulet by walking the bounded
 * /v2/updates/flats range stream (created minus archived), newest offsets
 * first. Avoids both the active-contracts 200-cap (this is a range query) and
 * public scan (403 from Worker + stale snapshots). Caches and returns the
 * largest live amulet ≥ minAmountCc, else the largest live one it found.
 */
async function discoverOperatorAmuletViaLedger(
  env: Env,
  minAmountCc: number,
  partyOverride?: string
): Promise<{ contractId: string; amount: number } | null> {
  const ledgerHost = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!ledgerHost || !token) return null;
  const operator = partyOverride ?? operatorParty(env);
  // cc_amulet_cache updates are keyed to the OPERATOR row; caching another
  // party's amulet there would hand the operator a cid it cannot spend.
  const cacheable = operator === operatorParty(env);

  const endRes = await fetch(`${ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!endRes.ok) return null;
  const end = Number(((await endRes.json()) as { offset?: string }).offset);
  if (!Number.isFinite(end)) return null;

  const WINDOW = 1000;
  const MAX_WINDOWS = 40;
  const created = new Map<string, number>(); // live operator Amulet cid -> amount
  const archived = new Set<string>();

  const bestLive = (): { contractId: string; amount: number } | null => {
    let cid: string | null = null;
    let amt = 0;
    for (const [c, a] of created) {
      if (archived.has(c)) continue;
      if (a > amt) {
        amt = a;
        cid = c;
      }
    }
    return cid ? { contractId: cid, amount: amt } : null;
  };

  for (let i = 0; i < MAX_WINDOWS; i++) {
    const winEnd = end - i * WINDOW;
    const winBegin = Math.max(0, winEnd - WINDOW);
    if (winEnd <= 0) break;

    const r = await fetch(`${ledgerHost}/v2/updates/flats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      body: JSON.stringify({
        beginExclusive: String(winBegin),
        endInclusive: String(winEnd),
        filter: {
          filtersByParty: {
            [operator]: {
              cumulative: [
                { WildcardFilter: { value: { includeCreatedEventBlob: false } } },
              ],
            },
          },
        },
        verbose: true,
      }),
    });
    if (!r.ok) continue; // bounded window shouldn't 413; skip transient errors

    const body = (await r.json()) as Array<{
      update?: { Transaction?: { value?: { events?: any[] } } };
    }>;
    for (const rec of body) {
      const evs = rec.update?.Transaction?.value?.events ?? [];
      for (const ev of evs) {
        const c = ev.CreatedEvent?.value ?? ev.CreatedEvent;
        const a = ev.ArchivedEvent?.value ?? ev.ArchivedEvent;
        if (c) {
          const tmpl: string = c.templateId ?? "";
          if (
            tmpl.endsWith(":Splice.Amulet:Amulet") &&
            c.createArgument?.owner === operator
          ) {
            const amt = Number(c.createArgument?.amount?.initialAmount ?? "0");
            if (Number.isFinite(amt) && amt > 0) created.set(c.contractId, amt);
          }
        }
        if (a?.contractId) archived.add(a.contractId);
      }
    }

    // Early exit once we have a live amulet that covers the fee budget.
    const b = bestLive();
    if (b && b.amount >= minAmountCc) {
      if (cacheable) await setCachedOperatorAmulet(env, b.contractId, b.amount).catch(() => {});
      return b;
    }
  }

  const b = bestLive();
  if (b) {
    if (cacheable) await setCachedOperatorAmulet(env, b.contractId, b.amount).catch(() => {});
    return b;
  }
  return null;
}

/**
 * Amulet discovery for a NON-operator local party that owns too many
 * contracts for the ACS finder (the prediction party crossed the 200-cap
 * as PmBets accumulated and every payout 413'd). Same bounded flats walk,
 * no cache involvement.
 */
export async function findPartyAmuletViaWalk(
  env: Env,
  party: string,
  minAmountCc: number
): Promise<{ contractId: string; amount: number } | null> {
  return discoverOperatorAmuletViaLedger(env, minAmountCc, party);
}

/**
 * Covering SET of live amulets for a local party, via the same flats walk.
 * The prediction party's CC arrives as one ~stake-sized amulet per escrow,
 * so any payout larger than a single bet can never be funded single-input
 * ("has no Amulet with at least X CC" while the party plainly holds more).
 * Largest-first until the target is covered; capped well under the
 * TransferConfig maxNumInputs=100.
 */
export async function findPartyAmuletSetViaWalk(
  env: Env,
  party: string,
  minAmountCc: number
): Promise<{ contractIds: string[]; total: number } | null> {
  const ledgerHost = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!ledgerHost || !token) return null;

  const endRes = await fetch(`${ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!endRes.ok) return null;
  const end = Number(((await endRes.json()) as { offset?: string }).offset);
  if (!Number.isFinite(end)) return null;

  const WINDOW = 1000;
  const MAX_WINDOWS = 40;
  const MAX_INPUTS = 50;
  const created = new Map<string, number>();
  const archived = new Set<string>();

  const covering = (): { contractIds: string[]; total: number } | null => {
    const live = [...created.entries()]
      .filter(([c]) => !archived.has(c))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_INPUTS);
    let sum = 0;
    const out: string[] = [];
    for (const [c, a] of live) {
      out.push(c);
      sum += a;
      if (sum >= minAmountCc) return { contractIds: out, total: sum };
    }
    return null;
  };

  for (let i = 0; i < MAX_WINDOWS; i++) {
    const winEnd = end - i * WINDOW;
    const winBegin = Math.max(0, winEnd - WINDOW);
    if (winEnd <= 0) break;

    const r = await fetch(`${ledgerHost}/v2/updates/flats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      body: JSON.stringify({
        beginExclusive: String(winBegin),
        endInclusive: String(winEnd),
        filter: {
          filtersByParty: {
            [party]: {
              cumulative: [
                { WildcardFilter: { value: { includeCreatedEventBlob: false } } },
              ],
            },
          },
        },
        verbose: true,
      }),
    });
    if (!r.ok) continue;

    const body = (await r.json()) as Array<{
      update?: { Transaction?: { value?: { events?: any[] } } };
    }>;
    for (const rec of body) {
      const evs = rec.update?.Transaction?.value?.events ?? [];
      for (const ev of evs) {
        const c = ev.CreatedEvent?.value ?? ev.CreatedEvent;
        const a = ev.ArchivedEvent?.value ?? ev.ArchivedEvent;
        if (c) {
          const tmpl: string = c.templateId ?? "";
          if (tmpl.endsWith(":Splice.Amulet:Amulet") && c.createArgument?.owner === party) {
            const amt = Number(c.createArgument?.amount?.initialAmount ?? "0");
            if (Number.isFinite(amt) && amt > 0) created.set(c.contractId, amt);
          }
        }
        if (a?.contractId) archived.add(a.contractId);
      }
    }

    const cov = covering();
    if (cov) return cov;
  }
  return covering();
}

/**
 * Query public Splice scan for the operator's largest amulet at the most
 * recent hourly snapshot, write it to cc_amulet_cache, and return it.
 * Used as the auto-recovery path when the cache is empty (cold start or
 * just-invalidated). Doesn't burn validator traffic — scan is a
 * read-only HTTP endpoint outside the sequencer.
 */
async function seedOperatorAmuletFromScan(
  env: Env
): Promise<{ contractId: string; amount: number } | null> {
  const operator = operatorParty(env);
  const migrationId = env.SPLICE_MIGRATION_ID
    ? Number(env.SPLICE_MIGRATION_ID)
    : 4;
  const scanHost =
    env.SPLICE_SCAN_PUBLIC_URL ??
    "https://scan.sv-1.global.canton.network.sync.global";

  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const ts = `${oneHourAgo.toISOString().slice(0, 13)}:00:00Z`;

  const res = await fetch(`${scanHost}/api/scan/v0/holdings/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      migration_id: migrationId,
      record_time: ts,
      page_size: 50,
      owner_party_ids: [operator],
    }),
  });
  if (!res.ok) {
    throw new LedgerCallError(
      res.status,
      `scan holdings/state ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  const body = (await res.json()) as {
    created_events?: Array<{
      contract_id: string;
      template_id?: string;
      create_arguments?: { amount?: { initialAmount?: string } };
    }>;
  };
  const events = body.created_events ?? [];
  let bestCid: string | null = null;
  let bestAmount = 0;
  for (const ev of events) {
    if (!ev.template_id?.endsWith(":Splice.Amulet:Amulet")) continue;
    const amt = Number(ev.create_arguments?.amount?.initialAmount ?? "0");
    if (Number.isFinite(amt) && amt > bestAmount) {
      bestAmount = amt;
      bestCid = ev.contract_id;
    }
  }
  if (!bestCid || bestAmount <= 0) return null;
  await setCachedOperatorAmulet(env, bestCid, bestAmount);
  return { contractId: bestCid, amount: bestAmount };
}

/**
 * Public Splice scan → sum of all Amulet holdings owned by `party`.
 * Returns the on-chain CC balance as a decimal number (not micro-CC).
 * Zero validator-traffic cost (scan is a read-only public HTTP endpoint
 * outside the sequencer). 3s timeout so a slow scan can't hang wallet loads.
 * Returns null on any error — caller falls back to Postgres balance.
 */
export async function fetchOnChainCcBalance(
  env: Env,
  party: string
): Promise<number | null> {
  try {
    // Query the local participant's JSON Ledger API for all Splice.Amulet
    // contracts owned by this party. Zero scan involvement — the participant
    // hosts every user party and knows their Amulet state directly.
    // Faster (~50ms) and immune to Foundation-side CDN filters that 403 CF
    // Worker IPs against sv-1 public scan.
    //
    // 200-cap caveat: participant response caps at 200 elements. Practically
    // every user has 1-3 Amulets so we never hit it. If a user has drift
    // huge enough to fragment beyond 200 Amulets, they need a merge first
    // anyway — return whatever fits and log the truncation.
    const amulets = await query<AmuletPayload>(env, [party], AmuletTemplate(env));
    let total = 0;
    let matched = 0;
    for (const a of amulets) {
      if (a.payload.owner !== party) continue;
      const amount = Number(a.payload.amount.initialAmount);
      if (Number.isFinite(amount) && amount > 0) {
        total += amount;
        matched++;
      }
    }
    if (amulets.length >= 200) {
      console.warn(
        `[fetchOnChainCcBalance] TRUNCATED party=${party.slice(0, 20)}… hit 200-cap, total may be understated`
      );
    }
    console.log(
      `[fetchOnChainCcBalance] party=${party.slice(0, 20)}… amulets=${amulets.length} matched=${matched} total=${total}`
    );
    return total;
  } catch (err) {
    console.warn(
      `[fetchOnChainCcBalance] THREW party=${party.slice(0, 20)}… err=${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`
    );
    return null;
  }
}

/**
 * Update the operator amulet cache after a successful transfer. Called
 * by transferAmulet (and similar) to keep the cache in sync with the
 * sender-change Amulet that was just created on chain.
 */
export async function setCachedOperatorAmulet(
  env: Env,
  amuletCid: string,
  amountCc: number
): Promise<void> {
  try {
    const { createDb, schema } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = createDb(env.DATABASE_URL);
    const operator = operatorParty(env);
    await db
      .insert(schema.ccAmuletCache)
      .values({
        partyId: operator,
        amuletCid,
        amountCc: amountCc.toFixed(10),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.ccAmuletCache.partyId,
        set: {
          amuletCid,
          amountCc: amountCc.toFixed(10),
          updatedAt: new Date(),
        },
      });
    if (env.SPLICE_DEBUG === "1") {
      console.log(
        `[amulet] cache UPDATE operator cid=${amuletCid.slice(0, 24)}… amount=${amountCc}`
      );
    }
  } catch (err) {
    console.warn(
      `[amulet] cache update failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Invalidate the cached operator amulet. Called when chain rejects with
 * "Contract inactive" — the cached cid was archived between cache write
 * and use. Next call mints from participant query (which 413s on
 * operator, requiring a manual seed).
 */
export async function invalidateCachedOperatorAmulet(env: Env): Promise<void> {
  try {
    const { createDb, schema } = await import("../db");
    const { eq } = await import("drizzle-orm");
    const db = createDb(env.DATABASE_URL);
    const operator = operatorParty(env);
    await db
      .delete(schema.ccAmuletCache)
      .where(eq(schema.ccAmuletCache.partyId, operator));
    console.warn(
      `[amulet] cache INVALIDATE operator — chain reported stale cid`
    );
  } catch (err) {
    console.warn(
      `[amulet] cache invalidate failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Find a single Amulet owned by `ownerParty` with at least `minAmountCc`
 * initial balance. V1 uses single-input transfers; if no single amulet
 * is big enough the transfer fails (we don't auto-merge yet). For
 * V1.5 with high-value payouts we'd switch to multi-input transfers.
 */
export async function findAmulet(
  env: Env,
  ownerParty: string,
  minAmountCc: number
): Promise<{ contractId: string; amount: number; dso: string } | null> {
  const amulets = await query<AmuletPayload>(
    env,
    [ownerParty],
    AmuletTemplate(env)
  );
  for (const a of amulets) {
    if (a.payload.owner !== ownerParty) continue;
    const amount = Number(a.payload.amount.initialAmount);
    if (amount >= minAmountCc) {
      // `dso` is the DSO party id this amulet is signed under. Callers
      // need it to verify the AmuletRules they fetched from scan-proxy
      // matches this amulet — when they don't, AmuletRules_Transfer
      // fails at the synchronizer with "Contract group identifier
      // mismatch".
      return {
        contractId: a.contractId,
        amount,
        dso: a.payload.dso,
      };
    }
  }
  return null;
}

/**
 * Multi-input finder: return the fewest Amulets (largest-first) owned by
 * `ownerParty` whose balances SUM to at least `minAmountCc`, all sharing one
 * DSO. Lets a transfer draw on fragmented holdings instead of needing a single
 * big one — the Daml AmuletRules_Transfer takes many InputAmulets and returns
 * the remainder as change. Returns null only when the party's TOTAL (within the
 * best DSO) is short, or when it can't be covered within `maxInputs`.
 */
export async function findAmulets(
  env: Env,
  ownerParty: string,
  minAmountCc: number,
  maxInputs = 30
): Promise<{ contractIds: string[]; total: number; dso: string } | null> {
  const amulets = await query<AmuletPayload>(env, [ownerParty], AmuletTemplate(env));
  const owned = amulets
    .filter((a) => a.payload.owner === ownerParty)
    .map((a) => ({ cid: a.contractId, amount: Number(a.payload.amount.initialAmount), dso: a.payload.dso }))
    .filter((a) => Number.isFinite(a.amount) && a.amount > 0)
    .sort((x, y) => y.amount - x.amount);
  if (owned.length === 0) return null;
  // Greedy within a single DSO (mainnet holdings are all one DSO; this just
  // guards the rare mixed case since inputs must share a DSO).
  const dso = owned[0].dso;
  const chosen: string[] = [];
  let total = 0;
  for (const a of owned) {
    if (a.dso !== dso) continue;
    chosen.push(a.cid);
    total += a.amount;
    if (total >= minAmountCc) break;
    if (chosen.length >= maxInputs) break;
  }
  if (total < minAmountCc) return null;
  return { contractIds: chosen, total, dso };
}

/* ------------------------------------------------------------------ */
/*  Transfer                                                            */
/* ------------------------------------------------------------------ */

/**
 * Wire shape for the AmuletRules_Transfer choice argument.
 *
 * Decimal fields are JSON strings (Daml Decimal = fixed 10 fractional
 * digits). Sum types use the `{ tag, value }` shape. Map types serialize
 * as a flat JSON array of [key, value] pairs (NOT wrapped in `{ map }` —
 * Splice 0.6.3 rejects that wrapper with `Expected ujson.Arr (data:
 * {"map":[]})`).
 */
type AmuletRulesTransferArg = {
  transfer: {
    sender: string;
    provider: string;
    inputs: Array<{ tag: "InputAmulet"; value: string }>;
    outputs: Array<{
      receiver: string;
      receiverFeeRatio: string;
      amount: string;
      lock: null;
    }>;
    beneficiaries: null;
  };
  context: {
    openMiningRound: string;
    issuingMiningRounds: Array<[{ number: string }, string]>;
    validatorRights: [];
    featuredAppRight: string | null;
  };
  expectedDso: string | null;
};

export type TransferAmuletResult = {
  /** The exercise's transaction update id — proof of on-chain settlement.
   *  Also the id Lighthouse indexes the transfer under. */
  updateId: string;
  /** The raw on-chain transaction (update) id from the tx tree, or null if the
   *  tree lacked one (updateId then falls back to a contract id). */
  txUpdateId?: string | null;
  /** The new senderChange amulet (operator's remaining balance), if any. */
  senderChangeCid: string | null;
  /** The amulet created for the receiver (their incoming balance). */
  receiverAmuletCid: string | null;
  /** True only when a fee 2nd-output was requested AND actually included in the
   *  settled transfer. The caller MUST gate its house_fee row + fee debit on
   *  this — the retry fallback can drop the fee output, and booking a fee that
   *  never hit the chain created phantom fees (DB charged, slay-fees got 0). */
  feeApplied?: boolean;
  /** CANTON NETWORK fee — CC the protocol burnt settling this transfer, read
   *  off the exercise result and already persisted to `canton_tx_fees` keyed
   *  by updateId. Not Slay's product fee (that's `feeApplied` above), and not
   *  a number to sum per row: one chain tx fans out to several transactions
   *  rows. null = not captured (UNKNOWN), never "free". */
  networkFee?: BurntFee | null;
};

/**
 * Move `amountCc` from `senderParty` to `recipientParty` via a single
 * AmuletRules_Transfer command. Settles on chain in one tx tree.
 *
 * Caller-supplied sender — either side may be the operator:
 *   • welcome bonus + milestone rewards  (operator → user)
 *   • trade close on a win               (operator → user, +PnL)
 *   • trade close on a loss              (user → operator, |PnL|)
 *   • market winner payout               (operator → user, net gain)
 *   • market loser settlement            (user → operator, stake)
 *
 * actAs needs sender + recipient + operator (operator is always the
 * `provider`). The Worker has actAs on operator (ledger-api-user) and on
 * every onboarded user party (granted via grantUserActAs at signup).
 */
/** A party that receives part of a transfer as a fee: Slay's own, or a wallet
 *  provider's take on top of it. Paid as an extra output on the SAME transfer
 *  rather than a separate one — a transfer burns ~5.8 KB of synchronizer
 *  traffic (~3.5 CC) no matter how small the fee is, so paying a 0.075 CC
 *  provider fee in its own transfer would cost forty times what it moves. */
export type FeeOutput = { receiver: string; amountCc: number };

export async function transferAmulet(
  env: Env,
  senderParty: string,
  recipientParty: string,
  amountCc: number,
  memo: string,
  featuredOverride?: FeaturedBundle | null,
  feeOutput?: FeeOutput | FeeOutput[] | null
): Promise<TransferAmuletResult> {
  // Self-custody EXTERNAL sender: the operator can't actAs it, so the
  // AmuletRules_Transfer multi-actAs path here is unusable. Route through
  // the recipient's TransferPreapproval instead (KMS-signed downstream).
  // The fee-output leg is dropped — external users don't co-sign a fee
  // split here; fees are handled by the caller/service when applicable.
  const router = await import("../kms/router");
  const extKey = await router.loadExternalKeyForParty(env, senderParty);
  if (extKey) {
    const preapproval = await fetchTransferPreapproval(env, recipientParty);
    if (!preapproval) throw new LedgerCallError(400, `external sender needs recipient ${recipientParty.slice(0, 24)}… to have a TransferPreapproval`);
    return transferViaPreapprovalDirect(env, senderParty, recipientParty, amountCc, memo, preapproval, extKey);
  }
  // Self-custody EXTERNAL recipient with a LOCAL sender (e.g. operator payout /
  // cashout → external winner): the participant can't actAs the external
  // recipient in the multi-actAs path either. Route through the recipient's
  // preapproval — the local sender signs normally, the preapproval consents.
  if (router.looksExternalParty(env, recipientParty)) {
    const preapproval = await fetchTransferPreapproval(env, recipientParty);
    if (!preapproval) throw new LedgerCallError(400, `external recipient ${recipientParty.slice(0, 24)}… has no TransferPreapproval`);
    return transferViaPreapprovalDirect(env, senderParty, recipientParty, amountCc, memo, preapproval);
  }
  // Retry on two known transient classes of failure:
  //
  //   1. Inactive contracts — mining rounds rotate every ~10min and
  //      amulets rotate on every transfer / validator-activity tx; by
  //      the time other SVs confirm our submission, a referenced
  //      contract may have already been archived. Refetch and retry.
  //
  //   2. DSO mismatch — GSF's sv-1 scan replicas have been observed
  //      returning AmuletRules signed by a *different* DSO than our
  //      amulets are signed under (June 2026 incident). Each retry
  //      re-fetches scan-proxy, so eventually we hit a backend that
  //      serves the matching AmuletRules.
  //
  // 5 attempts with mild backoff covers ~80% of these cases without
  // crashing the caller. The sweep cron picks up whatever still drifts
  // and reconciles on subsequent ticks, so eventual consistency is
  // bounded even if every retry here fails.
  // SUBREQUEST BUDGET (Workers free tier = 50 per invocation)
  //
  // The previous architecture refetched AmuletRules + rounds on EVERY
  // retry, blowing through the 50 subrequest cap after ~6 attempts. Now
  // we fetch them ONCE at the outer level (2 subrequests) and only the
  // findAmulet + submit pair runs per retry attempt (~3 subrequests
  // each). That gives us a budget for ~14 retries in the happy path,
  // which significantly outlasts the worst observed amulet-churn rate.
  //
  // Subrequest math:
  //   - Send service prelude (DB queries):              ~9
  //   - Outer setup (AmuletRules + rounds):              2
  //   - Per attempt (findAmulet getLedgerEnd + ACS query + submit): ~3
  //   - 12 attempts × 3 = 36
  //   - Total worst case: ~47 — fits in 50 with thin headroom
  //
  // Per-attempt linear backoff: 400, 700, 1000, ... 3700 ms
  // Cumulative worst-case wait: ~25s — within the 30s Workers CPU limit.
  const MAX_ATTEMPTS = 12;

  // Fetch AmuletRules + rounds ONCE at the outer level. These don't
  // change between retries (within a few minutes anyway), so re-fetching
  // them every attempt was pure waste. On DSO mismatch we'll re-fetch
  // and retry, capped separately at MAX_DSO_REFETCH below.
  let amuletRulesInfo = await getAmuletRulesDisclosed(env);
  const rounds = await getOpenAndIssuingRoundsDisclosed(env);

  let featured = featuredOverride !== undefined ? featuredOverride : walletFeatured(env);
  /* One fee output or several — Slay's own, and a wallet provider's take on
   * top of it. Normalised to an array here so the rest of this function has
   * one shape to reason about, and so the strip fallback below cannot drop
   * one kind of fee while keeping another. */
  let feeOuts: FeeOutput[] = feeOutput
    ? Array.isArray(feeOutput)
      ? feeOutput.filter((f) => f && f.amountCc > 0)
      : [feeOutput]
    : [];
  const feesRequested = feeOuts.length;
  /* The caller subtracts the fee from the amount before calling — that is what
   * keeps a whole-balance send inside a single amulet. So if the fee output is
   * stripped below, the subtraction has to be undone here, in the same
   * submission. See the strip site for why. */
  let recipientCc = amountCc;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await transferAmuletOnce(
        env,
        senderParty,
        recipientParty,
        recipientCc,
        memo,
        amuletRulesInfo,
        rounds,
        featured,
        feeOuts
      );
      // Success — remember the AmuletRules contract we just used. The
      // participant accepted it, so it's the canonical one. Future
      // transferAmulet calls skip scan-proxy entirely until TTL expiry.
      rememberWorkingAmuletRules(
        amuletRulesInfo.disclosed,
        amuletRulesInfo.dsoParty
      );
      // Tell the caller whether the fee 2nd-output actually made it into this
      // settled transfer. It did iff the caller asked for one AND we didn't
      // strip it in a fallback retry below.
      /* True only when every fee output asked for actually settled. It is
       * all-or-nothing because the fallback strips them together — there is
       * no state where Slay's fee lands and a partner's does not. */
      return { ...result, feeApplied: feesRequested > 0 && feeOuts.length === feesRequested };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isInactiveRace =
        msg.includes("INACTIVE_CONTRACTS") ||
        msg.includes("LOCAL_VERDICT_INACTIVE") ||
        msg.includes("CONTRACT_NOT_FOUND");
      const isDsoMismatch =
        msg.includes("Contract group identifier mismatch") ||
        msg.includes("expected ForOwner") ||
        msg.includes("DSO party expected by caller");
      const isRetryable = isInactiveRace || isDsoMismatch;
      if (!isRetryable) {
        // A non-retryable failure is usually a stale featured-app-right
        // (re-vetting lag after a Splice upgrade). Drop the MARKER first and
        // retry WITH the fee still attached — the marker is best-effort, the
        // fee is real money. Only if it STILL fails do we drop the fee, and in
        // that case feeApplied comes back false so the caller books no phantom
        // house_fee. Previously both were dropped together, which silently
        // stripped the fee while the caller still charged it.
        if (featured) { featured = null; continue; }
        if (feeOuts.length) {
          /* Dropping the fee output used to short-change the recipient.
           *
           * The caller hands us `amount − fee` for the recipient and the fee
           * as a second output. Strip that output and the next attempt still
           * sends `amount − fee` — so the transfer settles with the recipient
           * short by the fee, the sender keeping it, and nobody collecting
           * anything. Every ledger agreed with itself, which is precisely why
           * it survived: the shortfall was invisible from any single row.
           *
           * Sweeping the fee afterwards in its own transfer was the obvious
           * fix and is the wrong one — a transfer burns roughly 5.8 KB of
           * synchronizer traffic, about $0.35 at the governance price, to
           * recover a fee worth about $0.12. It would lose money three times
           * over on every occurrence.
           *
           * So the fee goes back to the recipient instead, in this same
           * submission. If Slay cannot take its fee, Slay does not get to
           * keep it out of the customer's transfer either. `feeApplied`
           * comes back false, the caller books no house_fee, and the amounts
           * on both sides are what the sender actually asked for.          */
          for (const f of feeOuts) recipientCc += f.amountCc;
          feeOuts = [];
          continue;
        }
        throw err;
      }

      // On DSO mismatch, refetch AmuletRules — the scan-proxy may have
      // a different replica that serves the matching DSO version.
      if (isDsoMismatch) {
        // Whatever we had cached was wrong — drop it before refetching.
        invalidateAmuletRulesCache();
        try {
          amuletRulesInfo = await getAmuletRulesDisclosed(env);
        } catch {
          // If refetch fails, fall through with the old rules — the
          // next attempt will fail the same way and we'll exit the loop.
        }
      }
      // On inactive-contract race, also bust the cache — the cached
      // AmuletRules cid may have been archived by a round rotation.
      // Next attempt will refetch and find the live one.
      if (isInactiveRace) {
        invalidateAmuletRulesCache();
        // A stale operator amulet cid (archived by a prior send) surfaces as
        // an inactive-contract race — drop the cache so the next attempt
        // rediscovers a live one via the updates walk / scan.
        if (senderParty === operatorParty(env)) {
          await invalidateCachedOperatorAmulet(env).catch(() => {});
        }
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        // Linear-stepped backoff: 400, 700, 1000, 1300, ... 3700 ms.
        // Long tail gives the participant's ACS time to converge on
        // a stable amulet cid after concurrent operations.
        const delay = 400 + attempt * 300;
        if (env.SPLICE_DEBUG === "1") {
          console.log(
            `[transferAmulet] retry ${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms — ${
              isDsoMismatch ? "DSO mismatch" : "inactive contract race"
            }`
          );
        }
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new LedgerCallError(
        500,
        `transferAmulet failed after ${MAX_ATTEMPTS} attempts`
      );
}

async function transferAmuletOnce(
  env: Env,
  senderParty: string,
  recipientParty: string,
  amountCc: number,
  _memo: string, // reserved for future on-chain memo support
  // Pre-fetched by the outer retry loop. They don't change between
  // retries within seconds of each other, so re-fetching them per attempt
  // was burning Workers' subrequest budget for no benefit. Outer also
  // owns the DSO-refetch logic now — if the rules' DSO doesn't match
  // the amulet's DSO, this function throws and the outer loop re-fetches
  // before the next attempt.
  amuletRulesInfo: { disclosed: DisclosedContract; dsoParty: string },
  rounds: {
    openMiningRound: DisclosedContract;
    issuingMiningRounds: Array<{ round: string; disclosed: DisclosedContract }>;
  },
  featured: FeaturedBundle | null,
  feeOutputs: FeeOutput[]
): Promise<TransferAmuletResult> {
  const operator = operatorParty(env);

  // Only the amulet needs re-fetching per attempt — that's where the
  // race lives. The participant's ACS may have a different live cid
  // than the one we saw last time, and that's exactly what we want.
  const totalInputCc =
    amountCc + feeOutputs.reduce((sum, f) => sum + f.amountCc, 0);
  // The operator party owns 600+ contracts → a wildcard active-contracts
  // query 413s. Route operator-sourced transfers through the cache/scan
  // finder instead of findAmulet (which does the 413-prone ACS query).
  const isOperatorSender = senderParty === operator;
  // Operator stays single-input (its ACS 413s → special flats-walk finder).
  // Users draw on MULTIPLE holdings so fragmented balances can still send.
  let inputCids: string[];
  let inputDso: string;
  let amulet: { contractId: string; amount: number; dso?: string } | null = null;
  if (isOperatorSender) {
    amulet = await findOperatorAmulet(env, totalInputCc);
    if (!amulet) {
      throw new LedgerCallError(409, `Party ${senderParty} has no Amulet with at least ${totalInputCc} CC.`);
    }
    inputCids = [amulet.contractId];
    inputDso = amulet.dso ?? "";
  } else {
    const set = await findAmulets(env, senderParty, totalInputCc);
    if (!set) {
      throw new LedgerCallError(409, `Party ${senderParty} has no Amulet with at least ${totalInputCc} CC.`);
    }
    inputCids = set.contractIds;
    inputDso = set.dso;
  }

  // PRE-FLIGHT DSO MATCH
  // The sender's amulet is signed by amulet.dso. The AmuletRules we
  // were given is signed by amuletRulesInfo.dsoParty. Canton's interpreter
  // requires both to match — otherwise it rejects with "Contract group
  // identifier mismatch". On mismatch, throw with a marker the outer
  // retry wrapper recognises; the outer refetches AmuletRules before
  // the next attempt (different scan replica may serve matching DSO).
  if (inputDso && inputDso !== amuletRulesInfo.dsoParty) {
    throw new LedgerCallError(
      400,
      `DSO party expected by caller mismatch — ` +
        `rules.dso=${amuletRulesInfo.dsoParty.slice(0, 36)}… vs ` +
        `amulet.dso=${inputDso.slice(0, 36)}…`
    );
  }
  const amuletRules = amuletRulesInfo.disclosed;
  const dsoParty = amuletRulesInfo.dsoParty;

  // 2. Build the Transfer payload. Operator is always the `provider`
  // (the app facilitating the transfer) regardless of which side is
  // sender vs receiver.
  const arg: AmuletRulesTransferArg = {
    transfer: {
      sender: senderParty,
      provider: featured?.provider ?? operator,
      inputs: inputCids.map((v) => ({ tag: "InputAmulet" as const, value: v })),
      outputs: [
        {
          receiver: recipientParty,
          receiverFeeRatio: "0.0000000000",
          amount: amountCc.toFixed(10),
          lock: null,
        },
        ...feeOutputs.map((f) => ({
          receiver: f.receiver,
          receiverFeeRatio: "0.0000000000",
          amount: f.amountCc.toFixed(10),
          lock: null,
        })),
      ],
      beneficiaries: null,
    },
    context: {
      openMiningRound: rounds.openMiningRound.contractId,
      // Issuing mining rounds are only consumed when redeeming
      // AppRewardCoupon / ValidatorRewardCoupon / etc inputs. For a
      // pure InputAmulet → TransferOutput simple transfer there are
      // no reward inputs, so we leave the map empty. Including stale
      // rounds (which is what we were doing earlier) made the
      // synchronizer reject with LOCAL_VERDICT_INACTIVE_CONTRACTS
      // because issuing rounds rotate every ~10min and scan-proxy can
      // return ones that have already been archived.
      issuingMiningRounds: [],
      validatorRights: [],
      featuredAppRight: featured?.cid ?? null,
    },
    // Splice's AmuletRules_Transfer requires the caller to declare which
    // DSO they expect to be transacting with — a defence-in-depth check
    // so a malicious AmuletRules contract id can't trick us into
    // routing CC through someone else's governance. Pulled from env.
    // expectedDso must match the live DSO on the AmuletRules contract.
    // Hardcoding from env breaks on MainNet rotation.
    expectedDso: dsoParty,
  };

  // 3. actAs = sender + recipient + operator (deduplicated). Both
  // parties have to authorise (sender consumes the input; recipient
  // accepts the new amulet); operator is included because it's the
  // `provider`. We have actAs rights on operator (ledger-api-user) and
  // on every onboarded user via grantUserActAs.
  const actAs = Array.from(
    new Set([
      senderParty,
      recipientParty,
      operator,
      ...(featured?.provider ? [featured.provider] : []),
      ...feeOutputs.map((f) => f.receiver),
    ])
  );
  const disclosed: DisclosedContract[] = [
    amuletRules,
    rounds.openMiningRound,
  ];
  if (featured?.blob) {
    const [amuletPkg] = amuletRules.templateId.split(":");
    disclosed.push({
      templateId: `${amuletPkg}:Splice.Amulet:FeaturedAppRight`,
      contractId: featured.cid,
      createdEventBlob: featured.blob,
      synchronizerId: rounds.openMiningRound.synchronizerId,
    });
  }
  // Use the CURRENT AmuletRules package from the live disclosed contract, NOT
  // the pinned SPLICE_AMULET_PACKAGE_ID — the pin goes stale on every Daml
  // upgrade and makes AmuletRules_Transfer fail with
  // INTERPRETATION_UPGRADE_ERROR (the bug that made ~98% of internal sends
  // fall back to Postgres-only). Mirrors the preapproval-setup.ts fix.
  const [arPkg, arModule, arEntity] = amuletRules.templateId.split(":");
  const result = await exercise<AmuletRulesTransferArg, unknown>(
    env,
    actAs,
    { packageId: arPkg, moduleName: arModule, entityName: arEntity },
    amuletRules.contractId,
    "AmuletRules_Transfer",
    arg,
    { disclosedContracts: disclosed }
  );

  // 4. Pull out the senderChange + receiver amulet from the events
  // (best-effort, Postgres is the user-visible truth either way).
  let senderChangeCid: string | null = null;
  let receiverAmuletCid: string | null = null;
  for (const ev of result.events) {
    if (ev.kind === "created" && ev.templateId.endsWith(":Splice.Amulet:Amulet")) {
      const owner = (ev.payload as AmuletPayload).owner;
      if (owner === senderParty) senderChangeCid = ev.contractId;
      else if (owner === recipientParty) receiverAmuletCid = ev.contractId;
    }
  }

  // Keep the operator amulet cache current so back-to-back operator sends
  // don't reuse the now-archived input cid. On no change (operator spent
  // its whole amulet), drop the cache so the next lookup rediscovers.
  if (isOperatorSender) {
    if (senderChangeCid) {
      await setCachedOperatorAmulet(env, senderChangeCid, Math.max(0, (amulet?.amount ?? 0) - totalInputCc)).catch(() => {});
    } else {
      await invalidateCachedOperatorAmulet(env).catch(() => {});
    }
  }

  // 5. Network fee. `result.exerciseResult` is the TransferResult whose
  // `summary` carries holdingFees + outputFees + senderChangeFee — the CC the
  // chain just burnt. It was previously discarded here, which is why no
  // free-vs-paid number existed. recordNetworkFee never throws and never
  // rejects: the transfer has already settled on chain by this point, so a
  // reporting write must not be able to turn a settled send into an error.
  const networkFee = await recordNetworkFee(env, {
    updateId: result.updateId,
    choice: "AmuletRules_Transfer",
    exerciseResult: result.exerciseResult,
    senderParty,
    receiverParty: recipientParty,
    source: "live",
  });

  return {
    networkFee,
    // Caller-facing "tx id" — the real on-chain transaction (update) id, which
    // is what Lighthouse/scan index this transfer under
    // (lighthouse.cantonloop.com/transactions/<updateId>). Fall back to the
    // receiver amulet contract id only if the tree somehow lacked an updateId.
    updateId: result.updateId ?? receiverAmuletCid ?? senderChangeCid ?? amuletRules.contractId,
    txUpdateId: result.updateId ?? null,
    senderChangeCid,
    receiverAmuletCid,
  };
}

/**
 * Consolidate every Amulet owned by `party` into one large Amulet via a
 * single multi-input AmuletRules_Transfer (all inputs → one self output;
 * the fee/remainder returns as change). V1 transfers are single-input, so a
 * party whose balance is fragmented across many small amulets (e.g. the fees
 * party — one amulet per fee collected) can't source a payout bigger than its
 * largest single amulet until merged. Only usable on parties under the 200
 * active-contracts cap (the operator is not — it needs the updates walk).
 */
export async function mergeAmulets(
  env: Env,
  party: string
): Promise<{ merged: number; sumCc: number; outputCc: number; updateId: string | null; reason?: string }> {
  const operator = operatorParty(env);
  const all = await query<AmuletPayload>(env, [party], AmuletTemplate(env));
  const mine = all.filter((a) => a.payload.owner === party);
  const sum = mine.reduce((s, a) => s + Number(a.payload.amount.initialAmount || 0), 0);
  if (mine.length <= 1) return { merged: 0, sumCc: sum, outputCc: 0, updateId: null, reason: "nothing-to-merge" };

  const reserve = Math.max(1, mine.length * 0.1);
  const outputCc = Math.floor((sum - reserve) * 1e6) / 1e6;
  if (outputCc <= 0) return { merged: 0, sumCc: sum, outputCc: 0, updateId: null, reason: "sum-too-small" };

  const amuletRulesInfo = await getAmuletRulesDisclosed(env);
  const rounds = await getOpenAndIssuingRoundsDisclosed(env);
  const arg: AmuletRulesTransferArg = {
    transfer: {
      sender: party,
      provider: operator,
      inputs: mine.map((a) => ({ tag: "InputAmulet" as const, value: a.contractId })),
      outputs: [{ receiver: party, receiverFeeRatio: "0.0000000000", amount: outputCc.toFixed(10), lock: null }],
      beneficiaries: null,
    },
    context: {
      openMiningRound: rounds.openMiningRound.contractId,
      issuingMiningRounds: [],
      validatorRights: [],
      featuredAppRight: null,
    },
    expectedDso: amuletRulesInfo.dsoParty,
  };
  const actAs = Array.from(new Set([party, operator]));
  const disclosed: DisclosedContract[] = [amuletRulesInfo.disclosed, rounds.openMiningRound];
  const [arPkg, arModule, arEntity] = amuletRulesInfo.disclosed.templateId.split(":");
  const result = await exercise<AmuletRulesTransferArg, unknown>(
    env,
    actAs,
    { packageId: arPkg, moduleName: arModule, entityName: arEntity },
    amuletRulesInfo.disclosed.contractId,
    "AmuletRules_Transfer",
    arg,
    { disclosedContracts: disclosed }
  );
  // A merge is a real AmuletRules_Transfer and burns on the same formula,
  // but it is non-user-initiated (admin POST /admin/cc/merge-amulets, and
  // letsexchange/service.ts) and writes NO transactions row — so this row's
  // ref_type is the only attribution it will ever have. Without capture here
  // the burn would be invisible to every dashboard number.
  await recordNetworkFee(env, {
    updateId: result.updateId,
    choice: "AmuletRules_Transfer",
    exerciseResult: result.exerciseResult,
    senderParty: party,
    receiverParty: party,
    refType: "amulet_merge",
    source: "live",
  });
  return { merged: mine.length, sumCc: sum, outputCc, updateId: result.updateId ?? null };
}

/* ------------------------------------------------------------------ *
 *  TRANSFER VIA PREAPPROVAL — Stage 3                                  *
 *                                                                      *
 *  Sends CC to an external party using their published                 *
 *  TransferPreapproval contract as their pre-baked consent. Same       *
 *  transport as transferAmulet (JSON Ledger API + ledger-api-user),    *
 *  different choice — `Splice.AmuletRules:TransferPreapproval` /       *
 *  `TransferPreapproval_Send`. The sender is the sole controller so    *
 *  actAs = [senderParty] only — operator and receiver stay out.        *
 *                                                                      *
 *  Why this exists vs. transferAmulet:                                 *
 *    transferAmulet's AmuletRules_Transfer puts the recipient in       *
 *    actAs, which we only have rights for on our OWN users. For        *
 *    external recipients, that path returns NO_SYNCHRONIZER from the   *
 *    chain. The preapproval-send choice is the receiver's pre-bake     *
 *    consent — it bypasses the actAs-on-receiver requirement.          *
 *                                                                      *
 *  Daml signature (Splice AmuletRules.daml):                           *
 *    nonconsuming choice TransferPreapproval_Send :                     *
 *                          TransferPreapproval_SendResult              *
 *      with                                                            *
 *        context : PaymentTransferContext                              *
 *        inputs  : [TransferInput]                                     *
 *        amount  : Decimal                                             *
 *        sender  : Party                                               *
 *        description : Optional Text                                   *
 *      controller sender                                               *
 *                                                                      *
 *  Caller supplies the preapproval lookup from                         *
 *  `fetchTransferPreapproval()`. Discloses: amuletRules, openRound,    *
 *  preapproval itself. issuingMiningRounds/validatorRights stay empty  *
 *  because a simple Amulet → Amulet hop doesn't redeem reward coupons. *
 * ------------------------------------------------------------------ */

const TransferPreapprovalTemplate = (env: Env) =>
  spliceAmuletTemplate(env, "Splice.AmuletRules", "TransferPreapproval");

type TransferPreapprovalSendArg = {
  context: {
    amuletRules: string;
    context: {
      openMiningRound: string;
      issuingMiningRounds: [];
      validatorRights: [];
      featuredAppRight: string | null;
    };
  };
  inputs: Array<{ tag: "InputAmulet"; value: string }>;
  amount: string;
  sender: string;
  description: string | null;
};

export async function transferViaPreapprovalDirect(
  env: Env,
  senderParty: string,
  recipientParty: string,
  amountCc: number,
  memo: string,
  preapproval: TransferPreapprovalInfo,
  externalKey?: import("../kms/keys").EncryptedKey
): Promise<TransferAmuletResult> {
  // Auto-route: if the sender is a self-custody external party, KMS-sign.
  externalKey = await (await import("../kms/router")).maybeExternalKey(env, senderParty, externalKey);
  // MAX_ATTEMPTS=6 (was 12) to stay within Workers free-tier subrequest
  // cap. Per-retry budget now refetches up to 3 fresh contracts (rules,
  // rounds, preapproval), so we can't afford 12 rounds even on paid.
  const MAX_ATTEMPTS = 6;
  let amuletRulesInfo = await getAmuletRulesDisclosed(env);
  let roundsBase = await getOpenAndIssuingRoundsDisclosed(env);
  // Scan-proxy replica lag keeps serving the same just-archived
  // OpenMiningRound, so on an INACTIVE_CONTRACTS reject we rotate through
  // the other open rounds scan already gave us rather than re-pulling the
  // same stale [0]. roundIdx walks roundsBase.openMiningRoundCandidates.
  let roundIdx = 0;
  let rounds: {
    openMiningRound: DisclosedContract;
    issuingMiningRounds: typeof roundsBase.issuingMiningRounds;
  } = {
    openMiningRound: roundsBase.openMiningRoundCandidates[roundIdx],
    issuingMiningRounds: roundsBase.issuingMiningRounds,
  };
  let currentPreapproval = preapproval;

  let paFeaturedCid = walletFeatured(env)?.cid ?? null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // Unconditional cid log so wrangler tail always has the diagnostic.
      // If we get LOCAL_VERDICT_INACTIVE, the stale cid in the error
      // payload can be matched against these to identify which contract
      // rotated. Each line is ~120 chars × max 6 attempts = harmless.
      console.log(
        `[transferViaPreapproval] attempt ${attempt + 1} cids — ` +
          `amuletRules=${amuletRulesInfo.disclosed.contractId.slice(0, 24)}… ` +
          `openRound=${rounds.openMiningRound.contractId.slice(0, 24)}… ` +
          `preapproval=${currentPreapproval.disclosed.contractId.slice(0, 24)}…`
      );
      const result = await transferViaPreapprovalOnce(
        env,
        senderParty,
        recipientParty,
        amountCc,
        memo,
        amuletRulesInfo,
        rounds,
        currentPreapproval,
        paFeaturedCid,
        externalKey
      );
      rememberWorkingAmuletRules(amuletRulesInfo.disclosed, amuletRulesInfo.dsoParty);
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isInactiveRace =
        msg.includes("INACTIVE_CONTRACTS") ||
        msg.includes("LOCAL_VERDICT_INACTIVE") ||
        msg.includes("CONTRACT_NOT_FOUND");
      const isDsoMismatch =
        msg.includes("Contract group identifier mismatch") ||
        msg.includes("expected ForOwner") ||
        msg.includes("DSO party expected by caller");
      // Stale featured-app-right cid (SLAY_WALLET_FEATURED_RIGHT_CID drifts on
      // Splice upgrades — the contract gets re-created) surfaces as
      // CONTRACT_NOT_FOUND on that cid. featuredAppRight is OPTIONAL for
      // TransferPreapproval_Send, so drop it and retry: the send succeeds, it
      // just forgoes the app-reward marker on this one transfer. Without this,
      // CONTRACT_NOT_FOUND is treated as a retryable race and we re-send the
      // same dead cid every attempt → platform-wide external-send failure.
      if (
        msg.includes("CONTRACT_NOT_FOUND") &&
        paFeaturedCid &&
        msg.includes(paFeaturedCid.slice(0, 64))
      ) {
        console.warn(
          `[transferViaPreapproval] featured-app-right ${paFeaturedCid.slice(0, 24)}… not found on chain — retrying without it (SLAY_WALLET_FEATURED_RIGHT_CID is stale)`
        );
        paFeaturedCid = null;
      }
      const isRetryable = isInactiveRace || isDsoMismatch;
      if (!isRetryable) {
        if (paFeaturedCid) { paFeaturedCid = null; continue; }
        throw err;
      }

      // Extract the inactive contract id from the error payload and tell
      // the operator which of our cids it matches. That's the diagnostic
      // we couldn't get before — Cumberland reports the stale cid, we
      // compare it against ours and know whether to fix the rounds path,
      // the preapproval refresh, or something more exotic.
      if (isInactiveRace) {
        const m = msg.match(/CONTRACT_ID["']?\s*:\s*"List\(([^)]+)\)"/);
        const staleCid = m?.[1]?.trim();
        if (staleCid) {
          const which =
            staleCid === amuletRulesInfo.disclosed.contractId
              ? "AmuletRules"
              : staleCid === rounds.openMiningRound.contractId
                ? "OpenMiningRound"
                : staleCid === currentPreapproval.disclosed.contractId
                  ? "TransferPreapproval"
                  : "unknown (likely receiver-side validator contract)";
          console.warn(
            `[transferViaPreapproval] inactive ref — stale=${staleCid.slice(0, 24)}… (${which})`
          );
        }
      }

      // Refresh strategy per error class:
      //   DSO mismatch — only AmuletRules can drift (scan-proxy
      //                  inconsistency). Refetch it.
      //   Inactive    — AmuletRules, OpenMiningRound, AND the
      //                  preapproval could all be stale. Refetch all
      //                  three. The receiver-side validator's contracts
      //                  aren't ones we hold disclosed, so we can't
      //                  refresh those — but the participant will pick
      //                  up the canonical ones automatically once the
      //                  ones WE control are fresh.
      if (isDsoMismatch) {
        invalidateAmuletRulesCache();
        try {
          amuletRulesInfo = await getAmuletRulesDisclosed(env);
        } catch {
          /* keep last known on transport blip */
        }
      }
      if (isInactiveRace) {
        // AmuletRules + the receiver's preapproval can genuinely rotate, so
        // refresh those. The OpenMiningRound is the special case: scan-proxy
        // lag keeps serving the same archived round, so refetching is futile
        // — rotate to the next open-round candidate scan already gave us,
        // and only refetch the list once we've exhausted the candidates.
        invalidateAmuletRulesCache();
        // The cached operator amulet can be archived out-of-band (validator
        // automation merges/fees). transferAmulet's loop already busts it,
        // but external recipients route through THIS loop — without this the
        // same dead cid replays every attempt and operator sends wedge.
        if (!externalKey && senderParty === operatorParty(env)) {
          await invalidateCachedOperatorAmulet(env).catch(() => {});
        }
        try {
          amuletRulesInfo = await getAmuletRulesDisclosed(env);
        } catch {
          /* keep last known on transport blip */
        }
        try {
          const fresh = await fetchTransferPreapproval(env, recipientParty);
          if (fresh) currentPreapproval = fresh;
        } catch {
          /* keep last known */
        }
        if (roundIdx + 1 < roundsBase.openMiningRoundCandidates.length) {
          roundIdx++;
        } else {
          try {
            roundsBase = await getOpenAndIssuingRoundsDisclosed(env);
            roundIdx = 0;
          } catch {
            /* keep last known list */
          }
        }
        rounds = {
          openMiningRound: roundsBase.openMiningRoundCandidates[roundIdx],
          issuingMiningRounds: roundsBase.issuingMiningRounds,
        };
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = 600 + attempt * 400;
        if (env.SPLICE_DEBUG === "1") {
          console.log(
            `[transferViaPreapproval] retry ${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms — ${isDsoMismatch ? "DSO mismatch" : "inactive contract race"}`
          );
        }
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new LedgerCallError(500, `transferViaPreapproval failed after ${MAX_ATTEMPTS} attempts`);
}

async function transferViaPreapprovalOnce(
  env: Env,
  senderParty: string,
  recipientParty: string,
  amountCc: number,
  memo: string,
  amuletRulesInfo: { disclosed: DisclosedContract; dsoParty: string },
  rounds: {
    openMiningRound: DisclosedContract;
    issuingMiningRounds: Array<{ round: string; disclosed: DisclosedContract }>;
  },
  preapproval: TransferPreapprovalInfo,
  featuredCid: string | null,
  externalKey?: import("../kms/keys").EncryptedKey
): Promise<TransferAmuletResult> {
  // 1. Locate a sender amulet with enough balance. Single-input only
  // for V1 (matches transferAmulet's constraint). The operator owns 600+
  // contracts → its wildcard active-contracts query 413s (>200 cap), so use
  // the bounded /v2/updates/flats walk for the operator (same branch as
  // transferAmulet); normal users use the cheap ACS finder.
  let inputCids: string[];
  let inputDso: string;
  if (senderParty === operatorParty(env)) {
    const amulet = await findOperatorAmulet(env, amountCc);
    if (!amulet) {
      throw new LedgerCallError(409, `Party ${senderParty} has no Amulet with at least ${amountCc} CC.`);
    }
    inputCids = [amulet.contractId];
    inputDso = amulet.dso ?? "";
  } else if (
    (env.SLAY_PREDICTION_PARTY && senderParty === env.SLAY_PREDICTION_PARTY) ||
    (env.SLAY_FEES_PARTY && senderParty === env.SLAY_FEES_PARTY)
  ) {
    // Prediction AND fees parties both accumulate 200+ contracts (PmBets /
    // every fee transfer ever), so the cheap ACS finder below 413s. Walk the
    // flats stream instead. MULTI-input: their CC arrives fragmented (one
    // amulet per escrow or fee), so any send above a single fragment needs
    // several inputs.
    const set = await findPartyAmuletSetViaWalk(env, senderParty, amountCc);
    if (!set || set.total < amountCc) {
      throw new LedgerCallError(409, `Party ${senderParty} has no Amulets covering ${amountCc} CC (found ${set?.total ?? 0}).`);
    }
    inputCids = set.contractIds;
    inputDso = "";
  } else {
    // Multi-input: draw on fragmented holdings so a user whose CC is split
    // across many small amulets can still send.
    const set = await findAmulets(env, senderParty, amountCc);
    if (!set) {
      throw new LedgerCallError(409, `Party ${senderParty} has no Amulet with at least ${amountCc} CC.`);
    }
    inputCids = set.contractIds;
    inputDso = set.dso;
  }

  // 2. DSO match pre-flight — same as transferAmulet. The sender's amulet,
  // the AmuletRules, AND the preapproval must all reference the same DSO.
  if (inputDso && inputDso !== amuletRulesInfo.dsoParty) {
    throw new LedgerCallError(
      400,
      `DSO party expected by caller mismatch — ` +
        `rules.dso=${amuletRulesInfo.dsoParty.slice(0, 36)}… vs ` +
        `amulet.dso=${inputDso.slice(0, 36)}…`
    );
  }
  if (preapproval.payload.dso !== amuletRulesInfo.dsoParty) {
    throw new LedgerCallError(
      400,
      `Preapproval DSO mismatch — ` +
        `preapproval.dso=${preapproval.payload.dso.slice(0, 36)}… vs ` +
        `rules.dso=${amuletRulesInfo.dsoParty.slice(0, 36)}…`
    );
  }

  // 3. Build the choice arg per the Daml signature.
  const arg: TransferPreapprovalSendArg = {
    context: {
      amuletRules: amuletRulesInfo.disclosed.contractId,
      context: {
        openMiningRound: rounds.openMiningRound.contractId,
        issuingMiningRounds: [],
        validatorRights: [],
        featuredAppRight: featuredCid,
      },
    },
    inputs: inputCids.map((v) => ({ tag: "InputAmulet" as const, value: v })),
    amount: amountCc.toFixed(10),
    sender: senderParty,
    description: memo || null,
  };

  // 4. Exercise on the preapproval contract. actAs = sender only —
  // controller of TransferPreapproval_Send is `sender`. The preapproval
  // is the receiver's consent; provider's authorisation comes through
  // their signature on the preapproval contract itself.
  const actAs = [senderParty];
  const disclosed: DisclosedContract[] = [
    amuletRulesInfo.disclosed,
    rounds.openMiningRound,
    preapproval.disclosed,
  ];
  // Exercise at the package of the LIVE AmuletRules, not the preapproval's own
  // creation package. TransferPreapproval_Send is defined in the AmuletRules
  // package, and AmuletRules + OpenMiningRound are always at the network's
  // CURRENT version. A third-party preapproval can be old (KuCoin's dates to
  // 2025-10), and pinning to it forces the participant to DOWNGRADE those newer
  // contracts → INTERPRETATION_UPGRADE_ERROR_TRANSLATION_FAILED. Upgrading an
  // old preapproval to the current package is the direction SCU supports, so
  // derive the package from AmuletRules and keep the preapproval's module/
  // entity. (Slay-internal sends worked before only because our own users'
  // preapprovals happened to be on the current package.)
  const [ppPkg, ppModule, ppEntity] = preapproval.disclosed.templateId.split(":");
  const [arPkg] = amuletRulesInfo.disclosed.templateId.split(":");
  let result: { events: Array<{ kind: string; templateId: string; contractId: string; payload: unknown }>; updateId: string | null; exerciseResult: unknown };
  if (externalKey) {
    // Sender is a self-custody EXTERNAL party — operator can't actAs it, so
    // KMS-sign the same TransferPreapproval_Send via interactive submission.
    const { externalExercise } = await import("../kms/interactive");
    const templateId = `${arPkg || ppPkg}:${ppModule}:${ppEntity}`;
    const r = await externalExercise(
      env,
      externalKey,
      senderParty,
      [{ ExerciseCommand: { templateId, contractId: preapproval.disclosed.contractId, choice: "TransferPreapproval_Send", choiceArgument: arg } }],
      disclosed as unknown[]
    );
    result = { events: r.events, updateId: r.updateId, exerciseResult: null };
  } else {
    result = (await exercise<TransferPreapprovalSendArg, unknown>(
      env,
      actAs,
      { packageId: arPkg || ppPkg, moduleName: ppModule, entityName: ppEntity },
      preapproval.disclosed.contractId,
      "TransferPreapproval_Send",
      arg,
      { disclosedContracts: disclosed }
    )) as unknown as typeof result;
  }

  // 5. Surface the resulting amulets from the tx tree.
  let senderChangeCid: string | null = null;
  let receiverAmuletCid: string | null = null;
  for (const ev of result.events) {
    if (ev.kind === "created" && ev.templateId.endsWith(":Splice.Amulet:Amulet")) {
      const owner = (ev.payload as AmuletPayload).owner;
      if (owner === senderParty) senderChangeCid = ev.contractId;
      else if (owner === recipientParty) receiverAmuletCid = ev.contractId;
    }
  }

  // 6. Network fee. The root result here is a TransferPreapproval_SendResult,
  // and the fee-bearing TransferResult may be a field on it OR only on the
  // nested AmuletRules_Transfer node — which ledger.ts's exercise() does not
  // surface, since it matches the ROOT node only. So computeBurntFee searches
  // the result for the fields rather than reading a fixed path: if the summary
  // is reachable we get the real burn, and if it only exists on the child node
  // we get null (UNKNOWN) instead of a wrong number or a thrown error.
  const networkFee = await recordNetworkFee(env, {
    updateId: result.updateId,
    choice: "TransferPreapproval_Send",
    exerciseResult: result.exerciseResult,
    senderParty,
    receiverParty: recipientParty,
    source: "live",
  });

  return {
    networkFee,
    // Prefer the real on-chain tx (update) id so external sends deep-link to
    // Lighthouse too; fall back to a contract id only if the tree lacked one.
    updateId: result.updateId ?? receiverAmuletCid ?? senderChangeCid ?? preapproval.disclosed.contractId,
    txUpdateId: result.updateId ?? null,
    senderChangeCid,
    receiverAmuletCid,
  };
}
