/**
 * Formatting helpers.
 *
 * Rule this file exists to enforce: money is never round-tripped through a
 * string. `amountCc` arrives from the Worker as a JSON number and stays a
 * number for every comparison, sum and sign test below. Nothing here parses a
 * formatted string back into a figure — `parseFloat("1,234.50")` returns 1 and
 * the bug is invisible until someone's totals are wrong. Formatting is a
 * one-way trip: number in, display string out.
 */

const CC_FMT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** True only for a real, finite JSON number. Guards against nulls in the wire data. */
export function isAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function formatCc(amount: unknown): string {
  if (!isAmount(amount)) return "—";
  return CC_FMT.format(amount);
}

/** Signed, for transaction rows: "+12.50" / "−12.50". */
export function formatCcSigned(amount: unknown): string {
  if (!isAmount(amount)) return "—";
  const sign = amount < 0 ? "−" : "+";
  return `${sign}${CC_FMT.format(Math.abs(amount))}`;
}

export function formatUsd(amount: unknown): string {
  if (!isAmount(amount)) return "—";
  return USD_FMT.format(amount);
}

/**
 * USD with the precision small numbers need. formatUsd's fixed 2dp turns the
 * $0.5626 marker value into "$0.56" and the $0.062 traffic price into
 * "$0.06" — rounding away exactly the digits those parameters exist to
 * carry. ≥$1 keeps the plain 2dp form.
 */
export function formatUsdFine(amount: unknown): string {
  if (!isAmount(amount)) return "—";
  if (Math.abs(amount) >= 1) return USD_FMT.format(amount);
  // Up to 4 significant decimals, trailing zeros trimmed.
  const s = amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${s}`;
}

/** CC → USD. Returns null when either side is missing rather than guessing 0. */
export function ccToUsd(cc: unknown, usdPerCc: unknown): number | null {
  if (!isAmount(cc) || !isAmount(usdPerCc)) return null;
  return cc * usdPerCc;
}

/** -1 / 0 / +1 by direct numeric comparison. Never a string test. */
export function amountDirection(amount: unknown): -1 | 0 | 1 {
  if (!isAmount(amount) || amount === 0) return 0;
  return amount < 0 ? -1 : 1;
}

/** Split a formatted CC figure so the decimals can be dimmed. */
export function splitAmount(amount: unknown): { whole: string; cents: string } {
  const s = formatCc(amount);
  const dot = s.lastIndexOf(".");
  if (dot === -1) return { whole: s, cents: "" };
  return { whole: s.slice(0, dot), cents: s.slice(dot) };
}

/* ──────────── Dates ──────────── */

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function toDate(value: string | number): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | number): string {
  const d = toDate(value);
  return d ? DATE_FMT.format(d) : "—";
}

/** ISO 8601 for CSV — machine-readable beats locale-pretty in an export. */
export function toIso(value: string | number): string {
  const d = toDate(value);
  return d ? d.toISOString() : "";
}

export function formatRelative(value: string | number): string {
  const d = toDate(value);
  if (!d) return "—";
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return DATE_FMT.format(d);
}

/** "market_bet" → "Market bet". */
export function humanizeType(type: string): string {
  const spaced = type.replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Transaction";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Trim a long id/party for display without pretending it is complete. */
export function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
