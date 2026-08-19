# slay-api-wallet-providers

The wallet API partners integrate against. A separate Cloudflare Worker from
`slay-money-api`, deployed on its own schedule, so that shipping the Slay app
cannot break a partner.

```
┌─ slay-api-wallet-providers ──┐   ┌─ slay-money-api ─────────────┐
│  /api/v1/balance             │   │  markets, rewards, swaps,    │
│  /api/v1/transactions        │   │  admin, prediction, p2p,     │
│  /api/v1/transfers           │   │  dashboard, extension …      │
│  /api/v1/transfers/{id}      │   │  ~420 handlers               │
│  /api/v1/config              │   │                              │
│  /docs  /openapi.json        │   │  ~25 cron jobs               │
│  deploys from a tag, rarely  │   │  deploys continuously        │
└──────────────┬───────────────┘   └───────────────┬──────────────┘
               └──────────┬────────────────────────┘
                shared Postgres + shared Canton validator
                        (cannot be separated)
```

## Why this repo exists

The main Worker serves ~425 handlers. Partners call five of them. Measured
across the last 199 commits that touched `src/`:

| | |
|---|---|
| Commits changing **only** things partners never call | **123 — 61%** |
| Commits touching shared code | 56 — 28% |
| Commits touching `db/schema.ts` | 23 |

Every one of those 123 deploys reshipped the code serving partners while
changing nothing they use. That is the exposure this repo removes.

## What it does not remove

**Read this before telling a partner they are isolated.**

**1. The database is shared, and always will be.** A partner's CC is real CC
in the same Canton ledger as everyone else's. There is no version of this
where partner wallets live in a separate database. So a migration that renames
or drops a column still reaches partners — and it reaches them at the worst
possible moment, when nobody deployed anything here and the change looks
unrelated. See [Migrations](#migrations).

**2. The money path is code partners genuinely run.** `wallet/service.ts` and
`fees/send-fees.ts` are how money moves; they are vendored here, not avoided.
Isolation protects partners from the 71% of the codebase they never touch. It
does not protect them from a bug in `send()`.

The live example, at the time this repo was created: a transfer's amount was
reduced by a fee that was then never collected — the recipient short-changed
and no `house_fee` row written. That bug was in the partner closure, and a
separate Worker would not have prevented it.

**Fixed 2026-08-20**, in `splice/amulet.ts`. When the retry fallback strips
the fee output, the fee is now added back to the recipient in the same
submission: if Slay cannot take its fee, it does not get to keep it out of the
customer's transfer either. Sweeping it in a second transfer was the obvious
alternative and is the wrong one — a transfer burns about 5.8 KB of
synchronizer traffic, roughly $0.35, to recover a fee worth about $0.12.

The invariant is now asserted upstream in `test/send-fee-invariant.test.mjs`:
what the recipient receives plus what slay-fees collects equals what the sender
asked to send, on both branches.

What protects partners from that class of bug is **release cadence**, not
architecture: this Worker deploys from a reviewed tag, after the same code has
been running in production on the main Worker.

## The vendoring trade

59 files — about 23,400 lines, 33% of the main Worker's source — are copied
here rather than shared. This was chosen deliberately: physical isolation from
Slay's release cadence, at the cost of duplication.

The cost is **drift**: a fix lands upstream, nobody copies it here, and the two
Workers quietly disagree about how money moves. Silent drift in a money path is
the worst outcome this design can produce, so it is made loud:

```bash
npm run drift          # every vendored file vs slay-money-api
npm run drift:accept   # record current state as intentional
```

`VENDOR.json` holds a SHA-256 for both sides of every vendored file.
`npm run drift` reports three cases, needing three different responses:

- **UPSTREAM CHANGED** — someone edited `slay-money-api`. Read the diff. If
  partners need the fix, copy it across and accept.
- **LOCAL CHANGED** — someone edited the copy here. Allowed, but from then on
  that file is ours and upstream fixes will not apply cleanly.
- **BOTH CHANGED** — the divergence this exists to catch. Reconcile by hand.

It runs as part of `npm run verify`, and therefore before every deploy. It
fails rather than passes when it cannot find the upstream checkout: a check
that skips itself is worse than no check.

## Migrations

The one risk no infrastructure split can remove. **Expand/contract, always:**

1. **Expand** — add the new column/table. Deploy the main Worker. Partners are
   untouched because nothing they read has changed.
2. **Migrate** — backfill. Ship partner code that reads the new shape, from a
   tag, once it has run in production on the main Worker.
3. **Contract** — only after every deployed partner build reads the new shape,
   drop the old column.

Never rename. Never drop in the same release that stops writing a column. The
partner Worker may be running a build that is weeks old, and it is reading the
same tables — that is the entire hazard.

## Scope

Basic wallet. Balance, history, send, transfer lookup, and a read-only view of
what the account is configured for. Nothing else.

Every feature added here is a feature that can break here, which defeats the
reason it was built. New surface belongs on the main Worker until it has been
boring for long enough. If something must be added, it should arrive the same
way this did: measured, vendored, drift-tracked.

Deliberately absent: cron jobs, Durable Objects, queues, an auth surface,
email. Reconciliation and sweeps stay on the main Worker and operate on the
same shared database, so partner wallets are still reconciled — by code that is
allowed to change often.

## Running it

```bash
npm install
npm run dev            # wrangler dev on :8788
npm run verify         # typecheck + docs freshness + drift
npm run deploy
```

Secrets are listed in `wrangler.toml` and set with `wrangler secret put`. They
must match `slay-money-api` exactly — same database, same validator, same fee
party. Pointing this Worker somewhere else does not isolate partners, it
strands them.

## Deploying

Never from `main`. The isolation is worth exactly what the release discipline
is worth; deploying on every commit would rebuild the coupling this repo was
created to remove.

```bash
git tag -a partner-v1.0.0 -m "..." && git push --tags
git checkout partner-v1.0.0
npm run verify && npm run deploy
```

## Docs

`/docs` renders from `openapi.yaml` at build time, so the reference cannot
drift from the contract. Edit the YAML, then `npm run docs:gen`.
`npm run docs:check` fails the build if the generated module is stale.
