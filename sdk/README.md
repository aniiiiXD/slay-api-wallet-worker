# @slay/wallet

Client for the Slay wallet provider API. Zero dependencies, `fetch` only.
Node 18+, Bun, Deno, Cloudflare Workers.

```bash
npm install @slay/wallet
```

```ts
import { SlayWallet, cc } from "@slay/wallet";

const wallet = new SlayWallet({ apiKey: process.env.SLAY_API_KEY! });

const { availableCc } = await wallet.getBalance();

if (cc.gte(availableCc, "3")) {
  const transfer = await wallet.sendOnce({
    clientTxId: "invoice-4182",   // once per payment — see below
    to: "karan",
    amountCc: "3",
    memo: "invoice 4182",
  });
  console.log("moved", transfer.amountCc);   // what MOVED, not what you asked
}
```

Get a key from **Dashboard → Build → API keys**. It is shown once.

---

## The three things worth reading

### 1. `clientTxId` is what makes a retry safe

Generate it **once per intended payment** and reuse the identical value on
every retry of that payment. The server matches on it and returns the original
transfer instead of making a second one.

A fresh id on retry is not a retry. It is a second payment.

### 2. A timeout is *unknown*, not failed

If the connection drops, the transfer may well have happened — the answer was
lost, not the money. That case gets its own type so it cannot be swallowed by
a handler that means "it failed":

```ts
import { UnknownOutcomeError } from "@slay/wallet";

try {
  await wallet.createTransfer({ clientTxId: "invoice-4182", ... });
} catch (e) {
  if (e instanceof UnknownOutcomeError) {
    const actual = await wallet.getTransfer("invoice-4182");
    // null  → nothing was sent, safe to submit
    // else  → it went through; do not resend
  }
}
```

`sendOnce()` does exactly this for you, and never invents a new id, so it
cannot double-send however many times it loops.

### 3. A 429 here is a **spend cap**, not a request rate

This one surprises people. Backing off does not help: `perTransactionCc` will
never accept that amount, and `perDayCc` clears at 00:00 UTC.

```ts
import { isRetryable, SpendLimitError } from "@slay/wallet";

catch (e) {
  if (e instanceof SpendLimitError) { /* alert a human — waiting won't fix it */ }
  else if (isRetryable(e))         { /* transient: unavailable / internal */ }
  else                              { /* a decision: capability, amount, recipient */ }
}
```

---

## Errors

| Type | When | Retry? |
|---|---|---|
| `SpendLimitError` | 429 — per-transaction or per-day cap | Never |
| `NotApprovedError` | 403 — the **account** isn't cleared to move money | Not until approved |
| `UnknownOutcomeError` | no response | Only with the same `clientTxId` |
| `SlayError` | everything else, with a `.code` | `isRetryable(e)` |

`NotApprovedError` is worth knowing about: a perfectly valid key carrying
`tx:write` still gets it until the account is approved for programmatic
trading. It's checked per request, so approval applies to existing keys with
nothing reissued. Reads keep working throughout.

---

## `cc` — decimal maths without floats

Amounts cross the wire as decimal strings. `import { cc }` gives you the
arithmetic you were reaching for, in BigInt over micro-CC.

```ts
cc.add("0.1", "0.2")        // "0.300000"
cc.sub("87.105300", "3")    // "84.105300"
cc.compare("9", "10")       // -1     ("9" > "10" is true for strings!)
cc.gte(balance, price)      // boolean
cc.basisPoints("100", 250)  // "2.500000"  — 2.5%, truncated
cc.format("87.105300")      // "87.1053"   — display only
```

**The honest reason this exists.** `0.1 + 0.2 === 0.30000000000000004` is the
famous example and at six decimal places it does *not* actually bite — round
back to micro-CC and you get the right answer. Floats break somewhere less
famous:

- `parseFloat("1,000")` is **`1`**. Not an error. One.
- `(1.005).toFixed(2)` is `"1.00"`, and `(8.575).toFixed(2)` is `"8.57"` —
  both round down where a person expects up.
- Past ~9,007,199,254 CC the micro value exceeds 2^53 and arithmetic drifts
  for real.

So: not "floats are always wrong", but the failures are silent, they live in
parsing and rounding rather than addition, and a balance is the wrong place to
discover which case you were in. The test suite asserts all of the above,
measured rather than assumed.

---

## API

```ts
new SlayWallet({ apiKey, baseUrl?, timeoutMs?, fetch? })

.getBalance()                    → Balance
.listTransactions(limit = 50)    → Transaction[]
.createTransfer(input)           → Transfer     // raw; you handle retries
.sendOnce(input, attempts = 3)   → Transfer     // resolves unknown outcomes
.getTransfer(clientTxId)         → Transfer | null
.health()                        → { ok, db, ms }
```

`Transfer.amountCc` is **what actually moved**. A transfer fee, where one
applies, comes out of the amount — so the recipient receives that figure
rather than the number you sent. Reconcile against it, never against your own
request.

## Development

```bash
npm run build      # tsc → dist/
npm test           # 26 tests, no network
npm run typecheck
```
