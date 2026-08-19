/**
 * Errors, separated by what a caller should DO about them.
 *
 * The API returns thirteen `code` values. Grouping them by HTTP status would
 * be tidy and useless — 403 covers both "this key lacks a capability" (never
 * going to work) and "the account is not approved yet" (will work later,
 * without changing the key). Those need different code paths, so they get
 * different types.
 *
 * The distinction that matters most is the one nobody expects: **429 here is
 * a spend cap, not a request rate.** Backing off and retrying is the wrong
 * response — per-transaction will never accept that amount, and per-day
 * clears at midnight UTC. `isRetryable()` encodes that, because the instinct
 * to retry a 429 is very strong and very expensive.
 */

/** Every machine code the API can return. Branch on these, never on messages. */
export type ErrorCode =
  | "bad_request"
  | "client_tx_id_required"
  | "invalid_key"
  | "forbidden"
  | "trading_not_approved"
  | "not_found"
  | "conflict"
  | "gone"
  | "unprocessable"
  | "limit_exceeded"
  | "rate_limited"
  | "unavailable"
  | "internal";

export class SlayError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "SlayError";
    this.code = code;
    this.status = status;
  }
}

/**
 * A spend cap was hit. Despite arriving as 429, this is not rate limiting.
 *
 * `perTransactionCc` will never accept this amount — the caller must send
 * less or the key must be reissued. `perDayCc` resets at 00:00 UTC. Neither
 * is fixed by waiting a few seconds, which is what a generic 429 handler
 * would do.
 */
export class SpendLimitError extends SlayError {
  constructor(status: number, message: string) {
    super(status, "limit_exceeded", message);
    this.name = "SpendLimitError";
  }
}

/**
 * The ACCOUNT is not cleared to move money programmatically — nothing to do
 * with the key, which may be perfectly valid and carry `tx:write`.
 *
 * Checked on every request rather than stamped onto the key, so once the
 * account is approved existing keys start working with nothing reissued.
 * Reads keep working throughout.
 */
export class NotApprovedError extends SlayError {
  constructor(status: number, message: string) {
    super(status, "trading_not_approved", message);
    this.name = "NotApprovedError";
  }
}

/**
 * The request never got an answer.
 *
 * ⚠️ NOT A FAILURE. A timeout or dropped connection on a transfer means the
 * transfer may well have happened and the answer was lost. Retrying with a
 * NEW `clientTxId` here is how one payment becomes two.
 *
 * Re-send the SAME id — the server dedupes — or read the transfer back.
 * `sendOnce()` does this for you.
 */
export class UnknownOutcomeError extends Error {
  readonly clientTxId: string | undefined;
  constructor(message: string, clientTxId?: string) {
    super(message);
    this.name = "UnknownOutcomeError";
    this.clientTxId = clientTxId;
  }
}

/**
 * Is retrying this request, unchanged, ever going to work?
 *
 * `unavailable` and `rate_limited` are transient. `internal` is worth one
 * retry. Everything else is a decision the caller made — a missing
 * capability, a bad amount, a cap — and repeating it just produces the same
 * refusal more often.
 *
 * `UnknownOutcomeError` is retryable ONLY with the same clientTxId, which is
 * why it is not lumped in here; use `sendOnce()`.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof SpendLimitError) return false;
  if (err instanceof NotApprovedError) return false;
  if (err instanceof SlayError) {
    return err.code === "unavailable" || err.code === "rate_limited" || err.code === "internal";
  }
  return false;
}

/** Build the right error subclass for a code. */
export function fromResponse(status: number, code: ErrorCode, message: string): SlayError {
  if (code === "limit_exceeded") return new SpendLimitError(status, message);
  if (code === "trading_not_approved") return new NotApprovedError(status, message);
  return new SlayError(status, code, message);
}
