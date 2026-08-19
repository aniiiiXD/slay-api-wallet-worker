/* ------------------------------------------------------------------ *
 *  Slay template wrappers                                             *
 *                                                                      *
 *  TypeScript mirrors of the Daml record types defined in the         *
 *  slay-money DAR. Keeps service-layer code type-safe end-to-end.     *
 *                                                                      *
 *  Each template gets:                                                 *
 *    - a Payload type (the on-chain record fields)                     *
 *    - one Argument type per choice                                    *
 *    - a `templateId()` helper that produces a TemplateId for the     *
 *      JSON Ledger API.                                                *
 *                                                                      *
 *  CC amounts are JSON Decimals serialised as strings ("100.50") to    *
 *  preserve precision in transit. Convert at boundaries via the       *
 *  ccToString / ccFromString helpers.                                  *
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import { slayTemplate, type TemplateId } from "./ledger";

/* ------------------------------------------------------------------ */
/*  Shared scalar conversions                                          */
/* ------------------------------------------------------------------ */

/** Decimal-string for the wire — matches Daml's serialisation. */
export type Decimal = string;
/** ISO-8601 timestamp string. Matches Daml `Time`. */
export type LedgerTimestamp = string;
/**
 * Canton 3.x serialises Daml `Int` as a JSON STRING (not number).
 * Avoids JS number-precision issues for the full 64-bit signed range.
 * Confirmed empirically — passing `1000` for `feeBps` returns
 * `Expected ujson.Str (data: 1000)`. Always stringify Int fields.
 */
export type LedgerInt = string;

/** Daml Decimal is fixed at 10 fractional digits in v2 wire format. */
export function ccToString(cc: number): Decimal {
  return cc.toFixed(10);
}
export function ccFromString(s: Decimal): number {
  return Number(s);
}

export function tsToString(d: Date): LedgerTimestamp {
  return d.toISOString();
}
export function tsFromString(s: LedgerTimestamp): Date {
  return new Date(s);
}

export function intToString(n: number): LedgerInt {
  return Math.trunc(n).toString();
}
export function intFromString(s: LedgerInt): number {
  return Number(s);
}

/* ------------------------------------------------------------------ */
/*  Slay.Types — enums as their wire encoding                          */
/*                                                                      */
/*  Daml sum types without payload serialise as their constructor      */
/*  name. So `MSOpen` becomes the JSON string "MSOpen".                 */
/* ------------------------------------------------------------------ */

export type MarketStatus = "MSOpen" | "MSClosed" | "MSResolved" | "MSCancelled";
export type BetStatus = "BSPlaced" | "BSWon" | "BSLost" | "BSRefunded";
export type AssetId = "AssetBTC" | "AssetXAU" | "AssetOIL";
export type Side = "SideLong" | "SideShort";
export type P2PSide = "P2PBuy" | "P2PSell";
export type P2PStatus =
  | "P2POpen"
  | "P2PMatched"
  | "P2PPaymentSent"
  | "P2PCompleted"
  | "P2PCancelled"
  | "P2PDisputed";

/**
 * Daml sums WITH payloads (e.g. `RKMilestone Int`) serialise as a
 * tagged object: `{ tag: "RKMilestone", value: 3 }`. RKWelcome (nullary)
 * serialises as `{ tag: "RKWelcome", value: {} }`.
 */
export type RewardKind =
  | { tag: "RKWelcome"; value: {} }
  /** RKMilestone Int — the Int level wire-encoded as JSON string. */
  | { tag: "RKMilestone"; value: LedgerInt }
  | { tag: "RKReferral"; value: {} }
  | { tag: "RKAdminCredit"; value: {} };

export type PriceAttestation = {
  asset: AssetId;
  priceUsd: Decimal;
  asOf: LedgerTimestamp;
};

/* ------------------------------------------------------------------ */
/*  Slay.Market.Market                                                 */
/* ------------------------------------------------------------------ */

export type MarketPayload = {
  operator: string;
  marketId: string;
  question: string;
  category: string;
  options: string[];
  pools: Decimal[];
  totalPool: Decimal;
  /** Daml Int — wire-encoded as JSON string. Use intToString(). */
  traderCount: LedgerInt;
  /** Daml Int — wire-encoded as JSON string. Use intToString(). */
  feeBps: LedgerInt;
  status: MarketStatus;
  winningOption: string | null;
  closesAt: LedgerTimestamp;
  resolvesAt: LedgerTimestamp;
  settledAt: LedgerTimestamp | null;
};

export const MarketTemplate = {
  templateId: (env: Env): TemplateId =>
    slayTemplate(env, "Slay.Market", "Market"),
};

export type PlaceBetArg = {
  bettor: string;
  optionId: string;
  stake: Decimal;
  isNewTrader: boolean;
  betId: string;
};

export type ResolveArg = {
  winning: string;
};

/* ------------------------------------------------------------------ */
/*  Slay.Market.Bet                                                    */
/* ------------------------------------------------------------------ */

export type BetPayload = {
  operator: string;
  bettor: string;
  marketId: string;
  marketCid: string;
  betId: string;
  optionId: string;
  stake: Decimal;
  status: BetStatus;
  payout: Decimal | null;
  createdAt: LedgerTimestamp;
  settledAt: LedgerTimestamp | null;
};

export const BetTemplate = {
  templateId: (env: Env): TemplateId =>
    slayTemplate(env, "Slay.Market", "Bet"),
};

export type SettleArg = {
  wonStatus: BetStatus; // BSWon | BSLost
  payoutAmt: Decimal;
};

/* ------------------------------------------------------------------ */
/*  Slay.Trade.TradePosition                                           */
/* ------------------------------------------------------------------ */

export type TradePositionPayload = {
  operator: string;
  trader: string;
  positionId: string;
  asset: AssetId;
  side: Side;
  stake: Decimal;
  entry: PriceAttestation;
  closedAt: LedgerTimestamp | null;
  exit: PriceAttestation | null;
  pnl: Decimal | null;
  isClosed: boolean;
};

export const TradePositionTemplate = {
  templateId: (env: Env): TemplateId =>
    slayTemplate(env, "Slay.Trade", "TradePosition"),
};

export type CloseTradeArg = {
  exitAttestation: PriceAttestation;
};

/* ------------------------------------------------------------------ */
/*  Slay.P2P.P2POffer                                                  */
/* ------------------------------------------------------------------ */

export type P2POfferPayload = {
  operator: string;
  poster: string;
  orderId: string;
  side: P2PSide;
  amount: Decimal;
  pricePerCc: string;
  currency: string;
  minAmount: Decimal | null;
  maxAmount: Decimal | null;
  status: P2PStatus;
  createdAt: LedgerTimestamp;
};

export const P2POfferTemplate = {
  templateId: (env: Env): TemplateId =>
    slayTemplate(env, "Slay.P2P", "P2POffer"),
};

export type MatchOfferArg = {
  counterparty: string;
  acceptAmount: Decimal;
  escrowId: string;
};

/* ------------------------------------------------------------------ */
/*  Slay.P2P.P2PEscrow                                                 */
/* ------------------------------------------------------------------ */

export type P2PEscrowPayload = {
  operator: string;
  seller: string;
  buyer: string;
  orderId: string;
  escrowId: string;
  amount: Decimal;
  pricePerCc: string;
  currency: string;
  status: P2PStatus;
  createdAt: LedgerTimestamp;
};

export const P2PEscrowTemplate = {
  templateId: (env: Env): TemplateId =>
    slayTemplate(env, "Slay.P2P", "P2PEscrow"),
};

/* ------------------------------------------------------------------ */
/*  Slay.Reward.RewardOffer                                            */
/* ------------------------------------------------------------------ */

export type RewardOfferPayload = {
  operator: string;
  user: string;
  nonce: string;
  kind: RewardKind;
  amount: Decimal;
  reason: string;
  expiresAt: LedgerTimestamp;
  createdAt: LedgerTimestamp;
};

export const RewardOfferTemplate = {
  templateId: (env: Env): TemplateId =>
    slayTemplate(env, "Slay.Reward", "RewardOffer"),
};
