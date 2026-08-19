/**
 * HECTO Token Standard registry client.
 *
 * Endpoint pattern:
 *
 *   GET {HECTO_REGISTRY_URL}/api/token-standard/v0/registrars/{admin}/registry/metadata/v1/instruments
 *
 * Returns metadata for every instrument the admin party governs. For the
 * onrails HECTO admin party that's just HECTO today.
 *
 * No auth needed — registry data is public. We just need the registry
 * URL + admin party id from env.
 *
 * Drift safety — instrument metadata can change (DAR upgrades, MainNet
 * topology migrations, infrastructure rotations) and there's no push
 * notification. Three guarantees we make here:
 *
 *   1. NEVER hardcode the resolved admin / id / package — callers must
 *      use the returned InstrumentMetadata, never the env vars directly.
 *      The env values are HINTS used to query the right registrar.
 *   2. On every successful refresh, compare against the prior cached
 *      value and warn-log any field that changed. Operators will see
 *      `[hecto.registry] DRIFT` lines in their tail when a DAR upgrade
 *      lands.
 *   3. If a refresh fetch fails (network blip, registry 5xx), serve the
 *      LAST-KNOWN-GOOD cached value instead of throwing — same pattern
 *      we use for AmuletRules. A wholesale registry outage shouldn't
 *      take down our HECTO paths if we have a recent value to keep
 *      going on.
 *
 * Process-local cache with a 10 min TTL. On Workers each cold start
 * re-fetches naturally, which gives us "always fetch fresh on startup"
 * behaviour for free.
 */

import type { Env } from "../env";
import type { InstrumentMetadata } from "./types";

type RegistryInstrumentsResponse = {
  instruments?: Array<{
    // The registry may return the instrument id as a top-level `id`
    // field, NOT nested under `instrument_id`. We accept BOTH so the
    // code survives whichever shape the registry decides to ship.
    id?: string;
    instrument_id?: { admin?: string; id?: string };
    name?: string;
    symbol?: string;
    decimals?: number;
    package_id?: string;
    [key: string]: unknown;
  }>;
};

/* ────────── Cache ────────── */

const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Stale-fallback ceiling: how long we'll keep serving a cached value
 * when the registry is unreachable. 24 h matches the upper bound of
 * "DAR upgrades happen on weekly-ish cadence" — past this we'd rather
 * fail loud than silently serve something stale enough that an
 * intervening upgrade could have invalidated.
 */
const STALE_FALLBACK_MAX_MS = 24 * 60 * 60 * 1000;
type CacheEntry = {
  value: InstrumentMetadata;
  cachedAt: number;
  /** Last time we successfully refreshed (== cachedAt unless we're
   *  currently serving a stale value). */
  lastFreshAt: number;
};
let cache: CacheEntry | null = null;

export function invalidateRegistryCache(): void {
  cache = null;
}

/** Compact signature for change-detection — admin + id + package id. */
function metaSignature(m: InstrumentMetadata): string {
  return `${m.instrumentId.admin}|${m.instrumentId.id}|${m.packageId ?? "?"}`;
}

/* ────────── Public API ────────── */

export class HectoConfigError extends Error {}

function requireEnv(env: Env): {
  registryUrl: string;
  adminParty: string;
  instrumentId: string;
} {
  if (!env.HECTO_REGISTRY_URL) {
    throw new HectoConfigError(
      "HECTO_REGISTRY_URL not set. Add the registry URL to env (MainNet: https://api.utilities.digitalasset.com)."
    );
  }
  if (!env.HECTO_ADMIN_PARTY) {
    throw new HectoConfigError(
      "HECTO_ADMIN_PARTY not set. Add the onrails HECTO admin party id (MainNet: rails-hectoMain-1::1220…)."
    );
  }
  if (!env.HECTO_INSTRUMENT_ID) {
    throw new HectoConfigError(
      'HECTO_INSTRUMENT_ID not set. For HECTO use the literal string "HECTO".'
    );
  }
  return {
    registryUrl: env.HECTO_REGISTRY_URL.replace(/\/$/, ""),
    adminParty: env.HECTO_ADMIN_PARTY,
    instrumentId: env.HECTO_INSTRUMENT_ID,
  };
}

/**
 * Fetch and cache HECTO instrument metadata from the registry.
 *
 * Fallback ladder when the registry is unreachable / returns garbage:
 *
 *   1. Fresh fetch (happy path) — within CACHE_TTL_MS just returns cache
 *   2. Cached value if fetch failed AND cache is < STALE_FALLBACK_MAX_MS
 *      old — registry hiccup shouldn't take down transfers
 *   3. Throw — we have nothing to serve and the upstream is dead. Caller
 *      surfaces a clear 503-ish error to the user.
 *
 * On a successful refresh that changes the instrument signature
 * (admin / id / package id), logs a `DRIFT` warning so the next time
 * the issuer rotates we see it in tail rather than discovering via
 * transfer failures.
 */
export async function getHectoInstrument(env: Env): Promise<InstrumentMetadata> {
  const now = Date.now();
  if (cache && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  const { registryUrl, adminParty, instrumentId } = requireEnv(env);
  const url = `${registryUrl}/api/token-standard/v0/registrars/${encodeURIComponent(adminParty)}/registry/metadata/v1/instruments`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (err) {
    // Network-level fail (DNS, abort, TLS). Fall through to stale.
    return serveStaleOrThrow(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    return serveStaleOrThrow(
      `HECTO registry returned ${res.status} for ${url}`
    );
  }

  let body: RegistryInstrumentsResponse;
  try {
    body = (await res.json()) as RegistryInstrumentsResponse;
  } catch (err) {
    return serveStaleOrThrow(
      `HECTO registry returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const list = body.instruments ?? [];
  // Match by id. Accept BOTH the doc-advertised nested shape
  // (`instrument_id.id`) AND the actual MainNet shape (`id` at top
  // level). Whichever matches first wins.
  const hit = list.find(
    (i) =>
      i.id === instrumentId || i.instrument_id?.id === instrumentId
  );
  if (!hit) {
    return serveStaleOrThrow(
      `Registry returned ${list.length} instruments but none matched id=${instrumentId} under admin=${adminParty}.`
    );
  }

  // The admin field isn't returned in the top-level shape — it's
  // implicit from the URL path. Trust the env hint as the admin if
  // the response doesn't carry one. Drift detection catches a real
  // rotation by way of next-poll comparison.
  const resolvedId = hit.id ?? hit.instrument_id?.id ?? instrumentId;
  const resolvedAdmin = hit.instrument_id?.admin ?? adminParty;

  const meta: InstrumentMetadata = {
    instrumentId: {
      admin: resolvedAdmin,
      id: resolvedId,
    },
    name: hit.name,
    symbol: hit.symbol,
    // HECTO ships with decimals=10. Use whatever the registry says; if
    // absent default to 8 (matches the older docs assumption).
    decimals: hit.decimals ?? 8,
    packageId: hit.package_id,
    extra: Object.fromEntries(
      Object.entries(hit).filter(
        ([k]) =>
          ![
            "id",
            "instrument_id",
            "name",
            "symbol",
            "decimals",
            "package_id",
          ].includes(k)
      )
    ),
  };

  // ── Drift warning — alert ops when ID or package id moved ────────
  if (cache) {
    const before = metaSignature(cache.value);
    const after = metaSignature(meta);
    if (before !== after) {
      console.warn(
        `[hecto.registry] DRIFT — instrument signature changed.\n  before: ${before}\n  after:  ${after}\n  (Most likely a DAR upgrade. Verify env HECTO_ADMIN_PARTY is still correct.)`
      );
    }
    if (meta.instrumentId.admin !== adminParty) {
      console.warn(
        `[hecto.registry] ADMIN MISMATCH — env HECTO_ADMIN_PARTY=${adminParty.slice(0, 32)}… but registry returned ${meta.instrumentId.admin.slice(0, 32)}…. Update the env var when convenient; transfers will use the resolved value.`
      );
    }
  }

  cache = { value: meta, cachedAt: now, lastFreshAt: now };
  if (env.SPLICE_DEBUG === "1") {
    console.log(
      `[hecto.registry] cached metadata — symbol=${meta.symbol ?? "?"} decimals=${meta.decimals} package=${meta.packageId?.slice(0, 24)}…`
    );
  }
  return meta;
}

/* ────────── Active holdings lookup ────────── *
 *  The Token Standard exposes an active-holdings query per owner party.  *
 *  We use this instead of our participant's /v2/state/active-contracts   *
 *  because Canton 3.5.1's JSON v2 API hardcodes a 200-element response   *
 *  cap and the operator party crosses that ceiling easily. The registry  *
 *  has its OWN indexer that returns ONLY HECTO contracts by definition —  *
 *  no ValidatorRights, no Amulets, no noise. No cap.                     *
 * ──────────────────────────────────────────────────────────────────── */

export type RegistryHolding = {
  /** Daml contract id of the Utility.Registry.Holding:Holding contract. */
  contractId: string;
  /** Owner party id — matches the request, surfaced for symmetry. */
  owner: string;
  /** Holding amount as a decimal string (raw token units, e.g. "0.0000010000"). */
  amount: string;
  /** Whether the holding is currently locked (allocated to a pending xfer). */
  locked: boolean;
  /** Raw entry — kept for callers that want fields we haven't surfaced. */
  raw: Record<string, unknown>;
};

type RegistryHoldingsResponse = {
  /** Standard envelope is `holdings[]`. Accept a few field-name variants
   *  for resilience. */
  holdings?: Array<Record<string, unknown>>;
  active_holdings?: Array<Record<string, unknown>>;
  result?: Array<Record<string, unknown>>;
};

/**
 * Fetch active HECTO holdings owned by a specific party, via the
 * registry holdings endpoint. Bypasses the participant's 200-element
 * cap entirely — the registry returns ALL of the party's HECTO holdings
 * regardless of count, since it's a token-scoped index.
 *
 * Optional `instrumentIdOverride` lets callers force a specific
 * instrument; default uses the env's HECTO_INSTRUMENT_ID.
 *
 * Throws if the registry is unreachable AND we have no fallback —
 * unlike the metadata path we can't safely serve stale holdings (they
 * change every transfer). If you need resilience here, retry at the
 * caller level rather than trusting cached state.
 */
export async function getActiveHoldings(
  env: Env,
  ownerParty: string,
  instrumentIdOverride?: string
): Promise<RegistryHolding[]> {
  const { registryUrl, adminParty, instrumentId } = requireEnv(env);
  const resolvedInstrumentId = instrumentIdOverride ?? instrumentId;

  const url =
    `${registryUrl}/api/token-standard/v0/registrars/` +
    `${encodeURIComponent(adminParty)}/registry/holdings/v1/active-holdings`;

  // Token Standard holdings query body. Field names match the OpenAPI
  // spec — owner_party_id / instrument_id (snake_case).
  const body = {
    owner_party_id: ownerParty,
    instrument_id: resolvedInstrumentId,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `HECTO registry holdings query network error (${url}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "<read failed>");
    throw new Error(
      `HECTO registry holdings query ${res.status} from ${url}: ${errBody.slice(0, 500)}`
    );
  }

  const raw = (await res.json()) as RegistryHoldingsResponse;
  const list =
    raw.holdings ?? raw.active_holdings ?? raw.result ?? [];

  // Normalize each entry into our flat RegistryHolding shape. The
  // exact field names vary between implementations (camelCase vs
  // snake_case, nested vs top-level). We try a few.
  return list.map((entry): RegistryHolding => {
    const contractId =
      (entry.contract_id as string) ??
      (entry.contractId as string) ??
      ((entry.contract as Record<string, unknown>)?.contract_id as string) ??
      "";
    const owner =
      (entry.owner as string) ??
      (entry.owner_party_id as string) ??
      ownerParty;
    const amount =
      (entry.amount as string) ??
      ((entry.payload as Record<string, unknown>)?.amount as string) ??
      "0";
    const locked =
      (entry.locked as boolean | undefined) ?? entry.lock != null;
    return { contractId, owner, amount, locked, raw: entry };
  });
}

/**
 * Last-resort: serve the cached value if we have a recent one, else
 * throw with a descriptive message. Also bumps cachedAt so we don't
 * hammer the registry on every request during an outage — we'll wait
 * out another TTL window before retrying.
 */
function serveStaleOrThrow(reason: string): InstrumentMetadata {
  const now = Date.now();
  if (cache && now - cache.lastFreshAt < STALE_FALLBACK_MAX_MS) {
    console.warn(
      `[hecto.registry] STALE — serving cached metadata (lastFreshAt=${new Date(cache.lastFreshAt).toISOString()}). reason=${reason}`
    );
    // Refresh cachedAt to back off — but keep lastFreshAt anchored so
    // we know how stale we really are.
    cache = { ...cache, cachedAt: now };
    return cache.value;
  }
  throw new HectoConfigError(reason);
}
