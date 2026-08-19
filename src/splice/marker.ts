import type { Env } from "../env";
import { exercise } from "../canton/ledger";
import { createDb } from "../db";
import { sql } from "drizzle-orm";
import { isFeaturedRewardsEnabled, predictionFeaturedV2, type FeaturedBundle } from "./featured";

// V2 interface: the FeaturedAppRight_CreateActivityMarker choice here takes a
// top-level `weight` (Optional Decimal, >=1.0) that multiplies the marker's
// reward — beneficiary weights still sum to 1.0. This lets ONE marker carry
// weight N (like grofty), vs V1 where every marker is fixed weight 1.0.
const FEATURED_APP_IFACE = {
  packageId: "#splice-api-featured-app-v2",
  moduleName: "Splice.Api.FeaturedAppRightV2",
  entityName: "FeaturedAppRight",
};

/**
 * Fair-use weight for a marker covering `burnKb` of traffic.
 *
 * The CIP fair-use ceiling is reward ≤ 1.15× burn. Reward per unit weight is the
 * current network Marker Value, so the compliant weight for a given burn is
 *   weight = factor × (burnKb × trafficPrice) / markerValue
 * with `factor` kept ≤ 1.15 (default 1.1 leaves a safety buffer under the cap).
 * A flat weight of 1 under-captures whenever the marker value falls below the
 * per-transaction burn (which it has — CC price dropped), so tying weight to
 * burn keeps us at the compliant maximum as prices move. Always ≥ 1. Every
 * input is env-tunable, so the real per-tx burn / price can be dialed in live.
 */
export function markerWeightForBurn(env: Env, burnKb: number): number {
  const trafficPrice = Number(env.TRAFFIC_PRICE_USD_PER_KB ?? "0.062");
  // COMPLIANCE COUNTS EACH MARKER AS ONE FIXED $1 UNIT (featuredAppActivity-
  // MarkerAmount = MARKER_VALUE_USD), not its fluctuating live payout. ccview's
  // ratio is literally markers ÷ traffic$ (verified: Cantex 57.05K ÷ $50,176.92
  // = 113.69%). So the weight divisor is the fixed $1 unit; the live per-round
  // marker VALUE ($0.48–$1.50) is earnings-only and must NEVER enter this calc,
  // or a low payout would inflate weight past the 1.15× cap.
  const markerValue = Number(env.MARKER_VALUE_USD ?? "1.0") || 1.0;
  const factorRaw = Number(env.MARKER_FAIRUSE_FACTOR ?? "1.1");
  // Never exceed the hard 1.15× fair-use ceiling, whatever the env says.
  const factor = Math.min(1.15, factorRaw);
  if (!(burnKb > 0) || !(trafficPrice > 0) || !(factor > 0)) {
    return 1;
  }
  const burnUsd = burnKb * trafficPrice;
  // FRACTIONAL on purpose: the ratio (markers/burn) equals `factor`, but only if
  // we DON'T floor per-transfer (floor(1.05×1.24)=1 collapses the ratio to
  // 1/1.24=80%). Weight accrues fractionally into the 'pending' meter (micro-
  // weight) and is floored only once at the batched flush, where the <1 loss is
  // negligible. Result: steady-state markers/burn ≈ factor (capped ≤1.15).
  return (factor * burnUsd) / markerValue;
}

/** Burn-tied weight for one standard token transfer (two-phase offer+accept). */
export function tokenMarkerWeight(env: Env): number {
  const kb = Number(env.TOKEN_TRANSFER_BURN_KB ?? "15");
  return markerWeightForBurn(env, kb);
}

/**
 * Live network Marker Value (USD per unit weight) = the latest issuing round's
 * `issuancePerFeaturedAppRewardCoupon` — the exact number ccview shows as
 * "Marker Value". It swings every ~10-min round ($0.48 → $1.50 cap), so we read
 * it live from our own validator's scan-proxy and cache it for one round.
 *
 * Returns null — never a fallback — when the value could not be obtained, so
 * callers that report provenance (e.g. /api/stats `sources.markerValue`) can
 * tell "live from chain" apart from "stamped constant". Money-path callers
 * should use `fetchLiveMarkerValueUsd()` below, which layers the env fallback
 * on top so marker filing never hard-depends on scan-proxy being reachable.
 *
 * A KV hit counts as live: it is a chain read from at most one round ago.
 */
export async function fetchLiveMarkerValueUsdOrNull(env: Env): Promise<number | null> {
  const kv = env.M2M_TOKEN_CACHE;
  const KEY = "live_marker_value_usd";
  if (kv) {
    const cached = await kv.get(KEY).catch(() => null);
    if (cached) {
      const n = Number(cached);
      if (n > 0) return n;
    }
  }
  try {
    const { spliceGet } = await import("./client");
    const r = (await spliceGet(
      env,
      "/api/validator/v0/scan-proxy/open-and-issuing-mining-rounds"
    )) as {
      issuing_mining_rounds?: Array<{
        contract?: { payload?: { round?: { number?: string }; issuancePerFeaturedAppRewardCoupon?: string } };
      }>;
    };
    let best: { n: number; v: number } | null = null;
    for (const w of r.issuing_mining_rounds ?? []) {
      const p = w.contract?.payload;
      const rn = Number(p?.round?.number ?? NaN);
      const v = Number(p?.issuancePerFeaturedAppRewardCoupon ?? NaN);
      if (Number.isFinite(rn) && v > 0 && (!best || rn > best.n)) best = { n: rn, v };
    }
    if (best) {
      if (kv) await kv.put(KEY, String(best.v), { expirationTtl: 600 }).catch(() => {});
      return best.v;
    }
  } catch {
    /* scan-proxy unreachable → caller decides what to do with null */
  }
  return null;
}

/**
 * Live network Marker Value, falling back to MARKER_VALUE_USD (or 1.0) on any
 * error so marker filing never hard-depends on scan-proxy being reachable.
 * Behaviour is unchanged from before `fetchLiveMarkerValueUsdOrNull` existed:
 * this is exactly that read with the env fallback applied.
 */
export async function fetchLiveMarkerValueUsd(env: Env): Promise<number> {
  const fallback = Number(env.MARKER_VALUE_USD ?? "1.0") || 1.0;
  const live = await fetchLiveMarkerValueUsdOrNull(env);
  return live ?? fallback;
}

/**
 * File ONE activity marker carrying `weight` (>=1). Single on-chain tx — the V2
 * `weight` field makes it worth `weight` unit-markers of reward at 1/N the
 * marker traffic.
 */
export async function fileActivityMarkers(
  env: Env,
  featured: FeaturedBundle,
  weight = 1,
  exerciseOpts: { target?: "v2"; subOverride?: string } = {}
): Promise<{ updateId: string | null; weight: number }> {
  const w = Math.max(1, Math.floor(weight));
  const arg = {
    beneficiaries: [{ beneficiary: featured.provider, weight: "1.0" }],
    weight: w.toFixed(1),
  };
  const r = await exercise(
    env,
    [featured.provider],
    FEATURED_APP_IFACE,
    featured.cid,
    "FeaturedAppRight_CreateActivityMarker",
    arg,
    exerciseOpts
  );
  return { updateId: r.updateId ?? null, weight: w };
}

/** File a marker for on-chain activity on the v2 participant (PmBet create,
 *  escrow accept, settle), using the v2 validator's FeaturedAppRight so v2 earns
 *  app rewards that offset its traffic burn. Best-effort; no-op if v2 FA unset.
 *  Filed directly (v2 activity is low-volume) rather than metered like v1. */
/**
 * v2 marker — ACCRUES weight into a separate 'pending_v2' meter instead of
 * filing a marker per call. A periodic flushMarkersV2() (on the cron, every
 * MARKER_FLUSH_MINUTES) then files ONE weighted marker for all accrued v2
 * weight — matching v1's batching (far fewer marker txs = less v2 traffic burn,
 * same total reward weight). One round ≈ one marker instead of one per bet.
 */
export async function fileV2ActivityMarker(env: Env, activities = 1): Promise<void> {
  if (!predictionFeaturedV2(env) || activities <= 0) return;
  // COMPLIANCE: weight is burn-PROPORTIONAL (like v1), not a flat 1. Each on-
  // chain v2 activity (Slay.Market create / PmBet) burns ~V2_ACTIVITY_BURN_KB of
  // traffic; the marker weight for that burn is markerWeightForBurn (= 1.05× the
  // burn value), and we track the burn on the 'global_v2' meter so flushMarkersV2
  // can enforce the hard 1.15× cap. A CONSERVATIVE burn estimate (default 8 KB,
  // below a real create) keeps the ratio safely under the ceiling.
  const burnKb = Number(env.V2_ACTIVITY_BURN_KB ?? "8") * activities;
  const price = Number(env.TRAFFIC_PRICE_USD_PER_KB ?? "0.062");
  const weight = markerWeightForBurn(env, burnKb);
  const weightMicro = Math.round(weight * 1_000_000);
  const burnMicroUsd = Math.round(burnKb * price * 1_000_000);
  if (weightMicro <= 0) return;
  const db = createDb(env.DATABASE_URL);
  await db
    .execute(sql`INSERT INTO marker_meter (id, markers_filed, updated_at) VALUES ('pending_v2', ${weightMicro}, now())
      ON CONFLICT (id) DO UPDATE SET markers_filed = marker_meter.markers_filed + ${weightMicro}, updated_at = now()`)
    .catch(() => {});
  await db
    .execute(sql`INSERT INTO marker_meter (id, markers_filed, burn_micro_usd, updated_at) VALUES ('global_v2', 0, ${burnMicroUsd}, now())
      ON CONFLICT (id) DO UPDATE SET burn_micro_usd = marker_meter.burn_micro_usd + ${burnMicroUsd}, updated_at = now()`)
    .catch(() => {});
}

/** Flush all accrued v2 weight as ONE weighted marker on v2. Called on the cron
 *  every MARKER_FLUSH_MINUTES (mirrors v1's flushMarkers). */
export async function flushMarkersV2(env: Env): Promise<number> {
  const featured = predictionFeaturedV2(env);
  if (!featured) return 0;
  const db = createDb(env.DATABASE_URL);
  const p = (await db.execute(
    sql`SELECT markers_filed FROM marker_meter WHERE id = 'pending_v2'`
  )) as { rows?: Array<{ markers_filed: number }> };
  const pendingMicro = Number(p.rows?.[0]?.markers_filed ?? 0);
  // Same per-flush ceiling as v1 (compliance control) — no single flush can
  // concentrate markers into one round.
  const perFlushMax = Math.max(1, Math.floor(Number(env.MARKER_MAX_PER_FLUSH ?? "150")) || 150);
  const want = Math.min(Math.floor(pendingMicro / 1_000_000), perFlushMax);
  if (want < 1) return 0;
  // HARD 1.15× cap against v2's OWN tracked burn — v2 markers filed can never
  // exceed 1.15 × v2 traffic burn (the CIP fair-use ceiling), independent of v1.
  const g = (await db.execute(
    sql`SELECT markers_filed, burn_micro_usd FROM marker_meter WHERE id = 'global_v2'`
  )) as { rows?: Array<{ markers_filed: number; burn_micro_usd: number }> };
  const filedV2 = Number(g.rows?.[0]?.markers_filed ?? 0);
  const burnV2Usd = Number(g.rows?.[0]?.burn_micro_usd ?? 0) / 1_000_000;
  const cap = Math.floor(1.15 * burnV2Usd);
  const grant = Math.min(want, Math.max(0, cap - filedV2));
  if (grant < 1) return 0;
  try {
    await fileActivityMarkers(env, featured, grant, { target: "v2", subOverride: "participant_admin" });
    await db.execute(sql`UPDATE marker_meter SET markers_filed = markers_filed + ${grant}, updated_at = now() WHERE id = 'global_v2'`).catch(() => {});
    await db.execute(sql`UPDATE marker_meter SET markers_filed = GREATEST(markers_filed - ${grant * 1_000_000}, 0), updated_at = now() WHERE id = 'pending_v2'`).catch(() => {});
    return grant;
  } catch (e) {
    console.error("[marker.v2] flush failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/**
 * Accrue `weight` into the pending counter instead of filing a marker now.
 * A periodic flush then files ONE weighted marker for all accrued weight — far
 * fewer marker transactions (less traffic burn) for the same total reward weight.
 */
export async function accrueMarker(env: Env, weight = 1): Promise<void> {
  if (!isFeaturedRewardsEnabled(env) || weight <= 0) return;
  // The 'pending' row stores MICRO-weight (weight × 1e6) so fractional per-
  // transfer weight (e.g. 1.302) accumulates exactly; flushMarkers floors to a
  // whole on-chain marker and keeps the sub-unit remainder.
  const micro = Math.round(weight * 1_000_000);
  if (micro <= 0) return;
  const db = createDb(env.DATABASE_URL);
  await db
    .execute(sql`
      INSERT INTO marker_meter (id, markers_filed, updated_at)
      VALUES ('pending', ${micro}, now())
      ON CONFLICT (id) DO UPDATE
        SET markers_filed = marker_meter.markers_filed + ${micro}, updated_at = now()
    `)
    .catch(() => {});
}

/**
 * File ONE marker carrying all pending accrued weight (metered against the 1.15×
 * cap on the 'global' row). Decrements pending by whatever was actually filed.
 */
export async function flushMarkers(
  env: Env,
  featured: FeaturedBundle | null
): Promise<number> {
  if (!featured || !isFeaturedRewardsEnabled(env)) return 0;
  const db = createDb(env.DATABASE_URL);
  const r = (await db.execute(
    sql`SELECT markers_filed FROM marker_meter WHERE id = 'pending'`
  )) as { rows?: Array<{ markers_filed: number }> };
  // 'pending' is MICRO-weight; convert to whole on-chain weight to file.
  const pendingMicro = Number(r.rows?.[0]?.markers_filed ?? 0);
  if (pendingMicro <= 0) return 0;
  const wholeCount = Math.floor(pendingMicro / 1_000_000);
  if (wholeCount < 1) return 0;
  // COMPLIANCE CONTROL (2026-08-17 incident): a single flush can file at most
  // MARKER_MAX_PER_FLUSH weight, so accrued weight can NEVER be concentrated
  // into one round — any excess stays in `pending` and drains over subsequent
  // flush windows, matched to real burn. Steady per-transfer accrual is ~1.3
  // weight/tx (a few per flush), so this ceiling is never hit in normal
  // operation; it only caps a runaway batch (e.g. a mistaken top-up).
  const perFlushMax = Math.max(1, Math.floor(Number(env.MARKER_MAX_PER_FLUSH ?? "150")) || 150);
  const fileCount = Math.min(wholeCount, perFlushMax);
  // File ONE weighted marker for this flush's capped amount, metered against
  // the 1.15× cap. Partial-fills if near the cap. Decrement pending by exactly
  // what was filed (× 1e6), keeping the remainder for the next window.
  const filed = await maybeFileMarker(env, featured, fileCount).catch(() => 0);
  if (filed > 0) {
    await db
      .execute(sql`UPDATE marker_meter SET markers_filed = GREATEST(markers_filed - ${filed * 1_000_000}, 0), updated_at = now() WHERE id = 'pending'`)
      .catch(() => {});
  }
  return filed;
}

/** USD of traffic burned by one standard token transfer (offer+accept). */
export function perTransferBurnUsd(env: Env): number {
  const kb = Number(env.TOKEN_TRANSFER_BURN_KB ?? "20");
  const price = Number(env.TRAFFIC_PRICE_USD_PER_KB ?? "0.062");
  return kb > 0 && price > 0 ? kb * price : 0;
}

/**
 * File a single weighted marker, reserving up to `weight` units from the global
 * marker_meter cap (partial fill near the cap). Returns the weight actually
 * filed (0 if disabled, capped, or the chain call failed). The meter now counts
 * total weight (≈ $1/unit) so the fair-use cap keeps the same meaning.
 */
export async function maybeFileMarker(
  env: Env,
  featured: FeaturedBundle | null,
  weight = 1
): Promise<number> {
  if (!featured || !isFeaturedRewardsEnabled(env) || weight <= 0) return 0;

  const db = createDb(env.DATABASE_URL);
  const rows = (await db.execute(
    sql`SELECT markers_filed, burn_micro_usd FROM marker_meter WHERE id = 'global'`
  )) as { rows?: Array<{ markers_filed: number; burn_micro_usd: number }> };
  const filed = Number(rows.rows?.[0]?.markers_filed ?? 0);
  // Fair-use cap tracks LIVE cumulative traffic burn (CIP ceiling = 1.15 × burn),
  // not a frozen budget. burn_micro_usd only grows, and each transfer burns more
  // than the marker it earns, so the ceiling always stays ahead of filed and
  // filing never artificially halts. MARKER_BURN_BUDGET_USD is only a bootstrap
  // floor for a fresh meter before any burn is tracked.
  const burnUsd = Number(rows.rows?.[0]?.burn_micro_usd ?? 0) / 1_000_000;
  const bootstrapUsd = Number(env.MARKER_BURN_BUDGET_USD ?? "0");
  const cap = Math.floor(1.15 * Math.max(burnUsd, Number.isFinite(bootstrapUsd) ? bootstrapUsd : 0));
  if (cap <= 0) return 0;
  const remaining = cap - filed;
  if (remaining <= 0) return 0;
  const grant = Math.min(Math.floor(weight), remaining);
  if (grant <= 0) return 0;

  const reserve = await db.execute(sql`
    UPDATE marker_meter
    SET markers_filed = markers_filed + ${grant}, updated_at = now()
    WHERE id = 'global' AND markers_filed + ${grant} <= ${cap}
    RETURNING markers_filed
  `);
  const claimed = Array.isArray((reserve as { rows?: unknown[] }).rows)
    ? (reserve as { rows: unknown[] }).rows.length > 0
    : Array.isArray(reserve) && reserve.length > 0;
  if (!claimed) return 0;

  try {
    await fileActivityMarkers(env, featured, grant);
    // #3: track the real traffic burn these markers were filed against, so
    // marker-status can report the TRUE marker-usage % (filed$ / burn$) that
    // matches ccview — instead of the misleading static-budget number. This is
    // reporting only; enforcement stays on the static cap above + the per-
    // transfer weight formula. Best-effort; never blocks a successful file.
    const perTx = perTransferBurnUsd(env);
    const unit = tokenMarkerWeight(env) || 1;
    const burnMicro = Math.round((grant / unit) * perTx * 1_000_000);
    if (burnMicro > 0) {
      await db
        .execute(sql`UPDATE marker_meter SET burn_micro_usd = burn_micro_usd + ${burnMicro} WHERE id = 'global'`)
        .catch(() => {});
    }
    return grant;
  } catch (e) {
    await db
      .execute(sql`UPDATE marker_meter SET markers_filed = GREATEST(markers_filed - ${grant}, 0) WHERE id = 'global'`)
      .catch(() => {});
    console.warn(
      `[marker] weighted file failed, ${grant} released — ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`
    );
    return 0;
  }
}
