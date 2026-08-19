/**
 * @slay/wallet — the client for the Slay wallet provider API.
 *
 * Zero dependencies, `fetch` only. Node 18+, Bun, Deno, Cloudflare Workers,
 * and browsers (though a browser is the wrong place for a key).
 *
 * ── What this wraps ──────────────────────────────────────────────────────
 * Four endpoints. The library exists not because they are hard to call, but
 * because three things about them are easy to get wrong in ways that cost
 * money rather than raise an error:
 *
 *   1. Amounts are decimal STRINGS. `import { cc }` gives you arithmetic that
 *      never touches a float.
 *   2. `clientTxId` must be REUSED on retry, never regenerated. A fresh id is
 *      not a retry — it is a second payment.
 *   3. A timeout is UNKNOWN, not failed, and gets its own error type so it
 *      cannot be caught by a handler meaning "it failed".
 *
 * And one thing that is merely surprising: a 429 from this API is a spend
 * cap, not a request rate. See errors.ts.
 */

import {
  fromResponse,
  SlayError,
  UnknownOutcomeError,
  type ErrorCode,
} from "./errors.js";
import type { Cc } from "./cc.js";

export * as cc from "./cc.js";
export {
  SlayError,
  SpendLimitError,
  NotApprovedError,
  UnknownOutcomeError,
  isRetryable,
  type ErrorCode,
} from "./errors.js";
export type { Cc, Micro } from "./cc.js";

const DEFAULT_BASE = "https://slay-api-wallet-providers.slay-money-api.workers.dev";

/* ────────── shapes ────────── */

export interface Balance {
  balanceCc: Cc;
  /** Owned but unspendable — reserved against positions or in-flight sends. */
  lockedCc: Cc;
  /** balanceCc − lockedCc. Check spends against THIS, not balanceCc. */
  availableCc: Cc;
  /** Null when no Canton party is allocated: the account cannot transact yet. */
  cantonAddress: string | null;
}

export interface Transaction {
  id: string;
  type: string;
  /** Signed. Negative leaves the wallet. */
  amountCc: Cc;
  status: "pending" | "confirmed" | "failed";
  memo: string | null;
  /** Set for transfers created through this API — reconcile against it. */
  clientTxId: string | null;
  createdAt: string;
}

export interface Transfer {
  clientTxId: string;
  status: "settled" | "pending" | "failed";
  /**
   * What actually MOVED — not necessarily what you asked for.
   *
   * A transfer fee, when one applies, is taken from the amount, so the
   * recipient receives this figure rather than the number you sent.
   * Reconcile against this, never against your own request.
   */
  amountCc: Cc;
  /**
   * YOUR take on this transfer, per the account's provider configuration.
   * `"0.000000"` when no fee is configured, or when it has no destination.
   *
   * Reported, NOT moved — see `partnerFeeCollected`.
   */
  partnerFeeCc?: Cc;
  /**
   * Always `false` today.
   *
   * The fee above is computed and returned so it can be billed and
   * reconciled, but no ledger movement has happened yet. Treat it as an
   * invoice line, not as money received.
   */
  partnerFeeCollected?: boolean;
  id?: string;
  createdAt?: string;
}

/** What an operator has configured this account for. Read-only. */
export interface ProviderConfig {
  /**
   * Assets enabled for this account. Transfers move CC only today; anything
   * else listed is enabled and not yet reachable through this API.
   */
  tokens: Array<"cc" | "cbtc" | "ceth" | "tusd" | "hecto">;
  /**
   * YOUR take, not Slay's. Slay's base fee is charged by the send path
   * regardless and does not appear here — nothing on this object can reduce,
   * waive or redirect it.
   */
  fee: {
    mode: "none" | "flat" | "bps";
    /** Used when `mode` is `flat`. Decimal string. */
    flatCc: Cc | null;
    /** Basis points, 1 bp = 0.01%. Used when `mode` is `bps`. */
    bps: number | null;
    /** Ceiling on the take per send. Only meaningful for `bps`. */
    maxCc: Cc | null;
    /**
     * Whether a take is actually payable. `mode` alone is not enough: a fee
     * with no destination party is not charged, so this is false even when
     * `mode` is `flat` or `bps`.
     */
    active: boolean;
  };
  /** Override for the free daily send allowance. Null = the global default. */
  freeTxnsPerDay: number | null;
}

export interface TransferInput {
  /**
   * Your idempotency key. Generate it ONCE per intended payment and reuse the
   * identical value on every retry of that payment.
   *
   * Generating a fresh id on retry is not a retry. It is a second payment.
   */
  clientTxId: string;
  /** A Slay handle (`karan`) or a Canton party id (contains `::`). */
  to: string;
  /** Positive decimal string. `"3.5"`, not `3.5`. */
  amountCc: Cc;
  memo?: string;
}

export interface WalletOptions {
  /** `sk_live_…` — issued from Dashboard → Build → API keys. */
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/* ────────── client ────────── */

export class SlayWallet {
  readonly #key: string;
  readonly #base: string;
  readonly #timeout: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(o: WalletOptions) {
    if (!o.apiKey) throw new Error("apiKey is required");
    if (!o.apiKey.startsWith("sk_")) {
      /* Caught early because the alternative is a 401 that reads as "your key
       * is wrong" when the real problem is that a key id or a name was
       * passed instead of the secret. */
      throw new Error(
        "apiKey does not look like a Slay key — expected it to start with 'sk_'."
      );
    }
    this.#key = o.apiKey;
    this.#base = (o.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#timeout = o.timeoutMs ?? 30_000;
    this.#fetch = o.fetch ?? globalThis.fetch;
  }

  async #request<T>(
    path: string,
    init: RequestInit & { idemId?: string } = {}
  ): Promise<T> {
    const { idemId, ...rest } = init;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeout);

    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        ...rest,
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#key}`,
          ...(rest.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      /* No response at all. For a read this is an annoyance; for a write the
       * outcome is genuinely unknown, so it gets a type a caller cannot
       * mistake for a failure. */
      const why = e instanceof Error ? e.message : String(e);
      throw new UnknownOutcomeError(
        `No response from Slay (${why}). The request may still have been processed.`,
        idemId
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body — fall through to a status-derived error */
    }

    if (!res.ok) {
      const e = body as { error?: string; code?: ErrorCode };
      /* A 5xx on a write is the same ambiguity as a timeout: the server may
       * have committed before it broke. */
      if (res.status >= 500 && idemId) {
        throw new UnknownOutcomeError(
          e.error ?? `Slay returned ${res.status}. The outcome is unknown.`,
          idemId
        );
      }
      throw fromResponse(
        res.status,
        e.code ?? "internal",
        e.error ?? `Request failed (${res.status})`
      );
    }
    return body as T;
  }

  /** Balance for this key's wallet. Needs `balance:read`. */
  getBalance(): Promise<Balance> {
    return this.#request<Balance>("/api/v1/balance");
  }

  /** History, newest first. Needs `tx:read`. */
  async listTransactions(limit = 50): Promise<Transaction[]> {
    const r = await this.#request<{ items: Transaction[] }>(
      `/api/v1/transactions?limit=${encodeURIComponent(String(limit))}`
    );
    return r.items ?? [];
  }

  /**
   * Send CC. Needs `tx:write`, both spend caps on the key, and the account to
   * be approved for programmatic trading.
   *
   * ⚠️ On `UnknownOutcomeError`, do NOT call this again with a new
   * `clientTxId`. Call it with the SAME one — the server dedupes — or use
   * `sendOnce()`, which resolves the ambiguity for you.
   */
  async createTransfer(input: TransferInput): Promise<Transfer> {
    if (!input.clientTxId) {
      throw new SlayError(
        400,
        "client_tx_id_required",
        "clientTxId is required. Generate it once per payment and reuse it on retries."
      );
    }
    if (typeof (input.amountCc as unknown) === "number") {
      /* Caught here rather than at the server, because by the time it arrives
       * the value has been through a float and may not be the amount meant. */
      throw new SlayError(
        400,
        "bad_request",
        "amountCc must be a decimal STRING, not a number — floats lose CC's six decimal places."
      );
    }
    return this.#request<Transfer>("/api/v1/transfers", {
      method: "POST",
      body: JSON.stringify(input),
      idemId: input.clientTxId,
    });
  }

  /**
   * Look up a transfer by your own id. Needs `tx:read`.
   *
   * Returns null on 404, which is the meaningful answer: no transfer with
   * that id exists, so nothing was sent and it is safe to submit.
   */
  async getTransfer(clientTxId: string): Promise<Transfer | null> {
    try {
      return await this.#request<Transfer>(
        `/api/v1/transfers/${encodeURIComponent(clientTxId)}`
      );
    } catch (e) {
      if (e instanceof SlayError && e.code === "not_found") return null;
      throw e;
    }
  }

  /**
   * Send, resolving an unknown outcome instead of guessing.
   *
   * This is the method most callers want. On an ambiguous result it asks the
   * server what happened rather than retrying blindly:
   *
   *   · the transfer exists  → return it. It went through; do not resend.
   *   · it does not exist    → retry with the SAME id, which is safe.
   *
   * It never invents a new `clientTxId`, so it cannot double-send however
   * many times it loops. A refusal — bad amount, missing capability, spend
   * cap, account not approved — is thrown immediately rather than retried,
   * because none of those change by trying again.
   */
  async sendOnce(input: TransferInput, attempts = 3): Promise<Transfer> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.createTransfer(input);
      } catch (e) {
        if (!(e instanceof UnknownOutcomeError)) throw e; // a real refusal

        const found = await this.getTransfer(input.clientTxId).catch(() => null);
        if (found) return found; // it landed despite the silence

        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        }
      }
    }

    throw new UnknownOutcomeError(
      `Could not confirm transfer ${input.clientTxId} after ${attempts} attempts. ` +
        `Do NOT resend with a new id — read /api/v1/transfers/${input.clientTxId}.`,
      input.clientTxId
    );
  }

  /**
   * What this account is configured for — enabled assets and your own fee.
   *
   * Read-only by design: a key cannot widen the assets it may touch or change
   * the fee it charges. Those are account settings a signed-in human makes.
   *
   * Worth calling at startup rather than per request; it changes when someone
   * edits it in the dashboard, not on its own.
   */
  getConfig(): Promise<ProviderConfig> {
    return this.#request<ProviderConfig>("/api/v1/config");
  }

  /** Liveness/readiness of the wallet Worker. No key required by the server,
   *  but exposed here so a partner has one place to check. */
  async health(): Promise<{ ok: boolean; db: string; ms: number }> {
    const res = await this.#fetch(`${this.#base}/health`);
    return (await res.json()) as { ok: boolean; db: string; ms: number };
  }
}

export default SlayWallet;
