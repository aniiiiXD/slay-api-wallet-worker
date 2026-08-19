/**
 * Per-partner fee and token configuration.
 *
 * ── The rule that shapes all of this ─────────────────────────────────────
 * A partner configures THEIR OWN take. They never configure Slay's.
 *
 * Slay's base fee is charged by the existing send path exactly as it always
 * was; nothing here can reduce it, waive it, or route it elsewhere. What a
 * partner sets is an additional amount that goes to their own Canton party.
 * The alternative — letting a partner set "the fee" — means a partner can set
 * it to zero and Slay earns nothing on their volume, which is not a
 * configuration option, it is a revenue decision disguised as one.
 *
 * ── Absence means default, everywhere ────────────────────────────────────
 * No row → global defaults. `enabledTokens: null` → every supported asset.
 * An account that has never opened the settings screen behaves precisely as
 * it did before this file existed. A config system whose mere existence
 * changes behaviour is a migration hazard, and this one shares a database
 * with a Worker that may be running a much older build.
 */

import { eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import { HttpError } from "../wallet/service";

/** Assets the wallet surface supports. */
export const SUPPORTED_TOKENS = ["cc", "cbtc", "ceth", "tusd", "hecto"] as const;
export type Token = (typeof SUPPORTED_TOKENS)[number];

export const isToken = (v: string): v is Token =>
  (SUPPORTED_TOKENS as readonly string[]).includes(v);

export interface ProviderConfig {
  feeMode: "none" | "flat" | "bps";
  feeFlatCc: string | null;
  feeBps: number | null;
  feeMaxCc: string | null;
  feeRecipientParty: string | null;
  freeTxnsPerDay: number | null;
  /** null = all supported tokens. [] = none, which is a real (if odd) setting. */
  enabledTokens: string[] | null;
}

const DEFAULTS: ProviderConfig = {
  feeMode: "none",
  feeFlatCc: null,
  feeBps: null,
  feeMaxCc: null,
  feeRecipientParty: null,
  freeTxnsPerDay: null,
  enabledTokens: null,
};

export async function getProviderConfig(
  db: DB,
  userId: string
): Promise<ProviderConfig> {
  const [row] = await db
    .select()
    .from(schema.walletProviderConfig)
    .where(eq(schema.walletProviderConfig.userId, userId))
    .limit(1);

  if (!row) return DEFAULTS;

  return {
    feeMode: row.feeMode,
    feeFlatCc: row.feeFlatCc,
    feeBps: row.feeBps,
    feeMaxCc: row.feeMaxCc,
    feeRecipientParty: row.feeRecipientParty,
    freeTxnsPerDay: row.freeTxnsPerDay,
    enabledTokens: row.enabledTokens,
  };
}

/* ────────── tokens ────────── */

export function tokensFor(cfg: ProviderConfig): readonly Token[] {
  if (cfg.enabledTokens === null) return SUPPORTED_TOKENS;
  return cfg.enabledTokens.filter(isToken);
}

export const tokenEnabled = (cfg: ProviderConfig, token: string): boolean =>
  cfg.enabledTokens === null
    ? isToken(token)
    : cfg.enabledTokens.includes(token);

/**
 * Refuse a token this partner has not enabled.
 *
 * Distinguishes "we do not support that" from "you have not enabled that",
 * because they need different actions: the first is a support conversation,
 * the second is a settings change the partner can make themselves.
 */
export function assertTokenEnabled(cfg: ProviderConfig, token: string): void {
  if (!isToken(token)) {
    throw new HttpError(
      400,
      `unsupported_token — ${token} is not a supported asset. ` +
        `Supported: ${SUPPORTED_TOKENS.join(", ")}.`
    );
  }
  if (!tokenEnabled(cfg, token)) {
    throw new HttpError(
      403,
      `token_not_enabled — ${token} is not enabled for this account. ` +
        `Enable it in Dashboard → Build → API keys.`
    );
  }
}

/* ────────── fees ────────── */

/* Decimal arithmetic in micro-CC. The same reasoning as the SDK's cc module:
 * parsing and rounding are where floats actually bite, and a fee is exactly
 * a parse-then-round. */
const MICRO = 1_000_000n;

function toMicro(v: string): bigint {
  const s = v.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new HttpError(422, `bad_request — not a decimal: ${v}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 6) throw new HttpError(422, `bad_request — CC has 6 decimal places: ${v}`);
  return BigInt(whole + frac.padEnd(6, "0"));
}

const fromMicro = (m: bigint): string =>
  `${m / MICRO}.${(m % MICRO).toString().padStart(6, "0")}`;

export interface PartnerFee {
  /** Decimal CC. "0.000000" when no partner fee applies. */
  amountCc: string;
  /** Where it goes. Null whenever amountCc is zero. */
  recipientParty: string | null;
  reason: "none" | "flat" | "bps" | "capped";
}

/**
 * The partner's own take for a send of `amountCc`.
 *
 * Returns zero — never throws — when the partner has not configured a fee,
 * has no recipient party, or the computed take would meet or exceed the
 * amount. That last guard is the important one: a fee that consumes the whole
 * transfer produces a zero-value send, and there is already one bug in this
 * codebase where a fee silently ate part of an amount. It does not get a
 * second.
 */
export function partnerFeeFor(cfg: ProviderConfig, amountCc: string): PartnerFee {
  const none: PartnerFee = { amountCc: "0.000000", recipientParty: null, reason: "none" };

  if (cfg.feeMode === "none") return none;
  /* No destination means no fee. Charging one with nowhere to send it would
   * shrink the transfer and collect nothing — the exact shape of the bug in
   * the Slay fee path today. */
  if (!cfg.feeRecipientParty) return none;

  const amount = toMicro(amountCc);
  let take: bigint;
  let reason: PartnerFee["reason"];

  if (cfg.feeMode === "flat") {
    if (!cfg.feeFlatCc) return none;
    take = toMicro(cfg.feeFlatCc);
    reason = "flat";
  } else {
    if (!cfg.feeBps || cfg.feeBps <= 0) return none;
    /* Truncates toward zero — a partner never collects more than the rate. */
    take = (amount * BigInt(cfg.feeBps)) / 10_000n;
    reason = "bps";
  }

  if (cfg.feeMaxCc) {
    const cap = toMicro(cfg.feeMaxCc);
    if (take > cap) {
      take = cap;
      reason = "capped";
    }
  }

  /* Strictly less than the amount. Equal would leave the recipient nothing
   * while still reporting a successful transfer. */
  if (take <= 0n || take >= amount) return none;

  return {
    amountCc: fromMicro(take),
    recipientParty: cfg.feeRecipientParty,
    reason,
  };
}

/** Partner override for the free daily send allowance, if they set one. */
export const freeTxnsOverride = (cfg: ProviderConfig): number | null =>
  cfg.freeTxnsPerDay !== null && cfg.freeTxnsPerDay >= 0 ? cfg.freeTxnsPerDay : null;
