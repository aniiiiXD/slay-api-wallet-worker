# Wallets a provider can create

A plan, not an implementation. Written 2026-08-20.

## The problem, stated plainly

This is called the wallet **provider** API and a provider cannot provision a
wallet. Five handlers — balance, transactions, transfers, transfer lookup,
config — and a key belongs to exactly one wallet. Wallets are created by a
human signing in with an email OTP.

So a provider with 10,000 users needs 10,000 Slay accounts, each created by
hand through a sign-in flow. What is shipped is a single-wallet API. It works,
and it is not what the name promises; a partner finds this out on the first
architecture call.

## What a sub-account is

**A real `users` row**, owned by the provider, with a mapping table recording
that ownership.

Everything downstream already keys off `userId`: `wallets`, `transactions`,
Canton party allocation, the send path, KMS signing, the fee engine. Inventing
a parallel wallet type means reimplementing all of it and keeping the two in
agreement forever. The cheapest correct answer is that a sub-account is a
user who never signs in.

Two details that force the design:

- `users.email` is `NOT NULL UNIQUE`. Sub-accounts get a synthesised address
  (`wallet+{providerId}+{ref}@…`) that is never mailed. Making the column
  nullable would be a *contract* migration on a table shared with a Worker
  that may be running a build from weeks ago — the one thing this repo's
  README says never to do. There is precedent for non-human users already:
  `is_synthetic`.

- Ownership lives in a **new table**, not a column on `users`:

```
provider_wallets
  id               text pk
  provider_user_id text  → users.id   the partner's own account
  wallet_user_id   text  → users.id   the sub-account
  external_ref     text                the partner's own id for this user
  status           text                provisioning | ready | frozen
  created_at, updated_at
  UNIQUE (provider_user_id, external_ref)
```

Additive, so it is an expand step and safe to deploy before anything reads it.
`external_ref` is what makes creation idempotent: a partner retrying a signup
gets the same wallet, not a second one.

## The routes

Path-scoped, mirroring the five that exist. The current routes keep meaning
"the key's own wallet", so nothing already integrated changes.

```
POST /api/v1/wallets                        create (idempotent on externalRef)
GET  /api/v1/wallets                        list, cursor-paged
GET  /api/v1/wallets/{ref}                  one wallet + provisioning status
GET  /api/v1/wallets/{ref}/balance
GET  /api/v1/wallets/{ref}/transactions
POST /api/v1/wallets/{ref}/transfers
GET  /api/v1/wallets/{ref}/transfers/{clientTxId}
```

Scoping is a **query, not a check**: `{ref}` resolves through
`provider_wallets` filtered by the calling key's own `userId`. A key cannot
address a wallet it does not own because the row is not returned, rather than
because a comparison was remembered. Unknown ref → 404, never 403; whether
another provider's ref exists is not a partner's business.

New capability `wallets:provision` for creation. The existing capabilities
govern the per-wallet operations unchanged.

## Party provisioning is asynchronous, and that is not a compromise

Allocating a Canton party is a validator round-trip. Doing it inside
`POST /wallets` makes wallet creation slow, makes it fail for reasons the
partner cannot act on, and puts a multi-second operation in a request a
partner will run in a signup loop.

And this Worker deliberately has **no crons, queues or Durable Objects** —
that absence is the reason it is a separate Worker at all.

So: `POST /wallets` writes the row and returns `status: "provisioning"`
immediately. The **main** Worker's existing cron provisions the party and
flips the status to `ready`. Operations on a wallet that is not ready return
`409 wallet_provisioning` with the status, which is a state a partner can
poll and explain to their user.

This is exactly the split the README already describes: the partner Worker
serves requests, the main Worker runs jobs, and both read one database.

## Two things that must change or this loses money

Both are the same insight: **operations belong to the sub-account, billing and
limits belong to the provider.**

### The free tier is per user, and would become per sub-account

`sendsTodayUtc` counts per `userId`. Three free sends per UTC day. A provider
with 10,000 sub-accounts would get **30,000 free sends a day**, and Slay would
earn nothing on any of them — while the provider's own fee, which has no free
tier, is collected on every single one. The partner earns, we do not.

Nobody has to be devious for this to happen. It is the default behaviour of
sharding users, which is exactly what a provider does.

**Fix:** `withinFreeTier` resolves the *billing* account first — a sub-account
bills to its provider. Three free sends per provider per day, not per end
user.

### Trading approval is per user, and ceilings would multiply

The grant and its per-transaction / per-day ceilings live on `trading_approvals`
keyed by user. Sub-accounts inherit nothing, so either every sub-account needs
approving one by one (unworkable) or none are approved and nothing sends.

Worse if it were inherited naively: a 250 CC/day ceiling becomes 250 × N.

**Fix:** the grant is read from the owning provider account, and the ceilings
apply to the provider's **aggregate** daily spend across all of its wallets.
`agent_spend` gains a billing-account key rather than only an agent key.

## Order of work

1. `provider_wallets` table + the billing-account resolver. Expand only.
2. Free tier and spend ceilings read the billing account. **Before** any
   provisioning route exists — shipping creation first opens the revenue hole
   the moment the first partner uses it.
3. `POST/GET /api/v1/wallets`, status `provisioning`.
4. Main-Worker cron: provision parties, flip to `ready`.
5. Per-wallet balance / transactions / transfers.
6. Cursor pagination — built once, applied to both `/wallets` and
   `/transactions`, which today caps at 200 rows with no way to page past it.

## Decided against

- **A parallel wallet type.** Reimplements the ledger, the send path and the
  fee engine, and has to stay in agreement with them forever.
- **Making `users.email` nullable.** A contract migration on a table shared
  with a slow-release Worker.
- **Crons in this Worker.** The absence is the product.
- **Synchronous party creation.** Puts a validator round-trip inside a signup
  loop.

## Not a technical question, and it gates all of this

Creating wallets that hold real money for other people's users is a KYC/AML
position, not an API feature. Whatever the answer is, it is decided before
the first partner is switched on, not after — and it likely lands as an
approval on the provider account, which is a place the grant system already
reaches.
