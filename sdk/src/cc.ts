/**
 * CC decimal arithmetic, without floats.
 *
 * ── Why this module exists ───────────────────────────────────────────────
 * The honest version, because the usual pitch overstates it.
 *
 * `0.1 + 0.2 === 0.30000000000000004` is the famous example, and at CC's six
 * decimal places it does NOT actually bite: rounding the result back to
 * micro-CC recovers 300000, the right answer. Summing 0.000001 ten thousand
 * times still rounds back correctly too. For one arithmetic step on ordinary
 * amounts, floats mostly survive.
 *
 * They break in three places that are much less famous and much more likely:
 *
 *   1. PARSING. `parseFloat("1,000")` is `1`. Not an error — one. A
 *      thousand-CC transfer becomes a one-CC transfer, silently. `toMicro`
 *      throws instead.
 *
 *   2. ROUNDING FOR DISPLAY. `(1.005).toFixed(2)` is `"1.00"`, and
 *      `(8.575).toFixed(2)` is `"8.57"` — both round DOWN where a person
 *      expects up, because the stored double is a hair below the decimal.
 *      Fee and invoice code does this constantly.
 *
 *   3. MAGNITUDE. Past ~9,007,199,254 CC the micro value exceeds 2^53 and
 *      arithmetic drifts for real: 9007199254.740993 + 0.000001 lands two
 *      micro-CC away from the truth.
 *
 * So this is not "floats are always wrong". It is: the failures are silent,
 * they are in parsing and rounding rather than addition, and money is the
 * wrong place to find out which case you were in.
 *
 * Everything here works in BigInt over micro-CC, so none of the three apply.
 *
 * Everything works in BigInt over micro-CC (6 decimal places, matching the
 * ledger). Nothing here ever produces a `number`.
 */

/** A CC amount as a decimal string — `"3.5"`, `"87.105300"`, `"-3.000000"`. */
export type Cc = string;

const SCALE = 6;
const UNIT = 10n ** BigInt(SCALE);

/** Micro-CC. The ledger's own unit; exposed for callers who want integers. */
export type Micro = bigint;

const VALID = /^-?\d+(\.\d+)?$/;

/**
 * Decimal string → micro-CC.
 *
 * Throws on anything that is not a plain decimal. That includes `"1e3"`,
 * `"1,000"`, `NaN`, `Infinity` and the empty string — all of which
 * `parseFloat` would happily turn into a number, two of them silently wrong.
 */
export function toMicro(v: Cc): Micro {
  const s = String(v).trim();
  if (!VALID.test(s)) {
    throw new TypeError(
      `Not a decimal CC amount: ${JSON.stringify(v)}. ` +
        `Expected something like "3.5" — not a number, not exponent notation.`
    );
  }
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (frac.length > SCALE) {
    throw new RangeError(
      `CC has ${SCALE} decimal places; ${JSON.stringify(v)} has ${frac.length}. ` +
        `Round deliberately rather than letting the server do it for you.`
    );
  }
  const scaled = BigInt(whole + frac.padEnd(SCALE, "0"));
  return neg ? -scaled : scaled;
}

/** Micro-CC → decimal string, always with 6 places so output is stable. */
export function fromMicro(m: Micro): Cc {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / UNIT;
  const frac = (abs % UNIT).toString().padStart(SCALE, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export const add = (a: Cc, b: Cc): Cc => fromMicro(toMicro(a) + toMicro(b));
export const sub = (a: Cc, b: Cc): Cc => fromMicro(toMicro(a) - toMicro(b));

/** -1 if a < b, 0 if equal, 1 if a > b. Use this instead of `<` on strings —
 *  `"9" > "10"` is true for strings and false for money. */
export function compare(a: Cc, b: Cc): -1 | 0 | 1 {
  const x = toMicro(a);
  const y = toMicro(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const eq = (a: Cc, b: Cc) => compare(a, b) === 0;
export const gt = (a: Cc, b: Cc) => compare(a, b) === 1;
export const gte = (a: Cc, b: Cc) => compare(a, b) >= 0;
export const lt = (a: Cc, b: Cc) => compare(a, b) === -1;
export const lte = (a: Cc, b: Cc) => compare(a, b) <= 0;
export const isNegative = (a: Cc) => toMicro(a) < 0n;
export const isZero = (a: Cc) => toMicro(a) === 0n;
export const abs = (a: Cc): Cc => fromMicro(toMicro(a) < 0n ? -toMicro(a) : toMicro(a));

/**
 * Multiply by an integer count — for `price × quantity` style sums.
 *
 * Deliberately takes an integer rather than a decimal factor: multiplying two
 * decimals needs a rounding policy, and picking one silently on a caller's
 * behalf is how money goes missing a fraction at a time. If you need a
 * percentage, use `basisPoints`.
 */
export function times(a: Cc, n: number): Cc {
  if (!Number.isInteger(n)) {
    throw new TypeError(
      `times() takes an integer; got ${n}. For a fraction use basisPoints().`
    );
  }
  return fromMicro(toMicro(a) * BigInt(n));
}

/**
 * A basis-point share (1 bp = 0.01%), truncated toward zero.
 *
 * Truncation is stated rather than chosen quietly: rounding a fee up is
 * charging someone more than the rate says, and any policy that is not
 * written down turns into a support ticket.
 */
export function basisPoints(a: Cc, bps: number): Cc {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new TypeError(`basisPoints() takes a non-negative integer; got ${bps}.`);
  }
  return fromMicro((toMicro(a) * BigInt(bps)) / 10_000n);
}

/** Sum a list. Returns `"0.000000"` when empty rather than throwing. */
export const sum = (xs: readonly Cc[]): Cc =>
  fromMicro(xs.reduce<bigint>((acc, x) => acc + toMicro(x), 0n));

/**
 * Format for display. Trims trailing zeros to at least `minDecimals`, so a
 * balance reads "87.1053" rather than "87.105300".
 *
 * Display only — never feed the result back into the API. Round-tripping a
 * shortened string is safe here, but the habit of formatting-then-sending is
 * how a UI's rounding becomes a transfer's amount.
 */
export function format(a: Cc, minDecimals = 2): string {
  const [whole, frac = ""] = fromMicro(toMicro(a)).split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(minDecimals, "0");
  return trimmed ? `${whole}.${trimmed}` : whole!;
}
