# Dashboard KPIs

The metrics this dashboard exists to show, and — for each — whether the data
exists today, where it comes from, and what has to be built.

Written 2026-08-11. Availability was checked against the live Worker
(`slay-money-api.slay-money-api.workers.dev`) and against
`integration/prod-deploy`, the merged branch that is not yet deployed.

Legend used throughout:

| | Meaning |
|---|---|
| **LIVE** | Served from a real source today |
| **DEPLOY** | Implemented on `integration/prod-deploy`, blocked only on shipping it |
| **BUILD** | No implementation exists; needs work |
| **BLOCKED** | Needs data the Worker cannot currently reach |

---

## 1 · Transactions

Transaction count, a transaction graph over time, day-wise volume.

| Metric | Status | Source |
|---|---|---|
| Transaction count | **LIVE** | `GET /api/wallet/transactions?limit=N` |
| Transaction graph (count over time) | **LIVE** | Derived client-side from `createdAt` |
| Day-wise volume | **LIVE** | Derived from `amountCc` bucketed by `createdAt` |
| Total history | **LIVE** | Same endpoint |

Each row carries `id`, `type`, `amountCc`, `status`, `counterpartyHandle`,
`memo`, `refType`, `refId`, `lighthouseUrl`, `createdAt`.

**Watch the limit.** Overview requests `limit: 200` and computes its 30-day
window from whatever comes back. That silently understates every derived figure
for any account with more than 200 transactions — the 30-day totals are only
correct while the account is quiet. A time-bounded query (`?since=`) or
server-side aggregation is the fix; client-side windowing over a capped list is
not one.

---

## 2 · Free vs paid transactions

A **free** transaction incurred no fee. A **paid** one did.

| Metric | Status | Notes |
|---|---|---|
| Free tx count | **BUILD** | |
| Paid tx count | **BUILD** | |
| Free/paid ratio over time | **BUILD** | |

**There is no fee field on a transaction.** The `transactions` table has
`type`, `amount`, `currency`, `status`, `ref_type`, `ref_id` — no fee column —
and the API type mirrors that.

Fees exist in the system (`src/fees/send-fees.ts`, flat CC transfer fees), and
`tx_type` includes `house_fee` and `fee_refund`, so *some* fees appear as their
own rows. That is not sufficient: a fee row is not linked to the transaction it
charged, so "was this transfer free?" cannot be answered by joining.

Two ways to close it, in order of preference:

1. **Add `fee_amount` to `transactions`** (nullable bigint, smallest unit).
   Free is then `fee_amount IS NULL OR 0`. Correct at the row level, and
   makes total-fees a sum rather than a reconciliation.
2. **Link fee rows** to their parent via `ref_id`. Cheaper to write, but
   leaves the question answerable only by join, and gets fragile the moment a
   transaction has more than one associated fee.

Until one of those lands, any free/paid split on this dashboard would be
invented. It should not be shipped as an estimate.

---

## 3 · Traffic burn

Average traffic burn, total burn, and the cost of it.

| Metric | Status | Source |
|---|---|---|
| Cost per KB | **DEPLOY** | `/api/stats` → `decentralizedSynchronizer.fees.extraTrafficPrice ÷ 1000` |
| Est. total burn (USD) | **LIVE (estimated)** | `tx_count × EST_KB_PER_TX × trafficUsdPerKb` |
| Est. average burn per tx | **LIVE (estimated)** | Same, divided by count |
| **Actual** bytes burned | **BLOCKED** | Not recorded per transaction |

Read the word *estimated* strictly. `EST_KB_PER_TX = 5.8` is a constant — the
Worker's own accept-cron budget, not a measurement. Every "burn" figure on the
dashboard is `count × 5.8 KB × price`. It is an estimate with two live inputs
(count, price) and one assumed one (size), and the UI must keep saying so.

Real per-transaction traffic would have to be recorded at submit time. Nothing
does that today.

---

## 4 · Rewards earned

Canton distinguishes several reward types. All are earned per mining round.

| Reward type | Status | Notes |
|---|---|---|
| **App rewards** (featured app activity markers, CIP-0047) | **DEPLOY** | The Worker already files markers — `src/splice/marker.ts` |
| **Validator rewards** | **BUILD** | Coupon types referenced in `src/splice/amulet.ts`, never surfaced |
| **Asset / SV rewards** | **BUILD** | Not modelled |
| **Total rewards** | **BUILD** | Needs all three |
| **Total fees** | **BUILD** | Blocked on §2 — no per-transaction fee field |

### Marker value — use the right field

This one is already solved in the codebase, and `/api/stats` uses the wrong
source. Both live on `integration/prod-deploy`:

| | Field | Endpoint | Behaviour |
|---|---|---|---|
| ✅ **Correct** | `issuancePerFeaturedAppRewardCoupon` | `issuing_mining_rounds` | Re-prices every ~10-min round, $0.48 → $1.50 cap. `src/splice/marker.ts` calls it *"the exact number ccview shows as Marker Value"* |
| ❌ In `/api/stats` | `featuredAppActivityMarkerAmount` | `amulet-rules` | A governance parameter |

`fetchLiveMarkerValueUsd()` in `src/splice/marker.ts` already implements the
correct read, with KV caching for one round. **`stats/service.ts` should call
it** rather than re-deriving from AmuletRules.

Observed on ccview within a few minutes of each other: `$0.6482`, then
`$0.5719`. Against a dashboard constant of `0.5626`. A fixed number cannot
track this, which is the whole reason the tile looks wrong.

---

## 5 · Activity and history

| Metric | Status | Source |
|---|---|---|
| Full transaction history | **LIVE** | `/api/wallet/transactions` |
| Per-transaction chain link | **LIVE** | `lighthouseUrl`, null for internal rows |
| Counterparty | **LIVE** | `counterpartyHandle` |
| Status (pending/confirmed/failed) | **LIVE** | |
| Connections / dApp grants | **LIVE (on-device)** | `window.slay` — never networked, by design |

Connections stay on-device deliberately: a grant list is browsing-history-shaped
data, and revocation being a local delete is what makes it instant. Do not add
it to a server-side KPI rollup.

---

## Network-level KPIs

Distinct from per-wallet metrics above — these describe the network.

| Metric | Status | Notes |
|---|---|---|
| CC price | **LIVE** | `/api/prices/cc`, 60s cache |
| CC price history 24h / 7d | **LIVE** | 5min / 30min cache |
| Current round number | **DEPLOY** | `/api/stats` returns it; nothing displays it |
| Governance CC price | **DEPLOY** | SV-median, per round |
| Marker value | **DEPLOY** + wrong field — see §4 | |
| Traffic price per KB | **DEPLOY** | |
| **Burn offset %** | **BLOCKED** | See below |

### Burn offset has no path

"Percentage of newly minted CC burned through traffic purchases" needs
network-wide mint and burn totals. The validator's scan-proxy exposes exactly
three endpoints — `amulet-rules`, `open-and-issuing-mining-rounds`,
`transfer-preapprovals` — and none of them carry network aggregates. The full
Scan API is IP-gated to Cloudflare callers.

`BURN_OFFSET_PCT = 70.1` is hardcoded in `dashboard/src/economics.ts`, is not
returned by `/api/stats` at all, and read **68.05** on ccview at the time of
writing. It will not become live by deploying. Either label it as a stamped
snapshot or drop the tile.

---

## Freshness model

What updates how, so KPI cadence claims stay honest.

| Path | Mechanism | Cadence |
|---|---|---|
| BTC/ETH/SOL spot | Pyth Hermes **SSE** → `PriceStream` DO → client WebSocket | Push |
| Polymarket prices | `PolymarketStream` DO → client WebSocket | Push to client, 1.5s upstream poll |
| Telegram | Inbound **webhook** | Event-driven |
| Synthetic volume | Cron | 1 min |
| Deposits, withdrawals, mirror, sweep, accept-cron | Cron | 5 min |
| Asset spot prices | Pull + cache | 60 s |
| Price history 24h / 7d | Pull + cache | 5 min / 30 min |
| `/api/stats` | Pull + cache | 5 min |
| Dashboard Overview | Client poll | 60 s |

**No dashboard KPI uses a push path.** Everything on this page is a 60-second
client poll over TTL'd server caches. That is fine for these metrics — but the
"● LIVE · REFRESHES 60S" badge currently sits above three tiles that are
hardcoded constants, which is the one claim on the page that isn't true.

---

## Build order

1. **Deploy `integration/prod-deploy`.** Unblocks traffic price, round number,
   governance price, and `/api/stats` itself. Nothing else can be verified
   until this lands.
2. **Point `/api/stats` at `fetchLiveMarkerValueUsd()`.** Small change, fixes
   the most visibly wrong number, uses code that already exists.
3. **Add `fee_amount` to `transactions`.** Unblocks free-vs-paid *and* total
   fees — two KPI groups on one migration.
4. **Scope the LIVE badge** to tiles that actually refresh; relabel or drop
   burn offset.
5. **Time-bound the transactions query** so 30-day figures stop silently
   truncating at 200 rows.
6. **Model validator and asset rewards** — the largest piece, and the only one
   that needs new chain reads rather than plumbing.
