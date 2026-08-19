/**
 * HECTO integration — shared types.
 *
 * Slay holds + moves HECTO alongside CC and CBTC. HECTO is a Canton
 * Token-Standard asset on the shared DA "utilities" registry
 * (api.utilities.digitalasset.com), issued by the onrails HECTO admin
 * party. Slay never mints or burns — we just custody + transfer.
 *
 *   Units                    : smallest unit ("sat" for code symmetry).
 *   Stored as                : BIGINT in wallets.balance_hecto and on every
 *                              HECTO transaction row's `amount` field.
 *   Currency discriminator   : transactions.currency / bets.currency /
 *                              markets.currency ENUM ('CC' | 'CBTC' | 'HECTO').
 */

/** Canton Instrument Protocol identifier. Pair of (admin, id). */
export interface InstrumentId {
  /** Admin party that issues / governs the instrument. */
  admin: string;
  /** Instrument identifier string. For HECTO this is "HECTO". */
  id: string;
}

/** Resolved instrument metadata returned by the registry. */
export interface InstrumentMetadata {
  instrumentId: InstrumentId;
  /** Display name (e.g. "Canton Ether"). */
  name?: string;
  /** Display symbol (e.g. "HECTO"). */
  symbol?: string;
  /** Decimal places (10 for HECTO). */
  decimals: number;
  /** Daml package id the instrument's contracts live in. */
  packageId?: string;
  /** Free-form metadata the registry may include. */
  extra?: Record<string, unknown>;
}

/** Reference to an on-chain HECTO holding contract owned by a specific party. */
export interface HectoHolding {
  contractId: string;
  owner: string;
  /** Amount in smallest unit, parsed from the Daml Decimal payload. */
  amountSat: number;
}

/** Result of a successful HECTO transfer on chain.
 *
 *  Two-shape result because the TransferFactory can return either:
 *
 *    (a) Direct Holding — receiverHoldingCid is set, the HECTO is in the
 *        receiver's wallet immediately. `transferInstructionCid` is null.
 *
 *    (b) Two-phase TransferInstruction — `transferInstructionCid` is
 *        set, the HECTO sits in an unaccepted contract until the
 *        receiver exercises TransferInstruction_Accept (handled by
 *        hecto/accept-cron.ts on our side). `receiverHoldingCid` is null
 *        in this path.
 *
 *  Callers should treat (a) and (b) as both successes; distinguishing
 *  them only matters for tracking pending offers.
 */
export interface HectoTransferResult {
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
export const SAT_PER_HECTO = 100_000_000;

/** smallest unit → HECTO (decimal). */
export const satToHecto = (sat: number): number => sat / SAT_PER_HECTO;

/** HECTO (decimal) → smallest unit (integer). Rounds to nearest. */
export const hectoToSat = (hecto: number): number =>
  Math.round(hecto * SAT_PER_HECTO);
