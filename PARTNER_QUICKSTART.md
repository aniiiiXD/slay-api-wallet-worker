# Partner API — quickstart

Five minutes from nothing to a wallet you created and can read.

Everything below is `https://slay-money-api.slay-money-api.workers.dev`.

## 1. Get a key

Sign in at the dashboard → **Build → API keys → New key**, and tick the
capabilities you need:

| Capability | Lets a key |
|---|---|
| `partner:wallets:provision` | create wallets |
| `partner:wallets:read` | read balances, history, wallet list |
| `partner:wallets:write` | move money out of a wallet |

`partner:wallets:write` also needs spend caps and an approved account — the
same rule as any money-moving key, because a different surface is not a
different risk.

**The secret is shown once.** It is hashed on arrival and no endpoint returns
it again. Lost means rotate, not recover.

## 2. Check what your key can do

```bash
curl https://slay-money-api.slay-money-api.workers.dev/api/partner/v1/me \
  -H "Authorization: Bearer sk_live_…"
```

```json
{
  "key":     { "prefix": "sk_live_a1b2", "capabilities": ["partner:wallets:read", "..."] },
  "limits":  { "perTransactionCc": "25", "perDayCc": "250" },
  "account": { "trading": "approved",
               "ceilings": { "perTransactionCc": "25", "perDayCc": "250" },
               "billsTo": "…" },
  "surface": "partner/v1"
}
```

Call this first. `account.trading` tells you whether transfers will work
**before** you write the transfer — if it is not `approved`, every transfer
returns 403 no matter how good the key is.

## 3. Create a wallet for one of your users

```bash
curl -X POST …/api/partner/v1/wallets \
  -H "Authorization: Bearer sk_live_…" -H "content-type: application/json" \
  -d '{"externalRef":"cust-42","label":"Maya"}'
```

```json
{ "ref": "cust-42", "status": "provisioning", "cantonAddress": null,
  "createdAt": "2026-08-20T…" }
```

`externalRef` is **your** id for that user. It is the idempotency key: call
this again with the same reference and you get the same wallet back with
`200` instead of `201`, never a second one. Retry freely.

`status` is `provisioning` because allocating a Canton party is a validator
round-trip and does not belong inside your signup loop. It becomes `ready`
within a few minutes. Balances read fine meanwhile; transfers return
`409 wallet_provisioning` until then.

## 4. Read it

```bash
curl …/api/partner/v1/wallets/cust-42/balance -H "Authorization: Bearer sk_live_…"
```

```json
{ "ref": "cust-42", "status": "ready",
  "balanceCc": "0.000000", "lockedCc": "0.000000", "availableCc": "0.000000",
  "cantonAddress": "slay-money::1220…" }
```

Spend against `availableCc`, never `balanceCc` — locked funds are real money
the holder owns and cannot move.

## 5. Send

```bash
curl -X POST …/api/partner/v1/wallets/cust-42/transfers \
  -H "Authorization: Bearer sk_live_…" -H "content-type: application/json" \
  -d '{"clientTxId":"a4f1…","to":"karan","amountCc":"3.5"}'
```

`clientTxId` is required, and it is the only thing separating "my request
timed out, try again" from "pay them twice". Generate it once per intended
payment and reuse the identical value on every retry of that payment. **A
timeout is not a failure** — it means the outcome is unknown. Re-send the same
id.

`amountCc` is a **string**. CC has six decimal places, IEEE-754 does not
represent them exactly, and a client that parses to a float and formats back
will eventually send someone the wrong number.

## Paging

`GET /wallets` and `GET /wallets/{ref}/transactions` both return
`nextCursor`. Pass it back as `?cursor=`; `null` means you have reached the
end. Cursors rather than offsets because rows are being written while you
page, and offset paging silently skips or repeats under insertion.

## Errors

Every error has a stable `code` and a sentence. **Branch on `code`, never on
the message** — the wording may change, the code may not.

| `code` | Means | What to do |
|---|---|---|
| `invalid_key` | no key matches this token | check the value; keys are shown once |
| `key_revoked` / `key_expired` / `key_rotated` | it existed and no longer works | issue or use the successor |
| `frozen` | valid key, switched off | unfreeze it; retrying will not help |
| `capability_missing` | the key lacks a capability | mint a new key — capabilities are fixed at issue |
| `trading_not_approved` | the **account** is not cleared | apply; reads keep working |
| `wallet_not_found` | no wallet with that reference | create it (idempotent) |
| `wallet_provisioning` | party not allocated yet | poll `GET /wallets/{ref}` |
| `limit_exceeded` | this **key's** cap | per-tx never retries; per-day clears 00:00 UTC |
| `account_limit_exceeded` | the **account's** ceiling, across all your wallets | a different key will not help |
| `client_tx_id_required` | no idempotency key | send one; reuse it on retry |

## The billing model, because it surprises people

Sends made by **every wallet you own** share **one** free-tier allowance and
**one** daily account ceiling. Creating more wallets does not create more
allowance.

That is deliberate. The alternative — an allowance per sub-account — means a
provider with ten thousand wallets gets ten thousand free tiers, and a
250 CC/day approval means 250 × the number of wallets they chose to create.

`GET /me` reports `account.billsTo` so you can always see which account a
wallet's spending counts against.
