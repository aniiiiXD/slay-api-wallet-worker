/**
 * Integrate — the dashboard for a business whose app connects to Slay
 * wallets over CIP-103.
 *
 * Everything on this page derives from one economic loop (CIP-0047 +
 * Splice tokenomics, read from the primary sources 2026-08):
 *
 *   your app's real transfer
 *     → files a FeaturedAppActivityMarker (split between beneficiaries by
 *       weight — your share mints to YOUR Canton party, Slay never holds it)
 *     → the transfer's bytes consume synchronizer traffic the validator
 *       bought by burning CC at a governance USD/KB price
 *
 *   P/L = markers × marker value × your weight − KB × traffic price − fees
 *
 * Two figures decide an app's P/L, and they are NOT the same kind of thing:
 *
 *   traffic price  — a Super Validator governance parameter.
 *   marker value   — issuancePerFeaturedAppRewardCoupon on the current
 *                    issuing round. It RE-PRICES EVERY ROUND, roughly
 *                    $0.48 to a $1.50 cap. Calling it a governance
 *                    parameter (as this page did) confuses it with
 *                    featuredAppActivityMarkerAmount, the fixed $1 unit the
 *                    fair-use cap is measured in — a different number for a
 *                    different purpose.
 *
 * Both now come live from /api/stats, which carries per-field `sources`.
 * Every figure on this page must quote the same value the tiles show; the
 * P/L line used to print stamped constants underneath live tiles.
 *
 * Per-app rollups still need the source_origin migration. That section says
 * so rather than pretending.
 */

import { useState } from "react";
import {
  ApiError,
  ccPrice,
  integrations,
  networkStats,
  type CcPrice,
  type IntegratorStats,
  type NetworkStats,
} from "../api";
import { ErrorState } from "../components/ErrorState";
import { Notice, Spinner } from "../components/Notice";
import { useAsync } from "../components/useAsync";
import { formatCc, formatUsd, formatUsdFine } from "../format";

import {
  MARKER_VALUE_USD,
  PARAMS_AS_OF,
  ROUND_MINUTES,
  TRAFFIC_USD_PER_KB,
} from "../economics";

export function Integrate() {
  const price = useAsync<CcPrice | null>(() => ccPrice().catch(() => null), [], {
    refreshMs: 60_000,
  });
  // Same endpoint Overview's tiles read — the two pages cannot disagree.
  const net = useAsync<NetworkStats | null>(
    () => networkStats().catch(() => null),
    [],
    { refreshMs: 300_000 }
  );

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Integrate</h1>
          <p className="note">
            What an app connected to Slay wallets earns, burns, and nets —
            priced by the Canton Network itself.
          </p>
        </div>
      </header>

      <EconomicsStrip price={price.data} loading={price.loading} net={net.data} />
      <HowItWorks net={net.data} />
      <HowToConnect />
      <YourApp price={price.data} />
      <ComplianceNote />
    </>
  );
}

/* ── Network economics ─────────────────────────────────────────────── */

function EconomicsStrip({
  price,
  loading,
  net,
}: {
  price: CcPrice | null;
  loading: boolean;
  net: NetworkStats | null;
}) {
  const markerUsd = net?.markerValueUsd ?? MARKER_VALUE_USD;
  const trafficUsd = net?.trafficUsdPerKb ?? TRAFFIC_USD_PER_KB;
  const liveMarker = net?.sources.markerValue === "scan";
  const liveTraffic = net?.sources.trafficPrice === "scan";
  const round = net?.sources.round === "scan" ? net.round : null;
  const gov = net?.sources.round === "scan" ? net.governancePriceUsd : null;
  const asOf = net?.fallbackAsOf ?? PARAMS_AS_OF;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Network economics</h2>
        <span className="eyebrow">
          {liveMarker || liveTraffic
            ? `live from chain${round !== null ? ` · round ${round}` : ""}`
            : `live price · params as of ${asOf}`}
        </span>
      </div>
      <div className="stat-grid">
        <div className="stat">
          <span className="label">CC price (external)</span>
          <span className="stat-val">
            {loading ? "…" : price ? formatUsd(price.usd) : "unavailable"}
          </span>
          {gov !== null ? (
            <span className="label">governance: {formatUsdFine(gov)}</span>
          ) : price?.stale ? (
            <span className="label">stale feed</span>
          ) : null}
        </div>
        <div className="stat">
          <span className="label">Marker value</span>
          <span className="stat-val">{formatUsdFine(markerUsd)}</span>
          <span className="label">
            per marker{liveMarker ? " · live" : ""}
          </span>
        </div>
        <div className="stat">
          <span className="label">Traffic price</span>
          <span className="stat-val">{formatUsdFine(trafficUsd)}</span>
          <span className="label">
            per KB, burned{liveTraffic ? " · live" : ""}
          </span>
        </div>
        <div className="stat">
          <span className="label">Mint cadence</span>
          <span className="stat-val">{ROUND_MINUTES} min</span>
          <span className="label">per mining round</span>
        </div>
      </div>
      <p className="note" style={{ marginTop: 12 }}>
        Traffic price is a Super Validator governance parameter. Marker value
        is not — it is the current round's issuance per featured-app reward
        coupon, which re-prices roughly every ten minutes between $0.48 and a
        $1.50 cap. Both are served by the Worker's <code>/api/stats</code>.{" "}
        {liveMarker || liveTraffic
          ? "Values marked live were read from chain state within the last five minutes."
          : `Scan is unreachable from this Worker right now, so they are pinned constants as of ${asOf}.`}
      </p>
    </section>
  );
}

/* ── The model, stated once ────────────────────────────────────────── */

function HowItWorks({ net }: { net: NetworkStats | null }) {
  /* The formula has to quote the SAME numbers the strip above shows. It used
   * to print the stamped constants while the tiles read live from chain, so
   * the page contradicted itself on the two figures that decide an app's
   * P/L — and the constants were the stale half. */
  const markerUsd = net?.markerValueUsd ?? MARKER_VALUE_USD;
  const trafficKbUsd = net?.trafficUsdPerKb ?? TRAFFIC_USD_PER_KB;
  const isLive = net?.sources.markerValue === "scan";
  return (
    <section className="card">
      <div className="card-head">
        <h2>How your app earns</h2>
        <span className="eyebrow">CIP-0047</span>
      </div>
      <ol className="note" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
        <li>
          Your user moves an asset through your app, signed via their Slay
          wallet (<code>window.slay</code> or the standard wallet picker).
        </li>
        <li>
          Slay files a <b>featured-app activity marker</b> for that real
          transfer, naming your Canton party as a <b>beneficiary</b> with an
          agreed weight.
        </li>
        <li>
          Super Validator automation converts the marker at the round's CC
          price; <b>your share mints directly to your party</b> — it never
          passes through Slay.
        </li>
        <li>
          The transfer's bytes consumed synchronizer traffic — CC burned at
          the traffic price. That is the cost side of your P/L.
        </li>
      </ol>
      <p className="note" style={{ marginTop: 8 }}>
        <b>
          P/L = markers × {formatUsdFine(markerUsd)} × weight − KB ×{" "}
          {formatUsdFine(trafficKbUsd)} − fees
        </b>
      </p>
      <p className="note" style={{ marginTop: 6 }}>
        {isLive
          ? "Marker value re-prices every round, so this is a snapshot: the same transfer earns more in one round than in another."
          : "Marker value is a stamped constant right now, not a live reading — treat this figure as indicative."}
      </p>
    </section>
  );
}

/* ── How to actually connect ───────────────────────────────────────── */

/**
 * The page explained the economics and never said how to integrate, which
 * left a reader knowing what they would earn and not how to earn it.
 *
 * Presented as rows rather than a table: the useful unit is "method + what
 * it costs you + what it does", which reads as a definition list, and a
 * three-column table of eleven rows is a wall a reader scans past.
 *
 * Deliberately blunt about what does NOT work. `ledgerApi` and `signMessage`
 * are declared by the provider and always refuse, so naming `prepareExecute`
 * as the way to move value saves an integrator a dead end.
 */

type Method = {
  name: string;
  scope: string;
  what: string;
  /** Refused by the provider — rendered struck through rather than omitted,
   *  because a reader who finds it in the type definitions needs to know. */
  dead?: boolean;
};

const METHODS: Method[] = [
  { name: "connect", scope: "prompt", what: "Opens the approval window. Grants the read scope." },
  { name: "getPrimaryAccount", scope: "read", what: "The user's Canton party." },
  { name: "listAccounts", scope: "read", what: "Every party the wallet holds." },
  { name: "getActiveNetwork", scope: "open", what: "Which Canton network is selected." },
  { name: "isConnected", scope: "open", what: "Whether this origin is already connected." },
  { name: "slay_getBalances", scope: "ledger", what: "Balances. The ledger scope is an opt-in checkbox on the connect screen, off by default." },
  { name: "prepareExecute", scope: "prompt", what: "Moves value. Re-prompts on every single call — there is no standing spend permission." },
  { name: "ledgerApi", scope: "—", what: "Always refuses (4200). Slay is custodial: keys live on the Worker's validator, not in the extension.", dead: true },
  { name: "signMessage", scope: "—", what: "Always refuses (4200). Same reason.", dead: true },
];

function HowToConnect() {
  return (
    <section className="card">
      <div className="card-head">
        <h2>How to connect</h2>
        <span className="eyebrow">CIP-0103</span>
      </div>

      <p className="note">
        Slay injects a CIP-0103 provider. No API key, no registration, no
        server-side setup — if the extension is installed, your page can ask
        to connect immediately.
      </p>

      <pre className="code-block">
        <code>{`// 1 · find the wallet
window.addEventListener("canton:announceProvider", (e) => {
  console.log("wallet:", e.detail);          // { id, name, … }
});
window.dispatchEvent(new Event("canton:requestProvider"));

// 2 · connect — opens an approval window, grants the read scope
await window.slay.request({ method: "connect" });

// 3 · identity
const account = await window.slay.request({ method: "getPrimaryAccount" });

// 4 · move value — prompts the user every time, by design
await window.slay.request({
  method: "prepareExecute",
  params: { asset: "CC", to: "<your-party>", amount: 10 },
});`}</code>
      </pre>

      <h3 className="sub-head">Provider methods</h3>
      <div className="ref-list">
        {METHODS.map((m) => (
          <div className={`ref-row ${m.dead ? "dead" : ""}`} key={m.name}>
            <code className="ref-name">{m.name}</code>
            <span className={`ref-scope scope-${m.scope.replace("—", "none")}`}>
              {m.scope}
            </span>
            <span className="ref-what">{m.what}</span>
          </div>
        ))}
      </div>

      <h3 className="sub-head">Public HTTP</h3>
      <div className="ref-list">
        <div className="ref-row">
          <code className="ref-name">GET /api/prices/:asset</code>
          <span className="ref-scope scope-open">open</span>
          <span className="ref-what">
            cc · cbtc · ceth · hecto → <code>{"{ usd, asOf, stale }"}</code>.{" "}
            <b>usd is nullable</b> — render a dash, never $0.00.
          </span>
        </div>
        <div className="ref-row">
          <code className="ref-name">GET /api/stats</code>
          <span className="ref-scope scope-open">open</span>
          <span className="ref-what">
            Round, marker value, traffic price — each with its own{" "}
            <code>sources</code> provenance. Check it before trusting a number.
          </span>
        </div>
      </div>

      <p className="note" style={{ marginTop: 14 }}>
        These need no key and no session, but they are{" "}
        <b>server-side only</b> today: the Worker answers unknown browser
        origins with a mismatched CORS header, so a page cannot call them
        directly.
      </p>
    </section>
  );
}

/* ── Per-app rollup ────────────────────────────────────────────────── */

function YourApp({ price }: { price: CcPrice | null }) {
  const [origin, setOrigin] = useState("");
  const [queried, setQueried] = useState<string | null>(null);
  const [stats, setStats] = useState<IntegratorStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const o = origin.trim();
    if (!o) return;
    setBusy(true);
    setError(null);
    setStats(null);
    setQueried(o);
    try {
      setStats(await integrations.stats(o));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Your app</h2>
        <span className="eyebrow">rollup by origin</span>
      </div>

      <div className="filters">
        <label className="field grow">
          <input
            placeholder="https://your-dapp.example"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
          />
        </label>
        <button className="btn primary inline" onClick={() => void load()} disabled={busy || !origin.trim()}>
          {busy ? "Loading…" : "Load"}
        </button>
      </div>

      {busy ? <Spinner label={`Loading ${queried ?? ""}`} /> : null}

      {/* The endpoint this page is the contract for does not exist yet.
          In real mode a 404 is the expected outcome — name the missing
          piece instead of rendering a generic failure. */}
      {!busy && error instanceof ApiError && error.status === 404 ? (
        <Notice
          tone="info"
          eyebrow="Not built yet"
          title="Per-app rollups need attribution the Worker doesn't record yet"
        >
          <p>
            The extension knows which site initiated each transaction; the
            Worker doesn't store it. The <code>source_origin</code> migration adds
            that column (and retires the <code>[idem:]</code> memo hack), and
            then <code>GET /api/integrations/stats</code> serves this card.
            Until then this section stays honestly empty.
          </p>
        </Notice>
      ) : null}

      {!busy && error && !(error instanceof ApiError && error.status === 404) ? (
        <ErrorState error={error} what={`stats for ${queried ?? "that origin"}`} onRetry={() => void load()} />
      ) : null}

      {!busy && stats ? <StatsGrid stats={stats} price={price} /> : null}

      {!busy && !stats && !error && !queried ? (
        <p className="note">
          Enter the origin your dApp connects from — the same one users see on
          the Slay approval screen.
        </p>
      ) : null}
    </section>
  );
}

function StatsGrid({ stats, price }: { stats: IntegratorStats; price: CcPrice | null }) {
  const gain = stats.plUsd >= 0;
  return (
    <>
      <div className="stat-grid">
        <div className="stat">
          <span className="label">Transactions (30d)</span>
          <span className="stat-val">{stats.txCount.toLocaleString()}</span>
          <span className="label">{stats.distinctUsers.toLocaleString()} distinct wallets</span>
        </div>
        <div className="stat">
          <span className="label">Volume</span>
          <span className="stat-val">{formatCc(stats.volume.cc)} CC</span>
          <span className="label">
            + {stats.volume.cbtc} CBTC · {stats.volume.ceth} cETH
          </span>
        </div>
        <div className="stat">
          <span className="label">Traffic consumed</span>
          <span className="stat-val">{stats.trafficKb.toLocaleString()} KB</span>
          <span className="label">≈ {formatUsd(stats.trafficBurnUsd)} burned</span>
        </div>
        <div className="stat">
          <span className="label">Markers · weight</span>
          <span className="stat-val">
            {stats.markersFiled.toLocaleString()} · {Math.round(stats.markerWeight * 100)}%
          </span>
          <span className="label">CIP-0047, you as beneficiary</span>
        </div>
        <div className="stat">
          <span className="label">Rewards minted to you</span>
          <span className="stat-val">{formatCc(stats.rewardsCc)} CC</span>
          <span className="label">
            ≈ {formatUsd(stats.rewardsUsd)}
            {price ? ` at ${formatUsd(price.usd)}/CC` : ""}
          </span>
        </div>
        <div className="stat">
          <span className="label">Net P/L (30d)</span>
          <span className={`stat-val ${gain ? "pos" : "neg"}`}>
            {gain ? "+" : "−"}{formatUsd(Math.abs(stats.plUsd))}
          </span>
          <span className="label">rewards − traffic − fees</span>
        </div>
      </div>
      <ComplianceGauge ratio={stats.complianceRatio} />
    </>
  );
}

/* ── Fair-use gauge ────────────────────────────────────────────────── */

/**
 * Marker USD filed ÷ real burn generated. The GSF's fair-use rule for
 * CIP-0047 reserves markers for real asset transfers, and community
 * dashboards (ccview.io) publicly flag apps whose ratio runs hot. Above ~1
 * you are claiming more reward value than the activity burned — sustained,
 * that is how an app ends up on the overuse board.
 */
function ComplianceGauge({ ratio }: { ratio: number }) {
  const hot = ratio > 1;
  return (
    <Notice
      tone={hot ? "warn" : "info"}
      eyebrow="Fair use"
      title={`Marker-to-burn ratio: ${ratio.toFixed(2)}`}
    >
      <p>
        {hot
          ? "Above 1.0 — this app is filing more marker value than its activity burns. The ecosystem tracks this publicly; sustained overuse risks the featured grant."
          : "At or under 1.0 — marker filings are covered by real burned activity."}
      </p>
    </Notice>
  );
}

/* ── Standing caveat ───────────────────────────────────────────────── */

function ComplianceNote() {
  return (
    <p className="note" style={{ marginTop: 4 }}>
      Markers are filed only for real asset transfers your app enabled — never
      for synthetic or internal operations. That is the GSF fair-use policy,
      and it is enforced in Slay's Worker, not by this page.
    </p>
  );
}
