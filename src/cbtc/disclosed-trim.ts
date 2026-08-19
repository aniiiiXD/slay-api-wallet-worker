/* ------------------------------------------------------------------ *
 *  cbtc/disclosed-trim.ts                                              *
 *                                                                      *
 *  Reduce the disclosed-contracts list before submitting a CBTC        *
 *  TransferFactory_Transfer / TransferInstruction_Accept command to    *
 *  the participant.                                                    *
 *                                                                      *
 *  Why                                                                 *
 *  ---                                                                 *
 *  The BitSafe registry's choice-context response ships back every     *
 *  contract that COULD be relevant (amulet-rules, open-mining-round,   *
 *  issuing-rounds, validator-rights, featured-app, the factory/TI      *
 *  itself, dependency Holdings, etc). Each entry's createdEventBlob is *
 *  multi-KB. The participant only needs disclosures referenced by the  *
 *  exercised choice — anything else just inflates the on-chain tx and  *
 *  the sequencer traffic cost (each disclosed contract = full create   *
 *  event embedded in the submission body and counted in trafficCost).  *
 *                                                                      *
 *  Observation that motivated this — mainnet 2026-06-19                *
 *  --------------------------------------------------------            *
 *  Outbound CBTC transfers were costing 9.2 KB per tx ($0.56). Inbound *
 *  accepts ~5.8 KB ($0.35). At synth-volume burn rates the validator's *
 *  traffic credit drained in under 24h, blocking unrelated ops         *
 *  (preapproval setup hit SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT).        *
 *                                                                      *
 *  Strategy                                                            *
 *  --------                                                            *
 *  Walk choiceContextData (recursively) and collect every string value *
 *  matching a Canton contract-id pattern. Plus mandatoryCids — the     *
 *  cid of the contract the choice is being exercised on (the factory   *
 *  for transfer, the TI for accept; they're not referenced inside      *
 *  choiceContextData but the participant requires them disclosed to    *
 *  interpret the exercise).                                            *
 *                                                                      *
 *  Filter the disclosed list to that referenced set. Anything else     *
 *  dropped.                                                            *
 *                                                                      *
 *  Risk                                                                *
 *  ----                                                                *
 *  The Daml interpreter might transitively reference a disclosed       *
 *  contract through interface dispatch — e.g. an OpenMiningRound       *
 *  referenced only by package name + identifier inside the choice      *
 *  body, never by cid in choiceContextData. If that happens, the       *
 *  participant errors with CONTRACT_NOT_FOUND on the missing cid and   *
 *  the trim was too aggressive. The flag CBTC_TRIM_DISCLOSED gates     *
 *  the behavior so we can flip it off without redeploying code if      *
 *  this regresses production.                                          *
 * ------------------------------------------------------------------ */

type DisclosedContract = {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
};

/**
 * Canton contract-id format: "00" + 136 hex chars (lowercase). Total 138
 * chars. Some explorers and SDKs emit them in mixed case; accept both.
 *
 * Length bound is permissive (120-200) so future format changes don't
 * silently miss matches — the "00" prefix is the strict signal.
 */
const CID_PATTERN = /^00[0-9a-fA-F]{120,200}$/;

function collectCidsFromValue(value: unknown, out: Set<string>): void {
  if (value == null) return;
  if (typeof value === "string") {
    if (CID_PATTERN.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectCidsFromValue(v, out);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectCidsFromValue(v, out);
    }
  }
}

export type TrimStats = {
  /** Disclosed contracts before trim. */
  before: number;
  /** Disclosed contracts after trim. */
  after: number;
  /** Sum of createdEventBlob length BEFORE trim (rough byte proxy). */
  bytesBefore: number;
  /** Sum of createdEventBlob length AFTER trim. */
  bytesAfter: number;
};

export type TrimResult = {
  trimmed: DisclosedContract[];
  stats: TrimStats;
};

/**
 * Filter `disclosed` down to entries whose contractId is either:
 *   • referenced (by direct string match) anywhere inside choiceContextData
 *   • listed in mandatoryCids (the contract being exercised on)
 *
 * Returns the trimmed list plus before/after counts and byte estimates
 * for log/measure purposes.
 *
 * NOTE: byte counts are estimates based on createdEventBlob string length.
 * The real on-chain byte cost includes templateId + cid + protocol overhead
 * per disclosure, so observed savings will exceed the bytesBefore/After
 * delta. Use this metric for trend tracking only.
 */
export function trimDisclosed(
  disclosed: DisclosedContract[],
  choiceContextData: unknown,
  mandatoryCids: string[] = []
): TrimResult {
  const referenced = new Set<string>(mandatoryCids);
  collectCidsFromValue(choiceContextData, referenced);

  const trimmed: DisclosedContract[] = [];
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const d of disclosed) {
    const blobLen = d.createdEventBlob?.length ?? 0;
    bytesBefore += blobLen;
    if (referenced.has(d.contractId)) {
      trimmed.push(d);
      bytesAfter += blobLen;
    }
  }

  return {
    trimmed,
    stats: {
      before: disclosed.length,
      after: trimmed.length,
      bytesBefore,
      bytesAfter,
    },
  };
}

/**
 * Conditional trim — applies trimDisclosed only if env.CBTC_TRIM_DISCLOSED
 * is "1". Otherwise returns the original list with stats showing no trim.
 * Always logs the would-have-been savings at INFO so we can compare
 * pre/post-flip traffic burn without redeploying.
 */
export function maybeTrimDisclosed(
  env: { CBTC_TRIM_DISCLOSED?: string; CBTC_DEBUG?: string },
  callerLabel: string,
  disclosed: DisclosedContract[],
  choiceContextData: unknown,
  mandatoryCids: string[] = []
): DisclosedContract[] {
  const { trimmed, stats } = trimDisclosed(disclosed, choiceContextData, mandatoryCids);
  const enabled = env.CBTC_TRIM_DISCLOSED === "1";

  // Per-tx log is gated on CBTC_DEBUG to avoid spamming wrangler tail.
  // Initial dry-run on mainnet (2026-06-19) showed kept=2/2 on every call
  // — BitSafe registry already ships minimal disclosures — so there's no
  // routine signal to surface. Flip CBTC_DEBUG=1 if you ever suspect the
  // registry started bundling extras (e.g. after a BitSafe upgrade).
  if (env.CBTC_DEBUG === "1") {
    const dropBytes = stats.bytesBefore - stats.bytesAfter;
    const pct =
      stats.bytesBefore > 0
        ? ((dropBytes / stats.bytesBefore) * 100).toFixed(1)
        : "0.0";
    console.log(
      `[cbtc/disclosed-trim] ${callerLabel} ${enabled ? "ON" : "off (dry-run)"} — ` +
        `kept=${stats.after}/${stats.before} ` +
        `blob_bytes=${stats.bytesAfter}/${stats.bytesBefore} ` +
        `dropped=${dropBytes}B (${pct}%)`
    );
  }

  return enabled ? trimmed : disclosed;
}
