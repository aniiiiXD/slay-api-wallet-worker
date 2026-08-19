# Going live — removing the scaffolding

How every number on this dashboard becomes real, and what gets deleted on the
way. Written 2026-08-12.

The dashboard currently runs on three crutches: a dev proxy, a fixture module,
and six tiles that name a missing endpoint. All three exist for reasons that
were true when they were added. Two of those reasons have since expired.

---

## What changed underneath us

**CORS is fixed.** `mock.ts` opens by saying the Worker answers every browser
origin with `Access-Control-Allow-Origin: slaymoney://`, so Overview and
Activity cannot load real data from a page at all — and that the file should be
deleted once that is fixed.

Verified from the page on 2026-08-12, calling production directly with no proxy:

```
GET /api/prices/cc  → 200
GET /api/stats      → 200
GET /api/wallet     → 401   ← an auth rejection, which means the request
                              arrived. A CORS block never reaches the handler.
```

So the precondition in that file's own header is met. Both the proxy and the
fixtures are now scaffolding rather than workarounds.

**`/api/stats` is deployed and reading from chain.** `sources` comes back all
`"scan"`. The dashboard already receives this and now renders it per tile.

---

## The problem to settle first

Three of the six pending tiles are on the wrong page.

`/api/onchain-rewards` reports reward coupons held by the **operator party**,
gated behind `x-admin-secret`. Those are Slay's rewards, not the signed-in
user's. A user-facing dashboard cannot hold that secret and should not display
those figures if it could.

This splits into two products:

| Wallet view (this dashboard) | Operator / partner view |
|---|---|
| Balance, locked, open positions | App + validator reward coupons |
| This user's transactions and volume | Reward share and rate |
| Fees **this user** paid | Marker value, traffic price, round |
| Connections (on-device) | Network economics, burn |

The BitSafe tracker used as the visual reference is the second kind, not the
first. Deciding which surface owns the reward and network tiles determines
where half the KPI work lands, so it comes before the build.

---

## Phases

### Phase 0 · Untangle git

`slay-kpi` was created by copying `slay-money-api-swap`, which is a **git
worktree**, not a clone. Its `.git` file points at the same admin directory, so
the two share HEAD and the index, and `git worktree list` does not know
`slay-kpi` exists.

Nothing Worker-side can be committed safely until this is fixed. All the KPI
work — the marker-value fix, `?since=`, `/api/onchain-rewards`, migration
`0001` — is uncommitted inside it. A backup patch exists in the session
scratchpad.

This blocks Phase 2 entirely.

### Phase 1 · Strip the scaffolding

No backend work. Verified safe by the CORS check above.

- Delete the dev proxy from `vite.config.ts` and `.env.local`
- Delete `src/mock.ts`, `demoEnabled()`, the demo banner and the `?demo=1` route
- Delete the demo branches in `api.ts`

**Expect zeros.** The account currently signed in has no transactions, no
balance and no Canton party. Every tile will read `0`, and the charts will draw
an axis with no bars. That is correct output for an empty account, and it is
the honest end state — but it will look like a regression against the demo, so
it is worth doing with an account that has activity.

### Phase 2 · Ship what is already written

Commit and deploy the KPI branch. No new code.

| Change | Effect |
|---|---|
| `/api/stats` → `fetchLiveMarkerValueUsdOrNull()` | Marker value stops reporting the fixed $1 governance unit |
| `?since=` on `/wallet/transactions` | 30-day figures stop truncating at 200 rows |
| `/api/onchain-rewards` | Three reward tiles get a source — on whichever surface owns them |
| Migration `0001` | Agent tables + the `(user_id, created_at)` index |

Run the migration **before** the Worker deploy. Note `drizzle/` is gitignored,
so `0001` exists on one machine only — that needs fixing as part of this.

### Phase 3 · Fee capture — the only real build

Everything else is plumbing. This is not.

Per `slay-kpi/docs/NETWORK_FEES_PLAN.md`:

- New `canton_tx_fees` table keyed by `update_id`, **not** a column on
  `transactions` — one chain transaction fans out to as many as three rows and
  a column would triple-count
- `numeric(28,10)`, not micro-CC: a small fee rounds to zero in micro-CC, and
  zero reads as *free*, which is precisely the distinction being measured
- Captured from `exercise_result.summary`, which `canton/ledger.ts` already
  parses and every caller discards
- Field set differs by transaction type — a transfer is
  `holdingFees + outputFees + senderChangeFee`; a traffic purchase is
  `holdingFees + senderChangeFee + amuletPaid`
- Backfill by walking `/v2/updates/trees`, not `/flats` — flats carry only
  created and archived events, no exercise results
- A stamped `capture_start` so pre-migration rows read as UNKNOWN rather than
  free

Unlocks free vs paid **and** total network fees together.

### Phase 4 · Wire the dashboard

- Overview switches from `limit: 200` to `?since=`
- Reward tiles point at `/api/onchain-rewards` on the operator surface
- Fee tiles point at the new capture
- Delete the `pending` origin from `StatCard` once nothing uses it

---

## Definition of done, per tile

| Tile | Real when |
|---|---|
| Net flow / Earned / Spent | Already real. Zero because the account is empty |
| Transactions · 30d | Already real. Accurate past 200 rows only after Phase 2 |
| Transactions / Volume per day | Already real. Same caveat |
| Traffic burned | Stays an **estimate** until per-transaction bytes are recorded. Phase 3 gets the fee side, not the byte count |
| Marker value | Phase 2 |
| Free / Paid transactions | Phase 3 |
| Total network fees | Phase 3 |
| App / Validator / Total rewards | Phase 2 **and** a decision on which surface owns them |
| Available balance / Locked / Positions | Already real |
| Canton party | Real. Says "not provisioned yet" because it is not |

Two things never become real without separate work: **traffic burn** stays
estimated until bytes are recorded per transaction, and **burn offset** was
removed outright because computing it needs network-wide mint and burn totals
the validator's scan proxy does not expose.

---

## Order, and why

1. **Phase 0** — blocks everything Worker-side
2. **Phase 2** — four fixes already written; largest gain per unit of work
3. **Phase 1** — strip scaffolding *after* real data is confirmed flowing, so
   a regression is distinguishable from an empty account
4. **Phase 3** — the real build
5. **Phase 4** — wiring

Phase 1 is deliberately not first. Deleting the fixtures while the live path is
unverified removes the only way to tell a broken dashboard from an empty one.

---

## Open decisions

1. **Which surface owns rewards and network economics** — this wallet
   dashboard, or a separate operator/partner view. Blocks part of Phase 2 and
   all of Phase 4.
2. **Whether to keep a demo mode at all.** Deleting it is the honest end state
   and removes a whole class of "is this real?" doubt. Keeping a marked one is
   defensible for screenshots and onboarding. It cannot be kept casually —
   four pages were deleted from this folder in 2026-08 for being
   fixture-backed, and `mock.ts` rule 1 exists because a demo mode that
   switches itself on when the network fails is how people read fake balances
   as real ones.
3. **Which account to test against.** Everything reads zero on an empty one.
