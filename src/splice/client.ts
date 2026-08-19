/**
 * Splice Validator API client.
 *
 * Replaces canton/client.ts (which talked to a local Daml sandbox running our
 * custom SlayHolding DAR) once the real Splice validator on DevNet is live.
 * From this point on:
 *   - Currency is Amulet (Canton Coin), not our SlayHolding token
 *   - Templates live in the Splice DAR on the validator's participant — we
 *     never compile or upload them, they're managed by Splice
 *   - The Validator API wraps the templates so the app never touches Amulet
 *     contracts directly. Same shape as a normal HTTP REST API.
 *
 * Endpoints (Splice v0):
 *   POST /api/validator/v0/admin/external-party-setup-proposal
 *        Onboard a new user party. Custodial users (no client-side keys) are
 *        wrapped here — the validator holds the party's signing material.
 *   GET  /api/validator/v0/wallet/balance
 *        Returns total unlocked Amulet + accrued holding/validator rewards.
 *   POST /api/validator/v0/wallet/tap
 *        DevNet ONLY. Free faucet — credits the wallet with `amount` CC.
 *        Returns 403 on MainNet; we'll wire a real on-ramp before then.
 *   POST /api/validator/v0/wallet/transfer-offers
 *        Initiate a transfer. When both sender and recipient are hosted on
 *        the same validator (slay → slay user, the common case), the offer
 *        is auto-accepted server-side and you get back a settled tx.
 *        Cross-validator transfers come back as a pending offer that the
 *        recipient's validator must accept.
 *   GET  /api/validator/v0/wallet/transactions
 *        Paginated activity feed.
 *
 * Auth: every call carries a Bearer token issued by the validator's OAuth
 * provider (Splice ships an Auth0-compatible service). The token's `sub`
 * claim binds the call to a specific user party. Service-level calls
 * (admin/* endpoints) use the validator-app token instead.
 *
 *   App-level token   →  audience = "https://canton.network.global"
 *                        sub      = "<user-party-id>"
 *   Service-level     →  audience = "https://canton.network.global"
 *                        sub      = "slay-validator-app"
 *
 * Token issuance is described in SPLICE_VALIDATOR_SETUP.md. For dev we cache
 * a long-lived token per env var; for prod we'll rotate via the JWKS
 * endpoint Splice exposes on the OAuth service.
 */

import type { Env } from "../env";

/* ------------------------------------------------------------------ */
/*  Error shape                                                        */
/* ------------------------------------------------------------------ */

export class SpliceError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/*  Token issuance                                                     */
/*                                                                     */
/*  Two flavours of token: service-level (admin endpoints) and         */
/*  user-level (wallet endpoints submitted on behalf of one user).     */
/*                                                                     */
/*  Both are signed JWTs. In dev the validator's auth service uses a   */
/*  static HS256 secret; in prod we'd switch to RS256 + JWKS rotation. */
/* ------------------------------------------------------------------ */

/**
 * What `sub` claim to mint the JWT with.
 *
 *   "service"             — sub = SPLICE_AUTH_SUBJECT (ledger-api-user on
 *                            disable-auth, used for /v2/* admin calls).
 *   { walletUser: name }  — sub = name. Use this for /api/validator/v0/wallet/*
 *                            endpoints — the wallet API checks `sub` against
 *                            the configured `validator-wallet-users` list
 *                            (typically just "administrator"), NOT against
 *                            arbitrary party IDs.
 *   { user: party-id }    — sub = party-id. Only valid when the party is
 *                            registered as a wallet user (rare on the current
 *                            validator config). Kept for back-compat with
 *                            future external-party setups.
 */
type TokenKind =
  | "service"
  | { walletUser: string }
  | { user: string };

function base64url(bytes: Uint8Array | string): string {
  const buf =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function mintToken(env: Env, kind: TokenKind): Promise<string> {
  // DevNet disable-auth mode hardcodes secret="unsafe" + audience matching
  // VALIDATOR_AUTH_AUDIENCE in the splice .env (default
  // "https://validator.example.com"). Our defaults mirror that so a missing
  // env var doesn't silently break onboarding.
  const secret = env.SPLICE_AUTH_SECRET ?? "unsafe";
  const audience =
    env.SPLICE_AUTH_AUDIENCE ?? "https://validator.example.com";
  // For service-level calls (admin endpoints), use whatever WALLET_ADMIN_USER
  // is configured as in the validator stack — default "administrator" per
  // compose-disable-auth.yaml. Override via SPLICE_AUTH_SUBJECT once we move
  // to real OIDC and want a dedicated service principal.
  const serviceSub = env.SPLICE_AUTH_SUBJECT ?? "administrator";
  let sub: string;
  if (kind === "service") sub = serviceSub;
  else if ("walletUser" in kind) sub = kind.walletUser;
  else sub = kind.user;

  const payload = {
    aud: audience,
    sub,
    iat: Math.floor(Date.now() / 1000),
    // Short-lived — 1 hour. The client mints on-demand per call; nothing
    // breaks if these expire because we re-mint.
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return `${data}.${base64url(new Uint8Array(sig))}`;
}

/* ------------------------------------------------------------------ */
/*  Request helper                                                     */
/* ------------------------------------------------------------------ */

/**
 * Wallet-API GET helper — for endpoints like scan-proxy that need the
 * wallet-audience JWT with sub = a registered wallet user. Defaults to
 * `administrator` (the standard Splice wallet admin user). Override if
 * you've customised validatorWalletUsers.
 */
export async function spliceGet<T>(
  env: Env,
  path: string,
  walletUser?: string
): Promise<T> {
  const sub = walletUser ?? env.SPLICE_OPERATOR_WALLET_USER ?? "administrator";
  return call<T>(env, path, "GET", { walletUser: sub });
}

/**
 * Wallet-API POST helper — same auth as spliceGet, for POST-only endpoints
 * like scan-proxy holdings/state where the request carries a body.
 */
export async function splicePost<T>(
  env: Env,
  path: string,
  body: object,
  walletUser?: string
): Promise<T> {
  const sub = walletUser ?? env.SPLICE_OPERATOR_WALLET_USER ?? "administrator";
  return call<T>(env, path, "POST", { walletUser: sub }, body);
}

/** Admin-API POST helper — service-subject token (like onboardUser), for the
 *  /v0/admin/* endpoints that reject wallet-user subjects (external-party, etc). */
export async function splicePostService<T>(env: Env, path: string, body: object): Promise<T> {
  return call<T>(env, path, "POST", "service", body);
}

/** Admin-API GET helper — service-subject token (external-party/balance etc). */
export async function spliceGetService<T>(env: Env, path: string): Promise<T> {
  return call<T>(env, path, "GET", "service");
}

async function call<T>(
  env: Env,
  path: string,
  method: "GET" | "POST",
  kind: TokenKind,
  body?: object
): Promise<T> {
  const token = await mintToken(env, kind);
  const res = await fetch(`${env.SPLICE_VALIDATOR_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new SpliceError(res.status, `Non-JSON response from ${path}: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const detail = parsed && typeof parsed === "object" ? parsed : { raw: text };
    throw new SpliceError(
      res.status,
      `${method} ${path} → ${res.status}`,
      detail
    );
  }
  return parsed as T;
}

/* ------------------------------------------------------------------ */
/*  Party onboarding                                                   */
/* ------------------------------------------------------------------ */

export type OnboardedUser = {
  partyId: string;       // "user-abc::1220<fp>::<participant-fp>"
  userName: string;      // the hint we passed in, echoed back
};

/**
 * Onboard a new user party on the validator. The validator hosts the party
 * (custodial — no client key material), so the only thing we send is a
 * human-readable hint that becomes the party-name prefix.
 *
 * Idempotent server-side: re-onboarding the same hint returns the same
 * partyId. We rely on that — `attachCantonParty()` may be retried on
 * sign-up if the auth.user.create.after hook is re-invoked.
 */
export async function onboardUser(
  env: Env,
  hint: string
): Promise<OnboardedUser> {
  const result = await call<{
    party_id: string;
    user_name: string;
  }>(env, "/api/validator/v0/admin/users", "POST", "service", {
    name: hint,
  });
  return { partyId: result.party_id, userName: result.user_name };
}

/* ------------------------------------------------------------------ */
/*  Wallet — balance, tap, transactions                                */
/* ------------------------------------------------------------------ */

export type Balance = {
  /** Total unlocked Amulet, in CC (string-decimal so we don't lose precision). */
  unlocked: string;
  /** Locked balance (reward shares pending issuance, etc.). */
  locked: string;
  /** Convenience — unlocked + locked. */
  total: string;
};

export async function getBalance(
  env: Env,
  userParty: string
): Promise<Balance> {
  const result = await call<{
    effective_unlocked_qty: string;
    effective_locked_qty: string;
    total_holding_fees: string;
  }>(env, "/api/validator/v0/wallet/balance", "GET", { user: userParty });

  const unlocked = result.effective_unlocked_qty;
  const locked = result.effective_locked_qty;
  // Plain decimal-string addition would lose precision past 15 digits.
  // For now, JS numbers are fine (CC has 10 decimals, well within range).
  const total = (parseFloat(unlocked) + parseFloat(locked)).toFixed(10);
  return { unlocked, locked, total };
}

/**
 * DevNet faucet — credits the user's wallet with `amountCc` CC. Returns 403
 * on MainNet (no faucet there). Replaces the placeholder topUp logic for
 * DevNet testing. Production top-up plugs in here at the same call-site
 * with a real funding source (Stripe / USDC bridge / etc.).
 */
export async function devnetTap(
  env: Env,
  userParty: string,
  amountCc: number
): Promise<{ transactionId: string }> {
  const result = await call<{ transaction_id: string }>(
    env,
    "/api/validator/v0/wallet/tap",
    "POST",
    { user: userParty },
    { amount: amountCc.toFixed(10) }
  );
  return { transactionId: result.transaction_id };
}

/* ------------------------------------------------------------------ */
/*  Transfers                                                          */
/* ------------------------------------------------------------------ */

export type TransferResult = {
  /** Server-issued tx id for our records. */
  transactionId: string;
  /** "settled" when both parties are on the same validator; "pending"
   *  when an offer was created and is waiting for the recipient's
   *  validator to accept. We treat "pending" as success for the demo. */
  status: "settled" | "pending";
};

/**
 * Send `amountCc` from sender to recipient. Both party IDs come from
 * `wallets.cantonAddress` (which holds the Splice party ID after the
 * onboard-user call above).
 *
 * The Validator API takes the recipient as a *party ID*. If you want to
 * accept a `slay@handle` you have to resolve it to the party ID first
 * (handled in wallet/service.ts via the handles table).
 *
 * `senderWalletUser` (optional) — which validator-wallet-user identity to
 * mint the JWT under. The wallet API gates calls on `sub ∈
 * validator-wallet-users`, so for the operator-side transfer (signup
 * bonus, milestone rewards) we have to mint as "administrator" rather
 * than the operator party id. Falls back to senderParty for back-compat
 * with future external-party setups where each user party is registered
 * as its own wallet user.
 */
export async function transfer(
  env: Env,
  senderParty: string,
  recipientParty: string,
  amountCc: number,
  memo?: string,
  senderWalletUser?: string
): Promise<TransferResult> {
  const kind: TokenKind = senderWalletUser
    ? { walletUser: senderWalletUser }
    : { user: senderParty };
  // Splice 0.6.3 added a required `expires_at` field to transfer-offers
  // — the offer auto-cancels if the counterparty doesn't accept by then.
  // For same-validator auto-accepted transfers (the Slay V1 case) this is
  // effectively a no-op safety net; we set it 24h out so cross-validator
  // transfers in V1.5 have plenty of room to land.
  //
  // Canton timestamp format: microseconds since the Unix epoch as a Long.
  // 24h from now in micros fits in Number.MAX_SAFE_INTEGER (~9e15), so we
  // can send it as a JSON number without precision loss until ~year 2255.
  const expiresAt = (Date.now() + 24 * 60 * 60 * 1000) * 1000;
  // Splice 0.6.3 wraps the response in `{ output: { ... } }` and the
  // result shape varies — same-validator auto-accept returns
  // `offer_contract_id` + `transaction_id`, cross-validator returns just
  // `offer_contract_id`. We type loosely and pick whichever id is present
  // so a missing field downstream becomes "unknown tx id" instead of a
  // hard crash.
  const raw = await call<Record<string, unknown>>(
    env,
    "/api/validator/v0/wallet/transfer-offers",
    "POST",
    kind,
    {
      receiver_party_id: recipientParty,
      amount: amountCc.toFixed(10),
      description: memo ?? "",
      expires_at: expiresAt,
      // tracking_id is Splice's client-side dedup key — if the same id is
      // submitted twice (e.g., we retry on a flaky 5xx), the second call
      // returns the result of the first instead of double-spending. UUID v4
      // gives us per-call uniqueness with zero coordination overhead.
      tracking_id: crypto.randomUUID(),
      // Auto-accept when same-validator. For Slay this is always true in v1
      // since we host every user on our own validator. Cross-validator
      // transfers come in v1.5 when we open to external Splice participants.
      auto_accept: true,
    }
  );
  // Splice 0.6.3 returns `{ offer_contract_id }` only — the legacy
  // `transaction_id` field was dropped. We still check the older fields
  // in case the validator is on a different point release. Keep the raw
  // log behind a DEBUG flag so it doesn't spam Worker logs forever.
  if (env.SPLICE_DEBUG === "1") {
    console.log("[splice.transfer] raw response:", JSON.stringify(raw));
  }
  // Try every plausible id field, in priority order. Cast as needed.
  const out = (raw.output ?? raw) as Record<string, unknown>;
  const transactionId =
    (out.transaction_id as string | undefined) ??
    (out.update_id as string | undefined) ??
    (out.offer_contract_id as string | undefined) ??
    (out.contract_id as string | undefined) ??
    "unknown";
  const status =
    ((out.status as string | undefined) === "pending"
      ? "pending"
      : "settled") as "settled" | "pending";
  return { transactionId, status };
}

/* ------------------------------------------------------------------ */
/*  Transfer via preapproval (external sends, cross-validator)         */
/*                                                                      */
/*  Sends CC to a party hosted on a DIFFERENT Splice validator, using  */
/*  the receiver's published TransferPreapproval contract as their     */
/*  pre-baked consent. The wallet API looks up the preapproval         */
/*  internally via scan-proxy, so we don't pass the contract id.       */
/*                                                                      */
/*  Auth caveat: this endpoint expects `sub ∈ validator-wallet-users`. *
/*  Slay parties aren't currently registered as wallet users, so this  *
/*  may 403 the first time it's called from a Slay user identity.     *
/*  Callers should be prepared to fall back to a direct Daml choice    *
/*  exercise via the JSON Ledger API (Stage 2b) on 403.                *
/* ------------------------------------------------------------------ */

export type PreapprovalTransferResult = {
  transactionId: string;
  /** "settled" — same-validator-preapproval auto-settles. We keep the
   *  union with "pending" in case Splice changes the contract.       */
  status: "settled" | "pending";
};

/**
 * POST /api/validator/v0/wallet/transfer-preapproval/send
 *
 * Body shape mirrors transfer-offers: receiver, amount (10-dp string),
 * description (memo), tracking_id for idempotency. The wallet API
 * looks up the receiver's TransferPreapproval contract via scan-proxy
 * and exercises TransferPreapproval_Send on it server-side, so we
 * don't have to know the choice-arg signature.
 *
 * `senderWalletUser` falls back to {user: senderParty} for back-compat,
 * but on the current Slay validator config our user parties aren't
 * registered wallet users — so a 403 is likely. Caller should handle.
 */
export async function transferViaPreapproval(
  env: Env,
  senderParty: string,
  recipientParty: string,
  amountCc: number,
  memo?: string,
  senderWalletUser?: string
): Promise<PreapprovalTransferResult> {
  const kind: TokenKind = senderWalletUser
    ? { walletUser: senderWalletUser }
    : { user: senderParty };

  const body: Record<string, unknown> = {
    receiver_party_id: recipientParty,
    amount: amountCc.toFixed(10),
    description: memo ?? "",
    tracking_id: crypto.randomUUID(),
  };

  const raw = await call<Record<string, unknown>>(
    env,
    "/api/validator/v0/wallet/transfer-preapproval/send",
    "POST",
    kind,
    body
  );
  if (env.SPLICE_DEBUG === "1") {
    console.log("[splice.preapproval-send] raw response:", JSON.stringify(raw));
  }
  // Same defensive id picking as transfer-offers — Splice 0.6.x has
  // changed response shape between point releases more than once.
  const out = (raw.output ?? raw) as Record<string, unknown>;
  const transactionId =
    (out.transaction_id as string | undefined) ??
    (out.update_id as string | undefined) ??
    (out.transfer_id as string | undefined) ??
    "unknown";
  const status =
    ((out.status as string | undefined) === "pending"
      ? "pending"
      : "settled") as "settled" | "pending";
  return { transactionId, status };
}

/* ------------------------------------------------------------------ */
/*  Activity                                                           */
/* ------------------------------------------------------------------ */

export type TxRow = {
  transactionId: string;
  type: "send" | "receive" | "tap" | "fee" | "reward";
  amountCc: string;
  counterparty?: string;  // party ID of the other side, when applicable
  memo?: string;
  /** ISO 8601 from the validator. */
  at: string;
};

export async function listTransactions(
  env: Env,
  userParty: string,
  limit = 50
): Promise<TxRow[]> {
  // Splice 0.6.3 switched /wallet/transactions from GET (querystring
  // limit) to POST (body params). The old `limit` query param now lives
  // in the request body alongside an optional `begin_after_id` cursor.
  const result = await call<{
    items: Array<{
      transaction_id: string;
      type: TxRow["type"];
      amount: string;
      counterparty?: string;
      memo?: string;
      timestamp: string;
    }>;
  }>(
    env,
    "/api/validator/v0/wallet/transactions",
    "POST",
    { user: userParty },
    { page_size: limit }
  );
  return result.items.map((i) => ({
    transactionId: i.transaction_id,
    type: i.type,
    amountCc: i.amount,
    counterparty: i.counterparty,
    memo: i.memo,
    at: i.timestamp,
  }));
}
