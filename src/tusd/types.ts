/**
 * tUSD integration — shared types.
 *
 * Slay holds + moves tUSD alongside CC and CBTC. tUSD is a Canton
 * Token-Standard asset on the shared DA "utilities" registry
 * (api.utilities.digitalasset.com), issued by the onrails tUSD admin
 * party. Slay never mints or burns — we just custody + transfer.
 *
 *   Units                    : smallest unit ("sat" for code symmetry).
 *   Stored as                : BIGINT in wallets.balance_tusd and on every
 *                              tUSD transaction row's `amount` field.
 *   Currency discriminator   : transactions.currency / bets.currency /
 *                              markets.currency ENUM ('CC' | 'CBTC' | 'TUSD').
 */

/** Canton Instrument Protocol identifier. Pair of (admin, id). */
export interface InstrumentId {
  /** Admin party that issues / governs the instrument. */
  admin: string;
  /** Instrument identifier string. For tUSD this is "tf-usdt". */
  id: string;
}

/** Resolved instrument metadata returned by the registry. */
export interface InstrumentMetadata {
  instrumentId: InstrumentId;
  /** Display name (e.g. "Canton Ether"). */
  name?: string;
  /** Display symbol (e.g. "tUSD"). */
  symbol?: string;
  /** Decimal places (10 for tUSD). */
  decimals: number;
  /** Daml package id the instrument's contracts live in. */
  packageId?: string;
  /** Free-form metadata the registry may include. */
  extra?: Record<string, unknown>;
}

/** Reference to an on-chain tUSD holding contract owned by a specific party. */
export interface TusdHolding {
  contractId: string;
  owner: string;
  /** Amount in smallest unit, parsed from the Daml Decimal payload. */
  amountSat: number;
}

/** Result of a successful tUSD transfer on chain.
 *
 *  Two-shape result because the TransferFactory can return either:
 *
 *    (a) Direct Holding — receiverHoldingCid is set, the tUSD is in the
 *        receiver's wallet immediately. `transferInstructionCid` is null.
 *
 *    (b) Two-phase TransferInstruction — `transferInstructionCid` is
 *        set, the tUSD sits in an unaccepted contract until the
 *        receiver exercises TransferInstruction_Accept (handled by
 *        tusd/accept-cron.ts on our side). `receiverHoldingCid` is null
 *        in this path.
 *
 *  Callers should treat (a) and (b) as both successes; distinguishing
 *  them only matters for tracking pending offers.
 */
export interface TusdTransferResult {
  /** The chain update id — proof of settlement. */
  updateId: string;
  /** New holding for the recipient. Null when the factory created a
   *  TransferInstruction instead (default two-phase mode). */
  receiverHoldingCid: string | null;
  /** Sender's change holding, if any (single-input transfers leave change). */
  senderChangeCid: string | null;
  /** Set when the factory chose the two-phase flow — receiver must
   *  exercise TransferInstruction_Accept to claim. Null when the
   *  transfer became a Holding directly. */
  transferInstructionCid: string | null;
}

/** ─── Unit conversion helpers ─────────────────────────────────────── */

/** Internal smallest-unit scale. Kept for code symmetry with CBTC. */
export const SAT_PER_TUSD = 100_000_000;

/** smallest unit → tUSD (decimal). */
export const satToTusd = (sat: number): number => sat / SAT_PER_TUSD;

/** tUSD (decimal) → smallest unit (integer). Rounds to nearest. */
export const tusdToSat = (tusd: number): number =>
  Math.round(tusd * SAT_PER_TUSD);
