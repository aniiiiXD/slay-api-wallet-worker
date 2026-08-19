/**
 * Overview — ccview-style analytics home (2026-08 transform).
 *
 * Three sections, explorer-shaped:
 *   Wallet          hero balance tile + stat tiles
 *   Canton Coin     hero price + delta, window toggle, real history chart
 *   Live transfers  recent activity feed, Lighthouse deep links when real
 *
 * Every number is Worker data or derived from it. The chart is the same
 * CoinGecko series ccview charts ("canton-network"), served by
 * /api/prices/cc/history — added to the Worker for exactly this page.
 * The one price on offer is the EXTERNAL market price; the card says so
 * rather than implying it is the governance (SV-median) price, which the
 * Worker cannot see until the /api/stats Scan proxy exists.
 */

import { useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { Notice, Spinner } from "../components/Notice";
import { AreaChart } from "../components/AreaChart";
import { StatCard } from "../components/StatCard";
import { DayBars, bucketByDay, type DayBucket } from "../components/DayBars";
import { BreakdownTable } from "../components/BreakdownTable";
import { useAsync } from "../components/useAsync";
import {
  ccHistory,
  ccPrice,
  kpis,
  networkStats,
  wallet,
  type CcPrice,
  type HistoryWindow,
  type KpiDay,
  type Kpis,
  type NetworkStats,
  type PriceHistory,
  type Transaction,
  type Wallet,
} from "../api";
import {
  amountDirection,
  ccToUsd,
  formatCc,
  formatCcSigned,
  formatDateTime,
  formatRelative,
  formatUsd,
  formatUsdFine,
  humanizeType,
  isAmount,
  truncateMiddle,
} from "../format";
import {
  EST_KB_PER_TX,
  MARKER_VALUE_USD,
  PARAMS_AS_OF,
  TRAFFIC_USD_PER_KB,
} from "../economics";

type Bundle = {
  wallet: Wallet;
  txs: Transaction[];
  price: CcPrice | null;
};

/** The window every figure in the Economics section reports on. */
const WINDOW_DAYS = 30;

/**
 * The Worker's page cap. Named because two things depend on it: the fetch
 * below asks for exactly this many, and the fallback rollup has to be able
 * to tell "your account had 200 transactions" from "your account had at
 * least 200 transactions and this total is short".
 */
const TX_PAGE_LIMIT = 200;

export function Overview({
  onSignOut,
  onSeeAll,
}: {
  onSignOut: () => void;
  onSeeAll: () => void;
}) {
  const state = useAsync<Bundle>(async () => {
    const [w, txs, price] = await Promise.all([
      wallet.me(),
      // The Worker's cap rather than a screenful: the economics section
      // rolls these up over 30 days; the feed shows the top 8.
      wallet.transactions(TX_PAGE_LIMIT),
      // Price is best-effort; the balance stands without it.
      ccPrice().catch(() => null),
    ]);
    return { wallet: w, txs, price };
  }, [], { refreshMs: 60_000 });

  if (state.loading) return <Spinner label="Loading your wallet" />;
  if (state.error || !state.data) {
    return (
      <ErrorState
        error={state.error}
        what="your wallet"
        onRetry={state.reload}
        onSignOut={onSignOut}
      />
    );
  }

  const { wallet: w, txs, price } = state.data;
  const name = [w.firstName, w.lastName].filter(Boolean).join(" ");

  return (
    <div className="stack-lg">
      <header className="page-head">
        <div>
          <span className="eyebrow">Overview</span>
          <h1 className="display">{name || w.handle || "Your wallet"}</h1>
        </div>
      </header>

      <EconomicsSection txs={txs} price={price} />
      <WalletSection w={w} price={price} />
      <MarketSection spot={price} />
      <TransfersSection txs={txs.slice(0, 8)} onSeeAll={onSeeAll} />
    </div>
  );
}

/* ── Economics — the money loop, first ─────────────────────────────
 *
 * The Canton story in tiles: what the network pays (marker value), what
 * it charges (traffic price, burned as CC), and what YOUR activity did —
 * earned, spent, net, and the traffic your transactions burned.
 *
 * Sourcing discipline:
 *   - your flow: computed from your real transaction history (30d)
 *   - network params: governance constants, as-of stamped (Scan API
 *     refuses browsers; live via /api/stats when the proxy ships)
 *   - traffic burn: txCount × 5.8 KB × $/KB — an ESTIMATE, labeled as
 *     one, because the Worker logs per-tx bytes but doesn't aggregate
 *     them yet. An estimate wearing an "est." tag beats a blank tile;
 *     an estimate without one would be a lie.
 */

function EconomicsSection({
  txs,
  price,
}: {
  txs: Transaction[];
  price: CcPrice | null;
}) {
  // One endpoint for every governance number on this page AND on
  // Integrate — the tiles cannot disagree because they share the fetch.
  const net = useAsync<NetworkStats | null>(
    () => networkStats().catch(() => null),
    [],
    { refreshMs: 300_000 }
  );

  /* The server-side rollup of this same window.
   *
   * Identical degradation contract to networkStats above: a failure —
   * and today that failure is a 404, because /api/kpis is not deployed —
   * resolves to null, and every figure below falls back to computing over
   * the transaction list, which is what this page has always done.
   *
   * That fallback is not scaffolding to delete after the Worker ships. It
   * is what makes the page shippable before it, and what keeps it standing
   * if the endpoint later goes down. The only thing the endpoint changes
   * is accuracy (uncapped) and reach (fees, which cannot be derived here
   * at all).
   *
   * `since` is recomputed on each call rather than pinned at mount, so a
   * tab left open overnight keeps asking for the last 30 days rather than
   * the 30 days that ended when it loaded. */
  const kpi = useAsync<Kpis | null>(
    () =>
      kpis(new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()).catch(
        () => null
      ),
    [],
    { refreshMs: 60_000 }
  );

  const markerUsd = net.data?.markerValueUsd ?? MARKER_VALUE_USD;
  const trafficKbUsd = net.data?.trafficUsdPerKb ?? TRAFFIC_USD_PER_KB;
  const liveMarker = net.data?.sources.markerValue === "scan";
  const liveTraffic = net.data?.sources.trafficPrice === "scan";
  const round = net.data?.sources.round === "scan" ? net.data.round : null;
  const asOf = net.data?.fallbackAsOf ?? PARAMS_AS_OF;

  /* ── Fallback rollup: the client-side path, computed unconditionally ──
   *
   * Cheap enough to always compute (a filter and a loop over ≤200 rows),
   * and computing it unconditionally means the server path has somewhere
   * to fall back to field by field rather than all-or-nothing — a partial
   * response degrades one tile, not the section. */
  const cutoff = Date.now() - WINDOW_DAYS * 86400_000;
  const recent = txs.filter((t) => new Date(t.createdAt).getTime() >= cutoff);

  let localIn = 0;
  let localOut = 0;
  for (const t of recent) {
    if (!isAmount(t.amountCc)) continue;
    if (t.amountCc > 0) localIn += t.amountCc;
    else localOut += -t.amountCc;
  }

  const k = kpi.data;
  const serverRollup = k !== null && isAmount(k.txCount);
  /* Only meaningful on the fallback path: a full page back means the
   * account has AT LEAST this many transactions, so the totals below are
   * a floor. KPIS.md calls this out as the reason /api/kpis exists. */
  const capped = !serverRollup && txs.length >= TX_PAGE_LIMIT;

  const earnedCc = serverOr(k?.inCc, localIn);
  // Declared positive by the contract; `abs` costs nothing and stops a
  // sign convention disagreement from rendering "−−42.50".
  const spentCc = Math.abs(serverOr(k?.outCc, localOut));
  const netCc = serverOr(k?.netCc, earnedCc - spentCc);
  const txCount = Math.max(0, Math.round(serverOr(k?.txCount, recent.length)));
  const netUsd = ccToUsd(netCc, price?.usd);

  const estTrafficUsd = txCount * EST_KB_PER_TX * trafficKbUsd;

  /* Where these four flow figures came from, in a sentence each tile can
   * append. Per-tile provenance is the house rule here: a section-level
   * badge cannot be true of six tiles with three different sources. */
  const basis = serverRollup
    ? "Rolled up server-side over the whole window, so it is not limited by how many transactions this page fetched."
    : capped
      ? `Computed in this browser from the last ${txs.length} transactions — the Worker's page cap — so a busier account's true figure is higher. GET /api/kpis removes the cap.`
      : "Computed in this browser from your full transaction list.";

  /* ── Fee classification ──
   *
   * Three counts, not two. `unknown` is a row with no fee record: it
   * predates fee capture or fell in a backfill gap, and it is NOT free.
   * null (rather than 0) when the endpoint is absent or the field did not
   * arrive as a number — "not reported" and "none" are different facts and
   * the tile renders them differently. */
  const freeCount = numOrNull(k?.freeCount);
  const paidCount = numOrNull(k?.paidCount);
  const unknownCount = numOrNull(k?.unknownCount);
  const feesCc = numOrNull(k?.totalFeesCc);
  const feesUsd = ccToUsd(feesCc, price?.usd);

  const unknown = unknownCount === null ? 0 : Math.max(0, Math.round(unknownCount));
  const hasUnknown = unknown > 0;
  const rawCaptureStart = k?.sources?.feeCaptureStart;
  const captureStart =
    typeof rawCaptureStart === "string" ? rawCaptureStart : null;
  /* "Live" only when the split is actually complete. A green Live badge
   * over a count that omits a fifth of the window would be the most
   * confident wrong number on the page; a partial split gets no badge and
   * carries its shortfall in the sub-line instead. */
  const feesComplete = !hasUnknown && k?.sources?.fees === "captured";

  /* The caveat both count tiles carry. Two ways the split can be short of
   * the whole window, and neither may pass silently: a counted `unknown`,
   * and a response that simply does not claim full coverage. */
  const feeSub = hasUnknown
    ? ` · ${unknown} unclassified`
    : feesComplete
      ? ""
      : " · coverage unconfirmed";
  const feeNote = hasUnknown
    ? ` ${unknown} transaction${unknown === 1 ? "" : "s"} in this window ${
        unknown === 1 ? "has" : "have"
      } no fee record — ${
        captureStart
          ? `they predate fee capture, which began ${formatDateTime(captureStart)}`
          : "they predate fee capture, or fell in a backfill gap"
      }. They are counted as UNKNOWN, never as free, so this figure describes only the ${
        (freeCount ?? 0) + (paidCount ?? 0)
      } classified transactions.`
    : feesComplete
      ? ""
      : " The response did not confirm that every transaction in this window carries a fee record, so read both counts as lower bounds.";

  /* ── Day buckets: server first ──
   *
   * The server's buckets cover the whole window; bucketByDay only ever
   * sees the rows this page fetched. Fall back per chart rather than
   * per section, so a malformed `days` array costs the charts and nothing
   * else. */
  const rawDays = k?.days;
  const serverDays = Array.isArray(rawDays) ? rawDays : null;
  const serverCountBars = toBars(serverDays, (d) => d.count);
  const serverVolumeBars = toBars(serverDays, (d) => d.volumeCc);
  const countBars =
    serverCountBars ??
    bucketByDay(
      recent.map((t) => new Date(t.createdAt).getTime()),
      recent.map(() => 1),
      WINDOW_DAYS
    );
  const volumeBars =
    serverVolumeBars ??
    bucketByDay(
      recent.map((t) => new Date(t.createdAt).getTime()),
      // Volume is turnover, so magnitude regardless of direction — netting
      // in and out here would report a busy day as a quiet one.
      recent.map((t) => Math.abs(t.amountCc)),
      WINDOW_DAYS
    );
  /* Breakdown rows come from the SAME buckets the bars do, so the table and
   * the charts cannot drift: one is the other with the numbers spelled out.
   * Inbound/outbound need a per-day split the bars do not carry, so they are
   * taken from the server days when present and bucketed locally otherwise. */
  const inBars =
    toBars(serverDays, (d) => d.inCc) ??
    bucketByDay(
      recent.filter((t) => t.amountCc > 0).map((t) => new Date(t.createdAt).getTime()),
      recent.filter((t) => t.amountCc > 0).map((t) => t.amountCc),
      WINDOW_DAYS
    );
  const outBars =
    toBars(serverDays, (d) => d.outCc) ??
    bucketByDay(
      recent.filter((t) => t.amountCc < 0).map((t) => new Date(t.createdAt).getTime()),
      recent.filter((t) => t.amountCc < 0).map((t) => Math.abs(t.amountCc)),
      WINDOW_DAYS
    );
  const breakdownRows = countBars.map((b, i) => ({
    date: b.t,
    txCount: b.v,
    volumeCc: volumeBars[i]?.v ?? 0,
    inboundCc: inBars[i]?.v ?? 0,
    outboundCc: outBars[i]?.v ?? 0,
  }));

  const barsNote = serverCountBars !== null
    ? "full window"
    : capped
      ? `last ${txs.length} tx`
      : "from your history";

  return (
    <section>
      <div className="section-row">
        <h2 className="section-title">Economics</h2>
        {/* The badge used to read "live · refreshes 60s" over the whole
            section, while three of these six were hardcoded constants.
            The poll IS 60s; what it refreshes is another matter. Provenance
            now sits per tile, where it can actually be true. */}
        <span className="section-note">
          Polls every 60s{round !== null ? ` · round ${round}` : ""}
        </span>
      </div>
      <div className="stat-row">
        <StatCard
          label="Net flow · 30d"
          value={formatCcSigned(netCc)}
          unit="CC"
          sub={netUsd === null ? "in − out" : `≈ ${formatUsd(netUsd)} · in − out`}
          tone={netCc > 0 ? "green" : netCc < 0 ? "red" : undefined}
          emphasis
          info={`Everything received minus everything sent over the last 30 days. ${basis}`}
        />
        <StatCard
          label="Earned · 30d"
          value={`+${formatCc(earnedCc)}`}
          unit="CC"
          sub="wins, receives, rewards"
          tone="green"
          info={`Inbound transactions only, over the last 30 days. ${basis}`}
        />
        <StatCard
          label="Spent · 30d"
          value={`−${formatCc(spentCc)}`}
          unit="CC"
          sub="sends, bets, fees"
          info={`Outbound transactions only, over the last 30 days. ${basis}`}
        />
        <StatCard
          label="Transactions · 30d"
          value={String(txCount)}
          sub={txCount === 1 ? "confirmed transfer" : "confirmed transfers"}
          info={`Every transaction on your wallet in the last 30 days, inbound and outbound. This is the count that drives the traffic estimate beside it. ${basis}`}
        />
        <StatCard
          label="Traffic burned · est."
          value={formatUsd(estTrafficUsd)}
          sub={txCount > 0
            ? `${formatUsdFine(estTrafficUsd / txCount)} avg/tx · ${txCount} × ${EST_KB_PER_TX} KB`
            : `${EST_KB_PER_TX} KB × ${formatUsdFine(trafficKbUsd)}/KB per tx`}
          origin={{ kind: "estimate" }}
          info={`An estimate, not a measurement. The transaction count and the per-KB price are real; the ${EST_KB_PER_TX} KB per transaction is a constant taken from the Worker's own traffic budget. The per-KB price is ${liveTraffic ? "read live from chain" : `a stamped value from ${asOf}`}. Actual bytes burned are not recorded per transaction.`}
        />
        <StatCard
          label="Marker value"
          value={formatUsdFine(markerUsd)}
          sub="per featured transfer (CIP-0047)"
          origin={liveMarker ? { kind: "live" } : { kind: "stamped", asOf }}
          info="What one featured-app activity marker earns. It re-prices every mining round (~10 minutes), so a stamped value goes out of date quickly."
        />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <div className="chart-card-head">
            <span className="chart-card-title">Transactions per day</span>
            {/* Which rows the bars were built from. A 30-bar chart drawn
                over a truncated page looks exactly like one drawn over the
                whole window, so the axis has to say which it is. */}
            <span className="section-note">{barsNote}</span>
          </div>
          <DayBars data={countBars} format={(v) => `${v} tx`} label="Transactions" />
        </div>
        <div className="chart-card">
          <div className="chart-card-head">
            <span className="chart-card-title">Volume per day · CC</span>
            <span className="section-note">{barsNote}</span>
          </div>
          <DayBars
            data={volumeBars}
            format={(v) => `${formatCc(v)} CC`}
            label="Volume"
          />
        </div>
      </div>

      <BreakdownTable
        rows={breakdownRows}
        title="Daily breakdown"
        range={{ start: cutoff, end: Date.now() }}
        filenameStem="slay-activity"
      />

      {/* Filled from /api/kpis when it answers; named gaps when it does
          not. A missing tile reads as "not planned", and rendering a
          plausible number instead would be the fixture problem that cost
          this dashboard four pages — so the middle state is a dash that
          names the endpoint it is waiting on, never a guess.

          The three counts do not sum to the transaction count unless
          `unknown` is zero. Where it is not, both tiles say so: a split
          that quietly drops uncaptured rows would be a false number on a
          money surface, and it would be false in the flattering direction
          — "free" is the answer everyone wants. */}
      <div className="stat-row">
        <StatCard
          label="Free transactions · 30d"
          value={freeCount === null ? "" : String(Math.max(0, Math.round(freeCount)))}
          origin={
            freeCount === null
              ? { kind: "pending", needs: "per-tx fees" }
              : feesComplete
                ? { kind: "live" }
                : { kind: "plain" }
          }
          sub={`no network fee burned${freeCount === null ? "" : feeSub}`}
          info={
            freeCount === null
              ? "A transaction that burned no Canton network fees — in practice an internal ledger movement rather than an on-chain transfer. Blocked: the transactions table has no fee column, and a fee row is not linked to the transfer it charged, so this cannot be derived today."
              : `A transaction that burned no Canton network fees — in practice an internal ledger movement rather than an on-chain transfer.${feeNote}`
          }
        />
        <StatCard
          label="Paid transactions · 30d"
          value={paidCount === null ? "" : String(Math.max(0, Math.round(paidCount)))}
          origin={
            paidCount === null
              ? { kind: "pending", needs: "per-tx fees" }
              : feesComplete
                ? { kind: "live" }
                : { kind: "plain" }
          }
          sub={`network fee burned${paidCount === null ? "" : feeSub}`}
          info={
            paidCount === null
              ? "A transaction that burned Canton network fees. Needs holdingFees + outputFees + senderChangeFee captured from each transfer's exercise result — the Worker already receives them and discards them."
              : `A transaction that burned Canton network fees — holdingFees + outputFees + senderChangeFee from the transfer's exercise result.${feeNote}`
          }
        />
        <StatCard
          label="Total network fees · 30d"
          value={feesCc === null ? "" : formatCc(feesCc)}
          unit={feesCc === null ? undefined : "CC"}
          origin={
            feesCc === null
              ? { kind: "pending", needs: "per-tx fees" }
              : feesComplete
                ? { kind: "live" }
                : { kind: "plain" }
          }
          sub={
            feesCc === null
              ? "CC burned in fees"
              : `${feesUsd === null ? "burned in fees" : `≈ ${formatUsd(feesUsd)} burned`}${hasUnknown ? " · floor" : ""}`
          }
          info={
            feesCc === null
              ? "Total CC burned as network fees. Same source as free-vs-paid: one fee capture unlocks all three."
              : `Total CC burned as network fees across the window.${
                  hasUnknown
                    ? ` A FLOOR, not a total: ${unknown} transaction${unknown === 1 ? "" : "s"} in this window ${unknown === 1 ? "has" : "have"} no fee record, and whatever ${unknown === 1 ? "it" : "they"} burned is not in this number.`
                    : ""
                }`
          }
        />
        {/* The three reward tiles stay gaps, and deploying the endpoint
            will not close them. /api/onchain-rewards reports the OPERATOR
            party's coupons behind an admin secret — the validator's
            earnings, not this account's. Wiring them here would put
            someone else's income on your wallet page. They belong on an
            operator view; they are kept here because the KPI set names
            them and a silently missing tile reads as "not planned". */}
        <StatCard
          label="App rewards"
          value=""
          origin={{ kind: "pending", needs: "an operator view" }}
          sub="featured-app markers"
          info="Unclaimed AppRewardCoupons held by the OPERATOR party, valued at each round's issuance rate. /api/onchain-rewards serves these behind an admin secret and reports the validator's coupons, not yours — so this stays a named gap on a user dashboard even once it deploys."
        />
        <StatCard
          label="Validator rewards"
          value=""
          origin={{ kind: "pending", needs: "an operator view" }}
          sub="incl. traffic purchases"
          info="Unclaimed ValidatorRewardCoupons, also the operator's. Buying synchronizer traffic mints one for the CC burnt, so they partly offset the traffic bill rather than being new income."
        />
        <StatCard
          label="Total rewards"
          value=""
          origin={{ kind: "pending", needs: "an operator view" }}
          sub="app + validator"
          info="Sum of the two above, and the operator's in the same way. Note these are UNCLAIMED balances: reward coupons are archived when redeemed, so an active-contract read can never mean lifetime earned."
        />
      </div>

      <p className="note chart-foot">
        Every transfer burns traffic; every real featured transfer mints
        marker rewards. Building on Slay? The Integrate tab shows the loop
        from your app's side — markers, weights, and your P/L.
      </p>
    </section>
  );
}

/* ── Wallet tiles ──────────────────────────────────────────────────────
 *
 * Same component and the same per-tile treatment as Economics above. These
 * were the last four boxes on the page still using the old tile markup,
 * which made a section of plain account facts look like a different app
 * sitting under the analytics.
 *
 * Provenance here is `plain` on every tile, and that is the honest answer
 * rather than a missing one: none of these is a chain read or a derived
 * estimate. They are what the account holds, as the Worker's ledger has
 * it, refreshed by the same 60-second poll as everything else. The `info`
 * notes carry what each one MEANS, which is the part that is genuinely
 * unobvious — "locked" and "available" are not two piles of money, and a
 * party id is not an address you can send to from outside Canton.
 */

function WalletSection({ w, price }: { w: Wallet; price: CcPrice | null }) {
  const usd = ccToUsd(w.balanceCc, price?.usd);
  const locked = isAmount(w.lockedCc) ? w.lockedCc : 0;
  const positions = isAmount(w.openPositionsCount) ? w.openPositionsCount : 0;
  const total = isAmount(w.balanceCc) ? w.balanceCc + locked : null;

  return (
    <section>
      <div className="section-row">
        <h2 className="section-title">Wallet</h2>
        <span className="section-note">Polls every 60s</span>
      </div>
      <div className="stat-row">
        <StatCard
          label="Available balance"
          value={formatCc(w.balanceCc)}
          unit="CC"
          emphasis
          sub={`${usd === null ? "USD unavailable" : `≈ ${formatUsd(usd)}`}${
            price?.stale ? " · stale price" : ""
          }`}
          info={`Canton Coin you can spend right now. It EXCLUDES the locked balance beside it${
            total === null ? "" : `, so the account holds ${formatCc(total)} CC in total`
          }. The USD figure is the external market price, not a governance price, and moves between polls.`}
        />
        <StatCard
          label="Locked"
          value={formatCc(locked)}
          unit="CC"
          sub="in open bets & trades"
          info="Yours, but not spendable: CC reserved against positions that have not settled. It returns to the available balance when a position closes — win or lose, the reservation is released either way."
        />
        <StatCard
          label="Open positions"
          value={String(Math.max(0, Math.round(positions)))}
          sub={positions === 1 ? "bet or trade" : "bets + trades"}
          info="Unsettled bets and trades on this account. Each one holds part of the locked balance; closing them all would return the locked figure to available."
        />
        <StatCard
          label="Canton party"
          value={w.cantonAddress ? truncateMiddle(w.cantonAddress, 8, 6) : "—"}
          sub={
            w.cantonAddress
              ? "on MainNet, via the Slay validator"
              : "not provisioned yet"
          }
          // The old markup put the full id in a `title` on the value. The
          // info note is where that belongs now — it is the same native
          // tooltip, and it is keyboard-reachable rather than hover-only.
          info={
            w.cantonAddress
              ? `Your identity on Canton MainNet, hosted by the Slay validator — a party id, not a transferable address, and only meaningful inside Canton. Full id: ${w.cantonAddress}`
              : "No Canton party has been provisioned for this account yet. One is created on the first on-chain movement; until then the balance is a ledger entry the Worker holds for you."
          }
        />
      </div>
    </section>
  );
}

/* ── Guards for server-supplied numbers ────────────────────────────────
 *
 * /api/kpis is not deployed, so the type in api.ts is a contract rather
 * than an observation. Every figure it supplies passes through one of
 * these on the way to a tile: a field that arrives misnamed, null, or as a
 * string reverts to the client-side number instead of rendering `NaN`,
 * which is the one output a money surface must never produce.
 */

/** The server's figure when it is a real finite number, else the local one. */
function serverOr(value: unknown, fallback: number): number {
  return isAmount(value) ? value : fallback;
}

/**
 * The server's figure, or null when there isn't one.
 *
 * Null rather than 0 on purpose: for the fee tiles "not reported" and
 * "none" are different facts, and the tile renders them differently — a
 * dash naming what it waits on versus a real zero.
 */
function numOrNull(value: unknown): number | null {
  return isAmount(value) ? value : null;
}

/**
 * Server day buckets → DayBars input, or null when they cannot be used, so
 * the caller falls back to client-side bucketing.
 *
 * The day key is parsed to LOCAL midnight by hand. `new Date("2026-08-10")`
 * is parsed as UTC by spec, and DayBars formats its labels locally — west
 * of Greenwich every bar would sit under the previous day's label, which
 * is the kind of off-by-one nobody catches by looking.
 */
function toBars(
  days: KpiDay[] | null,
  pick: (d: KpiDay) => unknown
): DayBucket[] | null {
  if (!days || days.length === 0) return null;
  const out: DayBucket[] = [];
  for (const d of days) {
    if (!d) return null;
    const t = localMidnight(d.day);
    if (t === null) return null;
    const v = pick(d);
    out.push({ t, v: isAmount(v) ? v : 0 });
  }
  return out;
}

function localMidnight(day: unknown): number | null {
  if (typeof day !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) {
    return null;
  }
  const t = new Date(y, mo - 1, d).getTime();
  return Number.isFinite(t) ? t : null;
}

/* ── Price chart ───────────────────────────────────────────────────── */

function MarketSection({ spot }: { spot: CcPrice | null }) {
  const [win, setWin] = useState<HistoryWindow>("7d");
  const hist = useAsync<PriceHistory | null>(
    () => ccHistory(win).catch(() => null),
    [win],
    { refreshMs: 60_000 }
  );

  const points = hist.data?.points ?? [];
  const first = points[0]?.p;
  const last = points[points.length - 1]?.p ?? spot?.usd ?? null;
  const delta =
    first != null && last != null && first > 0 ? ((last - first) / first) * 100 : null;

  return (
    <section>
      <h2 className="section-title">Canton Coin</h2>
      <div className="card chart-card">
        <div className="chart-head">
          <div>
            <span className="chart-price">
              {last != null ? `$${last.toFixed(4)}` : "—"}
            </span>
            {delta != null ? (
              <span className={`chart-delta ${delta >= 0 ? "pos" : "neg"}`}>
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(2)}% <span className="chart-delta-win">{win}</span>
              </span>
            ) : null}
          </div>
          <div className="chart-toggles" role="tablist" aria-label="Chart window">
            {(["24h", "7d"] as const).map((cw) => (
              <button
                key={cw}
                role="tab"
                aria-selected={win === cw}
                className={`chart-toggle ${win === cw ? "active" : ""}`}
                onClick={() => setWin(cw)}
              >
                {cw}
              </button>
            ))}
          </div>
        </div>

        {hist.loading ? (
          <div className="chart-empty">
            <Spinner label="Loading price history" />
          </div>
        ) : (
          <AreaChart points={points} window={win} />
        )}

        <p className="note chart-foot">
          External market price (CoinGecko) via the Slay Worker
          {hist.data?.stale ? " · cached" : ""}. Round-median governance price
          arrives with the /api/stats Scan proxy.
        </p>
      </div>
    </section>
  );
}

/* ── Live transfers ────────────────────────────────────────────────── */

function TransfersSection({
  txs,
  onSeeAll,
}: {
  txs: Transaction[];
  onSeeAll: () => void;
}) {
  return (
    <section>
      <div className="section-row">
        <h2 className="section-title">Live transfers</h2>
        <button className="linkish" onClick={onSeeAll}>
          View all →
        </button>
      </div>
      <div className="card">
        {txs.length === 0 ? (
          <Notice tone="info" title="No transactions yet">
            <p>Anything you send, receive or stake will appear here.</p>
          </Notice>
        ) : (
          <ul className="tx-list">
            {txs.map((tx) => (
              <TxRow key={tx.id} tx={tx} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function TxRow({ tx }: { tx: Transaction }) {
  const dir = amountDirection(tx.amountCc);
  return (
    <li className="tx">
      <div className="tx-main">
        <span className="tx-label">
          {tx.counterpartyHandle ? `@${tx.counterpartyHandle}` : humanizeType(tx.type)}
        </span>
        <span className="tx-sub">
          {humanizeType(tx.type)} · {formatRelative(tx.createdAt)}
          {tx.status !== "confirmed" ? ` · ${tx.status}` : ""}
          {tx.lighthouseUrl ? (
            <>
              {" · "}
              <a
                className="tx-chain-link"
                href={tx.lighthouseUrl}
                target="_blank"
                rel="noreferrer"
              >
                on-chain ↗
              </a>
            </>
          ) : null}
        </span>
        {tx.memo ? <span className="tx-memo">{tx.memo}</span> : null}
      </div>
      <span className={`tx-amt ${dir > 0 ? "pos" : dir < 0 ? "neg" : ""}`}>
        {formatCcSigned(tx.amountCc)}
      </span>
    </li>
  );
}
