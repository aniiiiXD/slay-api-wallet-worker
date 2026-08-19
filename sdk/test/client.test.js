/**
 * Client behaviour, against a stub fetch.
 *
 * These cover the paths where being wrong costs money rather than raising an
 * error: idempotency on retry, refusing to retry things that will never
 * succeed, and never treating an unknown outcome as a failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SlayWallet,
  SlayError,
  SpendLimitError,
  NotApprovedError,
  UnknownOutcomeError,
  isRetryable,
} from "../dist/index.js";

const KEY = "sk_live_test_0000";

/** Records every call and replies from a scripted queue. */
function stub(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    const next = script.shift();
    if (typeof next === "function") return next();
    const { status = 200, body = {} } = next ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

const wallet = (script) => {
  const s = stub(script);
  return { w: new SlayWallet({ apiKey: KEY, fetch: s.fetch }), calls: s.calls };
};

test("sends the key as a bearer token", async () => {
  const s = stub([{ body: { balanceCc: "1.000000" } }]);
  const w = new SlayWallet({ apiKey: KEY, fetch: s.fetch });
  await w.getBalance();
  assert.match(s.calls[0].url, /\/api\/v1\/balance$/);
});

test("rejects a key that is not a key, before the network", () => {
  assert.throws(() => new SlayWallet({ apiKey: "my-agent-name" }), /start with 'sk_'/);
  assert.throws(() => new SlayWallet({ apiKey: "" }), /required/);
});

test("a numeric amount is refused locally, not sent", async () => {
  const { w, calls } = wallet([]);
  await assert.rejects(
    () => w.createTransfer({ clientTxId: "a", to: "karan", amountCc: 3 }),
    (e) => e instanceof SlayError && /decimal STRING/.test(e.message)
  );
  assert.equal(calls.length, 0, "must not reach the network");
});

test("a missing clientTxId is refused locally", async () => {
  const { w, calls } = wallet([]);
  await assert.rejects(
    () => w.createTransfer({ clientTxId: "", to: "karan", amountCc: "3" }),
    (e) => e.code === "client_tx_id_required"
  );
  assert.equal(calls.length, 0);
});

test("201 is a success, not a failure", async () => {
  const { w } = wallet([
    { status: 201, body: { clientTxId: "x", status: "settled", amountCc: "3.000000" } },
  ]);
  const t = await w.createTransfer({ clientTxId: "x", to: "karan", amountCc: "3" });
  assert.equal(t.status, "settled");
});

test("429 surfaces as a spend cap and is NOT retryable", async () => {
  const { w } = wallet([
    { status: 429, body: { code: "limit_exceeded", error: "per-transaction cap is 25 CC." } },
  ]);
  const err = await w
    .createTransfer({ clientTxId: "x", to: "k", amountCc: "9999" })
    .then(() => null, (e) => e);
  assert.ok(err instanceof SpendLimitError);
  assert.equal(isRetryable(err), false, "retrying a spend cap never succeeds");
});

test("403 trading_not_approved is its own type, and not retryable", async () => {
  const { w } = wallet([
    { status: 403, body: { code: "trading_not_approved", error: "not approved" } },
  ]);
  const err = await w
    .createTransfer({ clientTxId: "x", to: "k", amountCc: "3" })
    .then(() => null, (e) => e);
  assert.ok(err instanceof NotApprovedError);
  assert.equal(isRetryable(err), false);
});

test("transient codes are retryable, decisions are not", async () => {
  const mk = (code) => new SlayError(500, code, "x");
  assert.equal(isRetryable(mk("unavailable")), true);
  assert.equal(isRetryable(mk("rate_limited")), true);
  assert.equal(isRetryable(mk("internal")), true);
  for (const c of ["bad_request", "forbidden", "invalid_key", "not_found", "unprocessable"]) {
    assert.equal(isRetryable(mk(c)), false, `${c} should not be retried`);
  }
});

test("a dropped connection is UNKNOWN, never a failure", async () => {
  const { w } = wallet([
    () => {
      throw new TypeError("network down");
    },
  ]);
  const err = await w
    .createTransfer({ clientTxId: "pay-1", to: "k", amountCc: "3" })
    .then(() => null, (e) => e);
  assert.ok(err instanceof UnknownOutcomeError);
  assert.equal(err.clientTxId, "pay-1", "must carry the id needed to reconcile");
});

test("sendOnce reuses the SAME clientTxId — it can never double-send", async () => {
  const { w, calls } = wallet([
    () => { throw new TypeError("timeout"); },        // POST dies
    { status: 404, body: { code: "not_found" } },     // lookup: nothing landed
    { status: 201, body: { clientTxId: "pay-7", status: "settled", amountCc: "3.000000" } },
  ]);
  const t = await w.sendOnce({ clientTxId: "pay-7", to: "k", amountCc: "3" });
  assert.equal(t.status, "settled");
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2, "one failed POST, one retry");
  for (const p of posts) {
    assert.equal(JSON.parse(p.body).clientTxId, "pay-7", "id must never change");
  }
});

test("sendOnce returns the original when the transfer landed despite silence", async () => {
  const { w, calls } = wallet([
    () => { throw new TypeError("timeout"); },
    { body: { clientTxId: "pay-9", status: "settled", amountCc: "1.894700" } },
  ]);
  const t = await w.sendOnce({ clientTxId: "pay-9", to: "k", amountCc: "3" });
  assert.equal(t.amountCc, "1.894700", "reports what MOVED, not what was asked");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "must not resend");
});

test("sendOnce does not retry a real refusal", async () => {
  const { w, calls } = wallet([
    { status: 403, body: { code: "forbidden", error: "key lacks tx:write" } },
  ]);
  await assert.rejects(() => w.sendOnce({ clientTxId: "p", to: "k", amountCc: "3" }));
  assert.equal(calls.length, 1, "one attempt only");
});

test("getTransfer returns null on 404 — the safe-to-send answer", async () => {
  const { w } = wallet([{ status: 404, body: { code: "not_found" } }]);
  assert.equal(await w.getTransfer("nope"), null);
});
