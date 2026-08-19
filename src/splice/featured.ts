import type { Env } from "../env";
import type { DisclosedContract } from "../canton/ledger";

type Entry = { value: FeaturedAppRight | null; at: number };
const cache = new Map<string, Entry>();
const TTL_MS = 10 * 60 * 1000;

export type FeaturedAppRight = {
  contractId: string;
  provider: string;
  disclosed: DisclosedContract;
};

export function isFeaturedRewardsEnabled(env: Env): boolean {
  const v = (env.FEATURED_APP_REWARDS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type FeaturedBundle = { cid: string; provider: string; blob: string | null };

export function walletFeatured(env: Env): FeaturedBundle | null {
  if (!isFeaturedRewardsEnabled(env) || !env.SLAY_WALLET_FEATURED_RIGHT_CID || !env.SPLICE_VALIDATOR_PARTY_ID) return null;
  return { cid: env.SLAY_WALLET_FEATURED_RIGHT_CID, provider: env.SPLICE_VALIDATOR_PARTY_ID, blob: null };
}

export function predictionFeatured(env: Env): FeaturedBundle | null {
  if (
    !isFeaturedRewardsEnabled(env) ||
    !env.SLAY_PREDICTION_FEATURED_RIGHT_CID ||
    !env.SLAY_PREDICTION_PARTY ||
    !env.SLAY_PREDICTION_FEATURED_RIGHT_BLOB
  )
    return null;
  return {
    cid: env.SLAY_PREDICTION_FEATURED_RIGHT_CID,
    provider: env.SLAY_PREDICTION_PARTY,
    blob: env.SLAY_PREDICTION_FEATURED_RIGHT_BLOB,
  };
}

/** v2 FeaturedAppRight bundle for marking on-chain PmBet/escrow activity on the
 *  v2 participant. The right is held by the v2 validator party (slaymoney-
 *  validator-2), so the provider here is SLAY_V2_VALIDATOR_PARTY — NOT the
 *  prediction party. Same cid/blob env as the v1 prediction bundle. */
export function predictionFeaturedV2(env: Env): FeaturedBundle | null {
  // Dedicated v2 FA env (distinct from v1's SLAY_PREDICTION_* so it can't clobber
  // the v1 marker config). Provider = the v2 validator party that holds the right.
  if (
    !isFeaturedRewardsEnabled(env) ||
    !env.SLAY_V2_FEATURED_RIGHT_CID ||
    !env.SLAY_V2_VALIDATOR_PARTY ||
    !env.SLAY_V2_FEATURED_RIGHT_BLOB
  )
    return null;
  return {
    cid: env.SLAY_V2_FEATURED_RIGHT_CID,
    provider: env.SLAY_V2_VALIDATOR_PARTY,
    blob: env.SLAY_V2_FEATURED_RIGHT_BLOB,
  };
}

export function invalidateFeaturedAppRight(providerParty: string): void {
  cache.delete(providerParty);
}

export async function getFeaturedAppRight(
  env: Env,
  providerParty: string
): Promise<FeaturedAppRight | null> {
  const now = Date.now();
  const hit = cache.get(providerParty);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const value = await discoverViaLedger(env, providerParty);
  cache.set(providerParty, { value, at: now });
  return value;
}

async function discoverViaLedger(
  env: Env,
  providerParty: string
): Promise<FeaturedAppRight | null> {
  const ledgerHost = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!ledgerHost || !token) return null;
  const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" };

  const endRes = await fetch(`${ledgerHost}/v2/state/ledger-end`, { headers: auth });
  if (!endRes.ok) return null;
  const offset = Number(((await endRes.json()) as { offset?: string }).offset);
  if (!Number.isFinite(offset)) return null;

  const r = await fetch(`${ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      activeAtOffset: offset,
      verbose: false,
      filter: {
        filtersByParty: {
          [providerParty]: {
            cumulative: [{ WildcardFilter: { value: { includeCreatedEventBlob: true } } }],
          },
        },
      },
    }),
  });
  if (!r.ok) return null;
  let body: any = [];
  try {
    body = await r.json();
  } catch {
    return null;
  }
  for (const rec of Array.isArray(body) ? body : []) {
    const ce = rec?.contractEntry?.JsActiveContract?.createdEvent ?? rec?.createdEvent;
    if (!ce?.templateId || !/:Splice\.Amulet:FeaturedAppRight$/.test(ce.templateId)) continue;
    if (ce.createArgument?.provider !== providerParty) continue;
    return {
      contractId: ce.contractId,
      provider: providerParty,
      disclosed: {
        templateId: ce.templateId,
        contractId: ce.contractId,
        createdEventBlob: ce.createdEventBlob ?? "",
        synchronizerId: rec?.contractEntry?.JsActiveContract?.synchronizerId ?? ce.synchronizerId ?? "",
      },
    };
  }
  return null;
}
