/**
 * Canton economics parameters — one home, imported by Overview and
 * Integrate so the two pages can never quote different numbers.
 *
 * These are Super Validator governance values, not market data: they move
 * only by on-ledger vote, rarely and publicly. Constants stamped with their
 * as-of date until the Worker's /api/stats Scan proxy serves them live
 * (the public Scan API 403s browsers, so a proxy is the only clean path).
 * Read from ccview.io + Splice docs.
 */

export const PARAMS_AS_OF = "Aug 7, 2026";

/** featuredAppActivityMarkerAmount — USD minted per CIP-0047 marker. */
export const MARKER_VALUE_USD = 0.5626;

/** Synchronizer traffic price, USD per KB, paid by burning CC. */
export const TRAFFIC_USD_PER_KB = 0.062;

/** Share of newly minted CC burned back via traffic purchases (network-wide). */
export const BURN_OFFSET_PCT = 70.1;

/** OpenMiningRound cadence, minutes. */
export const ROUND_MINUTES = 10;

/**
 * Estimated synchronizer bytes per transaction, KB.
 *
 * Source: the Worker's own accounting — its accept-cron budgets 5.8 KB per
 * CBTC TransferInstruction accept (see slay-money-api src/index.ts). A real
 * per-tx figure needs the Worker to aggregate its logged bodyBytes; until
 * then every number derived from this constant is labeled an estimate.
 */
export const EST_KB_PER_TX = 5.8;
