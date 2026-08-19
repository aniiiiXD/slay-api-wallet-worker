/**
 * CBTC integration — shared types.
 *
 * Slay holds + moves CBTC alongside CC. CBTC is a Canton Instrument Protocol
 * (CIP-56) token issued by BitSafe Finance, with 1:1 BTC backing handled by
 * the BitSafe Attestor network. Slay never mints or burns — we just custody
 * + transfer.
 *
 *   Units                    : satoshi (sat). 100_000_000 sat = 1 CBTC = 1 BTC
 *   Stored as                : BIGINT in wallets.balance_cbtc and on every
 *                              CBTC transaction row's `amount` field.
 *   Currency discriminator   : transactions.currency / bets.currency /
 *                              markets.currency ENUM ('CC' | 'CBTC').
 */

/** Canton Instrument Protocol identifier. Pair of (admin, id). */
export interface InstrumentId {
  /** Admin party that issues / governs the instrument. */
  admin: string;
  /** Instrument identifier string. For CBTC this is "CBTC". */
  id: string;
}

/** Resolved instrument metadata returned by the BitSafe registry. */
export interface InstrumentMetadata {
  instrumentId: InstrumentId;
  /** Display name (e.g. "Canton Bitcoin"). */
  name?: string;
  /** Display symbol (e.g. "CBTC"). */
  symbol?: string;
  /** Decimal places (8 for CBTC, matching BTC). */
  decimals: number;
  /** Daml package id the instrument's contracts live in. */
  packageId?: string;
  /** Free-form metadata BitSafe may include. */
  extra?: Record<string, unknown>;
}

/** Reference to an on-chain CBTC holding contract owned by a specific party. */
export interface CbtcHolding {
  contractId: string;
  owner: string;
  /** Amount in satoshi, parsed from the Daml Decimal payload. */
  amountSat: number;
}

/** Result of a successful CBTC transfer on chain.
 *
 *  Two-shape result because BitSafe's TransferFactory can return either:
 *
 *    (a) Direct Holding — receiverHoldingCid is set, the CBTC is in the
 *        receiver's wallet immediately. `transferInstructionCid` is null.
 *
 *    (b) Two-phase TransferInstruction — `transferInstructionCid` is
 *        set, the CBTC sits in an unaccepted contract until the
 *        receiver exercises TransferInstruction_Accept (handled by
 *        cbtc/accept-cron.ts on our side). `receiverHoldingCid` is null
 *        in this path.
 *
 *  Callers should treat (a) and (b) as both successes; distinguishing
 *  them only matters for tracking pending offers.
 */
export interface CbtcTransferResult {
  /** The chain update id — proof of settlement. */
  updateId: string;
  /** New holding for the recipient. Null when the factory created a
   *  TransferInstruction instead (BitSafe's default two-phase mode). */
  receiverHoldingCid: string | null;
  /** Sender's change holding, if any (single-input transfers leave change). */
  senderChangeCid: string | null;
  /** Set when the factory chose the two-phase flow — receiver must
   *  exercise TransferInstruction_Accept to claim. Null when the
   *  transfer became a Holding directly. */
  transferInstructionCid: string | null;
}

/** ─── Unit conversion helpers ─────────────────────────────────────── */

/** 1 CBTC = 100_000_000 sat. */
export const SAT_PER_CBTC = 100_000_000;

/** sat → CBTC (decimal). */
export const satToCbtc = (sat: number): number => sat / SAT_PER_CBTC;

/** CBTC (decimal) → sat (integer). Rounds to nearest sat. */
export const cbtcToSat = (cbtc: number): number =>
  Math.round(cbtc * SAT_PER_CBTC);
