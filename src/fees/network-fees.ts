/* ------------------------------------------------------------------ *
 *  fees/network-fees.ts — Canton NETWORK fees (CC burnt on chain).     *
 *                                                                      *
 *  NOT Slay's product fees. Those live next door in send-fees.ts       *
 *  (`house_fee` rows) and refund-cron.ts (`chain_fee` rows, a FLAT     *
 *  1.8 CC estimate charged to the user and later refunded). This file  *
 *  is about the CC the Splice protocol actually destroys when we       *
 *  submit a transfer — money nobody receives.                          *
 *                                                                      *
 *  Why it has to be captured rather than computed                      *
 *  ---------------------------------------------                      *
 *  Burnt CC = a sum of fields on the exercise result's `summary`, and  *
 *  THE FIELD SET DIFFERS BY TRANSACTION TYPE (see FORMULAS below).     *
 *  `holdingFees` are only charged when the coin was held across a      *
 *  mining round, so two identical-looking transfers burn different     *
 *  amounts. There is no rate to multiply by. The only source of truth  *
 *  is the result the chain handed back, which every CC call site in    *
 *  this repo currently types as `unknown` and throws away.             *
 *                                                                      *
 *  Two rules this module exists to keep                                *
 *  ------------------------------------                                *
 *  1. NEVER fail or slow a transfer. These are live-money paths on     *
 *     MainNet. Every entry point here is try/catch'd end to end and    *
 *     returns null on any surprise; a fee we failed to record is a     *
 *     reporting gap, a transfer we failed to settle is a customer      *
 *     incident. The two are not close in cost.                         *
 *  2. NEVER let "not captured" look like "free". A missing row means   *
 *     UNKNOWN. Only a row with burnt_cc = 0 means the chain burned     *
 *     nothing. Hence NETWORK_FEE_CAPTURE_START below, and hence an     *
 *     unrecognised choice returns null rather than 0.                  *
 *                                                                      *
 *  Everything is parsed defensively out of `unknown`. These payloads   *
 *  cross scan-proxy, our participant's JSON API and a Daml JSON        *
 *  encoder, none of which we control or version — a renamed or moved   *
 *  field must degrade to "not captured", never throw into the transfer *
 *  path.                                                               *
 * ------------------------------------------------------------------ */

import type { Env } from "../env";

/* ------------------------------------------------------------------ */
/*  Capture start — the instant before which every row is UNKNOWN       */
/* ------------------------------------------------------------------ */

/**
 * When network-fee capture went live. A `transactions` row older than this
 * with no chain_update_id is UNKNOWN, **not free** — we simply weren't
 * recording yet, and an old ledger-only row is indistinguishable from an
 * old chain row whose update id we never kept.
 *
 * Stamped, not computed: `now()` would silently reclassify history every
 * time it is read. Overridable via a NETWORK_FEE_CAPTURE_START env var
 * (ISO-8601) for the case where the deploy slips well past this date and
 * ops wants the honest instant — the fallback is deliberately the earliest
 * moment capture *could* have been true, so err by widening UNKNOWN.
 */
export const NETWORK_FEE_CAPTURE_START = "2026-08-13T00:00:00.000Z";

/** NETWORK_FEE_CAPTURE_START as a Date, env override applied if parseable. */
export function networkFeeCaptureStart(env: Env): Date {
  const raw = envVar(env, "NETWORK_FEE_CAPTURE_START");
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date(NETWORK_FEE_CAPTURE_START);
}

/**
 * Capture is on unless explicitly switched off. Read off `env` positionally
 * rather than through the `Env` type because the kill switch has to work
 * without a redeploy of the type: set NETWORK_FEE_CAPTURE=0 as a secret and
 * every call site here goes quiet on the next request.
 */
export function networkFeeCaptureEnabled(env: Env): boolean {
  const raw = envVar(env, "NETWORK_FEE_CAPTURE");
  return raw !== "0" && raw !== "false";
}

function envVar(env: Env, key: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/* ------------------------------------------------------------------ */
/*  The formulas                                                        */
/*                                                                      */
/*  Per the Splice docs, burnt CC per transaction type. These are the    */
/*  ONLY choices we know how to price; anything else returns null so it  */
/*  reads as UNKNOWN rather than as a free transaction.                  */
/* ------------------------------------------------------------------ */

const FORMULAS: Readonly<Record<string, readonly string[]>> = {
  // The main CC path — transferAmulet / mergeAmulets.
  AmuletRules_Transfer: ["holdingFees", "outputFees", "senderChangeFee"],
  // External sends. The root result is a TransferPreapproval_SendResult
  // wrapping (or siblinged by) the TransferResult, so the fields are found
  // by search rather than at a fixed path — same three fields either way.
  TransferPreapproval_Send: ["holdingFees", "outputFees", "senderChangeFee"],
  // Sequencer traffic top-ups. Submitted by the validator-app container,
  // not by this Worker — present for a history walk, and because omitting
  // it from a lifetime burn total would be badly wrong (the 2026-07-04
  // runaway-topup incident alone was ~$1K of CC).
  AmuletRules_BuyMemberTraffic: ["holdingFees", "senderChangeFee", "amuletPaid"],
  // Per-user onboarding cost, ~0.5 CC for a 90-day window. The docs are
  // explicit that outputFee is NOT already inside amuletPaid.
  AmuletRules_CreateTransferPreapproval: ["amuletPaid", "outputFee"],
  // CNS entry purchase / renewal. No Worker path today; walk-only.
  AnsRules_CollectInitialEntryPayment: ["amuletPaid"],
  AnsRules_CollectEntryRenewalPayment: ["amuletPaid"],
} as const;

/**
 * Accepted spellings per field, tried in order, FIRST MATCH WINS (so an
 * alias can never double-count). The pair below is not hypothetical: the
 * transfer summary carries `outputFees` as a LIST — one entry per transfer
 * output — while the docs name the pre-approval field `outputFee`,
 * singular. Rather than bet on which spelling a given result type uses,
 * accept either and sum whatever shape turns up.
 */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  outputFees: ["outputFees", "outputFee"],
  outputFee: ["outputFee", "outputFees"],
};

function aliasesFor(field: string): readonly string[] {
  return FIELD_ALIASES[field] ?? [field];
}

/** Fields worth keeping for context even though they aren't burn. */
const CONTEXT_FIELDS = ["amuletPrice", "round"] as const;

/** Every field name we look for in one pass over the result. */
const ALL_FIELDS: readonly string[] = Array.from(
  new Set([
    ...Object.values(FORMULAS)
      .flat()
      .flatMap((f) => aliasesFor(f)),
    ...CONTEXT_FIELDS,
  ])
);

export type BurntFee = {
  /** Which formula was applied — stored so the total is re-derivable. */
  choice: string;
  /** The total, decimal CC as a 10-dp string. Never a JS number: the
   *  string goes straight into numeric(28,10). */
  burntCc: string;
  /** Raw `summary` object when we found one, else the raw exercise result.
   *  Kept verbatim for re-derivation if a field set turns out wrong. */
  summary: Record<string, unknown> | null;
  /** Formula fields actually present on this result. */
  found: string[];
  /** Formula fields we expected and did not find. Non-empty means the
   *  total is a floor, not the truth — worth alerting on, and the reason
   *  the raw summary is stored. */
  missing: string[];
  /** USD/CC at chain time, if the summary carried it. */
  amuletPrice: string | null;
  /** Mining round, if the result carried it. */
  round: number | null;
};

/* ------------------------------------------------------------------ */
/*  Decimal arithmetic — exact, at Daml's 10 fractional digits          */
/*                                                                      */
/*  Daml Decimals arrive as JSON strings with 10 dp. Summing them as    */
/*  JS numbers reintroduces exactly the rounding this table exists to   */
/*  avoid (0.1 + 0.2 ≠ 0.3), so we scale to integers and use BigInt.    */
/* ------------------------------------------------------------------ */

const SCALE = 10;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;

/** Parse a Daml Decimal (string, or a number if some encoder unquoted it)
 *  into a bigint scaled by 10^10. null when it isn't a decimal at all. */
function parseDecimal(v: unknown): bigint | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return parseDecimal(v.toFixed(SCALE));
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > 40 || !DECIMAL_RE.test(s)) return null;
  const negative = s.startsWith("-");
  const body = s.replace(/^[+-]/, "");
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracRaw = dot === -1 ? "" : body.slice(dot + 1);
  // Truncate rather than round past 10 dp: the chain never sends more, and
  // inventing a rounding rule here would be a silent second source of truth.
  const frac = (fracRaw + "0".repeat(SCALE)).slice(0, SCALE);
  try {
    const scaled = BigInt(intPart) * SCALE_FACTOR + BigInt(frac);
    return negative ? -scaled : scaled;
  } catch {
    return null;
  }
}

/** Format a scaled bigint back to a fixed 10-dp decimal string. */
function formatDecimal(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(SCALE, "0")}`;
}

/**
 * Sum one field's value. `outputFees` is a LIST (one entry per transfer
 * output) while the others are scalars, and a defensive reader shouldn't
 * care which is which — so anything array-shaped is summed elementwise.
 * Returns null when nothing in the value parsed as a decimal, which is how
 * "field present but unreadable" stays distinct from "field is zero".
 */
function sumDecimalValue(v: unknown, depth = 0): bigint | null {
  if (Array.isArray(v)) {
    if (depth > 2) return null;
    let total = 0n;
    let any = false;
    for (const item of v) {
      const part = sumDecimalValue(item, depth + 1);
      if (part !== null) {
        total += part;
        any = true;
      }
    }
    return any ? total : null;
  }
  return parseDecimal(v);
}

/* ------------------------------------------------------------------ */
/*  Defensive deep-get                                                  */
/*                                                                      */
/*  We do not know the exact nesting. AmuletRules_Transfer puts the      */
/*  summary at result.summary; TransferPreapproval_Send returns a        */
/*  wrapper whose TransferResult may sit at .transferResult, at .result, */
/*  or on a child exercise node we can't see from here (ledger.ts's      */
/*  exercise() matches the ROOT node only). Rather than guess a path,    */
/*  do one bounded breadth-first pass and take the SHALLOWEST occurrence */
/*  of each field name — shallowest because the outer result is always   */
/*  closer to the fee-bearing summary than any unrelated subtree is.     */
/*                                                                      */
/*  Bounded on purpose: this runs inside a live transfer, on a payload   */
/*  we don't control. A pathological result must cost microseconds, not  */
/*  the Worker's CPU budget.                                            */
/* ------------------------------------------------------------------ */

const MAX_NODES = 400;
const MAX_DEPTH = 8;

type Probe = {
  fields: Map<string, unknown>;
  summary: Record<string, unknown> | null;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One BFS over the result collecting (a) the shallowest value for each
 * wanted field name and (b) the shallowest object sitting under a
 * `summary` key. Never throws, whatever the payload looks like.
 */
function probe(root: unknown, wanted: readonly string[]): Probe {
  const fields = new Map<string, unknown>();
  let summary: Record<string, unknown> | null = null;
  const want = new Set(wanted);
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let seen = 0;

  while (queue.length > 0 && seen < MAX_NODES) {
    const head = queue.shift();
    if (!head) break;
    const { node, depth } = head;
    if (depth > MAX_DEPTH) continue;
    seen++;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (isPlainObject(item) || Array.isArray(item)) {
          queue.push({ node: item, depth: depth + 1 });
        }
      }
      continue;
    }
    if (!isPlainObject(node)) continue;

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (want.has(key) && !fields.has(key)) fields.set(key, value);
      if (key === "summary" && summary === null && isPlainObject(value)) {
        summary = value;
      }
      if (isPlainObject(value) || Array.isArray(value)) {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  return { fields, summary };
}

/* ------------------------------------------------------------------ */
/*  Compute                                                             */
/* ------------------------------------------------------------------ */

/**
 * Apply the type-specific formula to a raw exercise result.
 *
 * Returns null — meaning UNKNOWN, never "free" — when the choice has no
 * known formula, when the result isn't an object, or when not one of the
 * formula's fields could be read. Returns a BurntFee with a non-empty
 * `missing` when only some fields were found: that total is a floor, and
 * the raw summary is stored so it can be recomputed later.
 *
 * Pure and total: no I/O, no throw. The history walker can reuse it as-is.
 */
export function computeBurntFee(choice: string, exerciseResult: unknown): BurntFee | null {
  try {
    const formula = FORMULAS[choice];
    if (!formula) return null;
    if (!isPlainObject(exerciseResult) && !Array.isArray(exerciseResult)) return null;

    const { fields, summary } = probe(exerciseResult, ALL_FIELDS);

    let total = 0n;
    const found: string[] = [];
    const missing: string[] = [];
    for (const field of formula) {
      let part: bigint | null = null;
      let hit = field;
      for (const alias of aliasesFor(field)) {
        if (!fields.has(alias)) continue;
        const parsed = sumDecimalValue(fields.get(alias));
        if (parsed === null) continue;
        part = parsed;
        hit = alias;
        break;
      }
      if (part === null) {
        missing.push(field);
        continue;
      }
      total += part;
      found.push(hit);
    }
    if (found.length === 0) return null;

    const priceRaw = fields.get("amuletPrice");
    const price = parseDecimal(priceRaw);
    const roundRaw = fields.get("round");
    return {
      choice,
      burntCc: formatDecimal(total),
      // Prefer the raw summary; fall back to the whole result so a payload
      // whose shape moved is still re-derivable from what we stored.
      summary: summary ?? (isPlainObject(exerciseResult) ? exerciseResult : null),
      found,
      missing,
      amuletPrice: price === null ? null : formatDecimal(price),
      round: coerceRound(roundRaw),
    };
  } catch {
    // A parse bug here must never surface in a transfer. UNKNOWN is a
    // reporting gap; a thrown error is a failed send.
    return null;
  }
}

/** Mining round numbers arrive as a plain string/number on some results
 *  and wrapped as `{ number: "12" }` on others. Anything else → null. */
function coerceRound(v: unknown): number | null {
  const raw = isPlainObject(v) ? v["number"] : v;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/*  Record                                                              */
/* ------------------------------------------------------------------ */

export type RecordNetworkFeeInput = {
  /** Chain update id — the primary key. Nothing is written without one:
   *  a fee we can't attribute to a chain transaction can't be deduped,
   *  and double-counting burn is worse than missing it. */
  updateId: string | null | undefined;
  /** The Daml choice exercised, e.g. "AmuletRules_Transfer". */
  choice: string;
  /** Raw `exerciseResult` from canton/ledger.ts's exercise(). */
  exerciseResult: unknown;
  senderParty?: string | null | undefined;
  receiverParty?: string | null | undefined;
  /** Attribution for burns with no transactions row (merges, sweeps). */
  refType?: string | null | undefined;
  refId?: string | null | undefined;
  /** Chain record time when the caller has it. Live capture doesn't —
   *  exercise() surfaces only the update id — so it stamps observation
   *  time, which is within seconds of the chain's. */
  effectiveAt?: Date | null | undefined;
  /** 'live' from a submit response, 'walk' from a history walk. */
  source?: "live" | "walk" | undefined;
};

/**
 * Compute the burn for one exercise result and record it, one row per
 * chain transaction, ON CONFLICT DO NOTHING.
 *
 * NEVER THROWS and never rejects. Call sites are live money paths: this
 * awaits one Neon round trip (≈1 subrequest — transferAmulet's budget note
 * accounts for ~47 of 50, so this fits) and swallows everything that goes
 * wrong. Returns the computed fee so a caller can attach it to its own
 * result even when the write failed.
 */
export async function recordNetworkFee(
  env: Env,
  input: RecordNetworkFeeInput
): Promise<BurntFee | null> {
  let fee: BurntFee | null = null;
  try {
    if (!networkFeeCaptureEnabled(env)) return null;

    fee = computeBurntFee(input.choice, input.exerciseResult);
    if (!fee) {
      if (env.SPLICE_DEBUG === "1") {
        console.log(
          `[network-fee] no summary for choice=${input.choice} ` +
            `update=${(input.updateId ?? "?").slice(0, 24)}… — recorded as UNKNOWN`
        );
      }
      return null;
    }

    const updateId = typeof input.updateId === "string" ? input.updateId.trim() : "";
    if (!updateId) {
      console.warn(
        `[network-fee] burnt ${fee.burntCc} CC on ${input.choice} but the tree ` +
          `carried no updateId — not recorded (no key to dedupe on)`
      );
      return fee;
    }

    const { createDb, schema } = await import("../db");
    const db = createDb(env.DATABASE_URL);
    await db
      .insert(schema.cantonTxFees)
      .values({
        updateId,
        choice: fee.choice,
        burntCc: fee.burntCc,
        summary: fee.summary,
        round: fee.round,
        amuletPrice: fee.amuletPrice,
        senderParty: input.senderParty ?? null,
        receiverParty: input.receiverParty ?? null,
        effectiveAt: input.effectiveAt ?? new Date(),
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        source: input.source ?? "live",
      })
      // A chain transaction burns what it burns, once. A retry, a second
      // capture path or the backfill walker meeting the live writer must
      // never add a second row for the same update id.
      .onConflictDoNothing({ target: schema.cantonTxFees.updateId });

    if (env.SPLICE_DEBUG === "1") {
      console.log(
        `[network-fee] ${input.choice} update=${updateId.slice(0, 24)}… ` +
          `burnt=${fee.burntCc} CC fields=${fee.found.join("+") || "none"}` +
          (fee.missing.length > 0 ? ` missing=${fee.missing.join(",")}` : "")
      );
    }
    if (fee.missing.length > 0) {
      // The total is a floor, not the truth. Loud enough to notice, quiet
      // enough not to page: the raw summary is stored, so it's recoverable.
      console.warn(
        `[network-fee] ${input.choice} missing fields ${fee.missing.join(",")} — ` +
          `burnt_cc=${fee.burntCc} is a FLOOR. Recompute from the stored summary.`
      );
    }
    return fee;
  } catch (err) {
    console.warn(
      `[network-fee] capture failed (transfer unaffected): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return fee;
  }
}
