/* ------------------------------------------------------------------ *
 *  splice/traffic.ts — DIRECT sequencer-traffic purchase.
 *
 *  Buys extra sequencer traffic by exercising the DSO-governed
 *  `Splice.AmuletRules:AmuletRules_BuyMemberTraffic` choice straight on
 *  the ledger — the SAME machinery transferAmulet uses (operator amulet
 *  inputs + TransferContext + AmuletRules/OpenMiningRound disclosed).
 *
 *  This is the no-restart alternative to the validator-app auto-topup
 *  (which needs a config edit + `start.sh` restart). Controller is the
 *  provider (our operator party, which the Worker holds actAs on), so
 *  it's a single-party submit. CC is burnt for the traffic + fees; any
 *  change comes back as a senderChangeAmulet.
 *
 *  Choice signature (Splice-AmuletRules):
 *    inputs         : [TransferInput]     -- operator amulets to spend
 *    context        : TransferContext     -- openMiningRound + empties
 *    provider       : Party               -- operator (controller)
 *    memberId       : Text                -- "PAR::" + participant id
 *    synchronizerId : Text                -- global-domain::…
 *    migrationId    : Int
 *    trafficAmount  : Int                 -- bytes to buy
 *    expectedDso    : Optional Party
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import { exercise, operatorParty, type DisclosedContract } from "../canton/ledger";
import {
  getAmuletRulesDisclosed,
  getOpenAndIssuingRoundsDisclosed,
  findOperatorAmulet,
  invalidateCachedOperatorAmulet,
} from "./amulet";

/** MainNet global synchronizer id (override via env). */
export function synchronizerId(env: Env): string {
  return (
    env.SPLICE_SYNCHRONIZER_ID ||
    "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc"
  );
}

/** Canton member id for this participant = "PAR::" + participant id. */
export function participantMemberId(env: Env): string {
  const pid =
    env.SPLICE_PARTICIPANT_ID ||
    "slay-money-validator::1220fa07a73d7a0c7df66161449570e987738485ffb03a6d320d831a5d72b355efc5";
  return pid.startsWith("PAR::") ? pid : `PAR::${pid}`;
}

type BuyArg = {
  inputs: Array<{ tag: "InputAmulet"; value: string }>;
  context: {
    openMiningRound: string;
    issuingMiningRounds: [];
    validatorRights: [];
    featuredAppRight: string | null;
  };
  provider: string;
  memberId: string;
  synchronizerId: string;
  // Daml Int is serialized as a STRING over the JSON Ledger API.
  migrationId: string;
  trafficAmount: string;
  expectedDso: string;
};

export type BuyTrafficResult = {
  ok: boolean;
  trafficBytes: number;
  amuletPaid?: number;
  inputAmuletCc?: number;
  updateId: string | null;
  error?: string;
};

/**
 * Buy `trafficBytes` of extra sequencer traffic for our participant.
 * Picks a single operator amulet large enough to cover the estimated
 * cost + fees (the choice returns change), then exercises the buy.
 * Fails cleanly (no burn) if no covering amulet is found or the choice
 * rejects — safe to retry.
 */
export async function buyMemberTraffic(
  env: Env,
  trafficBytes: number,
  opts: { estimatedCostCc?: number; dryRun?: boolean; memberId?: string } = {}
): Promise<BuyTrafficResult & { arg?: unknown }> {
  const bytes = Math.floor(trafficBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, trafficBytes: bytes, updateId: null, error: "trafficBytes must be positive" };
  }
  const operator = operatorParty(env);
  // MainNet global-domain migration id is 4 (the `-m 4` start flag). Parse the
  // env defensively — a non-numeric value must not become "NaN" in the arg.
  const parsedMig = Number(env.SPLICE_MIGRATION_ID);
  const migrationId = Number.isFinite(parsedMig) && parsedMig >= 0 ? parsedMig : 4;
  const rawMember = (opts.memberId ?? "").trim();
  const memberIdArg = rawMember
    ? rawMember.startsWith("PAR::")
      ? rawMember
      : `PAR::${rawMember}`
    : participantMemberId(env);

  // Cost estimate only picks a covering input; the choice computes the exact
  // burn and returns change. MainNet is ~600-900 CC/MB — pad generously.
  const estCostCc = opts.estimatedCostCc ?? Math.max(50, (bytes / 1_000_000) * 1000);
  const amuletRulesInfo = await getAmuletRulesDisclosed(env);
  const rounds = await getOpenAndIssuingRoundsDisclosed(env);
  const disclosed: DisclosedContract[] = [amuletRulesInfo.disclosed, rounds.openMiningRound];
  const [pkg, mod, ent] = amuletRulesInfo.disclosed.templateId.split(":");

  // Retry loop: the operator's amulet cache can hold a cid that was just
  // consumed by another op (e.g. a treasury payout), causing CONTRACT_NOT_FOUND.
  // On that error, invalidate + re-discover the current largest coin and retry.
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await invalidateCachedOperatorAmulet(env).catch(() => {});
    const amulet = await findOperatorAmulet(env, estCostCc);
    if (!amulet) {
      return {
        ok: false,
        trafficBytes: bytes,
        updateId: null,
        error: `no single operator amulet covers ~${estCostCc.toFixed(0)} CC (merge holdings or lower the buy)`,
      };
    }

    const arg: BuyArg = {
      inputs: [{ tag: "InputAmulet", value: amulet.contractId }],
      context: {
        openMiningRound: rounds.openMiningRound.contractId,
        issuingMiningRounds: [],
        validatorRights: [],
        featuredAppRight: null,
      },
      provider: operator,
      // Which member RECEIVES the traffic. Defaults to our own participant;
      // pass it to top up the second validator, whose participant sits on the
      // same global synchronizer but has no operator amulet of its own to pay
      // with — the burn is ours either way, only the grantee differs.
      memberId: memberIdArg,
      synchronizerId: synchronizerId(env),
      migrationId: String(migrationId),
      trafficAmount: String(bytes),
      expectedDso: amuletRulesInfo.dsoParty,
    };

    if (opts.dryRun) {
      return { ok: true, trafficBytes: bytes, inputAmuletCc: amulet.amount, updateId: null, arg };
    }

    try {
      const result = await exercise<BuyArg, { amuletPaid?: string }>(
        env,
        [operator],
        { packageId: pkg, moduleName: mod, entityName: ent },
        amuletRulesInfo.disclosed.contractId,
        "AmuletRules_BuyMemberTraffic",
        arg,
        { disclosedContracts: disclosed }
      );
      // Consumed the input + made change — drop the cache for the next caller.
      await invalidateCachedOperatorAmulet(env).catch(() => {});
      const paid = Number(result.exerciseResult?.amuletPaid);
      return {
        ok: true,
        trafficBytes: bytes,
        amuletPaid: Number.isFinite(paid) ? paid : undefined,
        inputAmuletCc: amulet.amount,
        updateId: result.updateId ?? null,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // Stale amulet → invalidate + retry with a freshly discovered coin.
      if (lastErr.includes("CONTRACT_NOT_FOUND")) {
        await invalidateCachedOperatorAmulet(env).catch(() => {});
        continue;
      }
      throw e; // other failures (no wallet, insufficient, etc.) propagate
    }
  }
  return {
    ok: false,
    trafficBytes: bytes,
    updateId: null,
    error: `buy failed after retries (stale amulet): ${lastErr.slice(0, 200)}`,
  };
}
