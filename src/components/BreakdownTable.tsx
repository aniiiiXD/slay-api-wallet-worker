/**
 * Breakdown table — the per-day chart numbers, in a form you can check.
 *
 * DayBars shows the shape of a window; this shows the figures. A bar 60% as
 * tall as its neighbour is not a number anyone can quote, reconcile against a
 * bank statement, or paste into a spreadsheet. That is what this is for, and
 * why it carries a CSV export rather than only a hover tooltip.
 *
 * ── Contract ──────────────────────────────────────────────────────────────
 *
 * Rows arrive pre-bucketed. This component never fetches and never decides
 * what a "day" is — the caller owns bucketing, exactly as it already does for
 * DayBars (`bucketByDay`). Weekly grouping IS done here, because it is a
 * re-fold of rows this component already holds, and a toggle that made the
 * page re-derive its data would put two sources of truth on screen.
 *
 * ── Adding a column ───────────────────────────────────────────────────────
 *
 * Add an optional field to `BreakdownRow` and one entry to `MEASURES`. Screen
 * header, cell, total, CSV header and CSV field all follow from that entry, so
 * no call site changes. Existing callers keep compiling because every added
 * field is optional.
 *
 * The one constraint: measures must be ADDITIVE, since weekly grouping and the
 * total row both sum them. A future average or ratio needs its own aggregator
 * rather than a sum, and the `Measure` type is where that would go.
 */

import { useMemo, useState } from "react";
import { formatCc, formatCcSigned, isAmount } from "../format";
import { csvFilename, downloadCsv, isoDay, toCsv, type CsvValue } from "../lib/csv";

/** One already-bucketed day. */
export type BreakdownRow = {
  /**
   * Local-midnight epoch ms for the day this row covers — the same `t` that
   * `bucketByDay` produces, so a row and a bar can be lined up by identity.
   */
  date: number;
  /** Transactions in the day, inbound and outbound. */
  txCount: number;
  /** Turnover: the sum of |amount|, so a busy day reads as busy. */
  volumeCc: number;
  /** Received. Positive. */
  inboundCc: number;
  /** Sent. Positive — a magnitude, not a signed amount. */
  outboundCc: number;
  /**
   * Optional. Defaults to `inboundCc − outboundCc`, which is what it should
   * be; supply it only when the caller has a truer figure (fees netted in,
   * say) than the subtraction gives.
   */
  netCc?: number | undefined;
};

export type Grouping = "daily" | "weekly";

export type BreakdownTableProps = {
  rows: readonly BreakdownRow[];
  /** Heading above the table. Omit for a bare table. */
  title?: string | undefined;
  /**
   * The window the rows were drawn from, as epoch ms. Only used for the CSV
   * filename and the empty state; defaults to the first and last row. Pass it
   * when the window is wider than the rows — an empty window has no rows to
   * infer a date from.
   */
  range?: { start: number; end: number } | undefined;
  /** Download filename stem. The window is appended. */
  filenameStem?: string | undefined;
  /** Which grouping the table opens on. */
  defaultGrouping?: Grouping | undefined;
};

/* ── Columns ───────────────────────────────────────────────────────────────
 *
 * `value` is the raw number: it drives the totals, the weekly sums AND the
 * CSV field, so the exported figure is by construction the same figure the
 * screen adds up. `format` is display only and never round-trips back into
 * arithmetic — the rule format.ts exists to enforce.
 */

type Measure = {
  key: string;
  /** Column header on screen. */
  label: string;
  /** Column header in the CSV. snake_case, unit-suffixed. */
  csvHeader: string;
  value: (row: BreakdownRow) => number;
  format: (total: number) => string;
  /** Optional green/red treatment, applied to cells and the total alike. */
  tone?: ((total: number) => "pos" | "neg" | "") | undefined;
};

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Non-numeric junk in a row counts as zero rather than poisoning the column
 *  with NaN. Same guard the rest of the app uses on wire amounts. */
const num = (v: unknown): number => (isAmount(v) ? v : 0);

const MEASURES: readonly Measure[] = [
  {
    key: "txCount",
    label: "Transactions",
    csvHeader: "transaction_count",
    value: (r) => num(r.txCount),
    format: (v) => INT.format(v),
  },
  {
    key: "volumeCc",
    label: "Volume (CC)",
    csvHeader: "volume_cc",
    value: (r) => num(r.volumeCc),
    format: formatCc,
  },
  {
    key: "inboundCc",
    label: "In (CC)",
    csvHeader: "inbound_cc",
    value: (r) => num(r.inboundCc),
    format: formatCc,
  },
  {
    key: "outboundCc",
    label: "Out (CC)",
    csvHeader: "outbound_cc",
    value: (r) => num(r.outboundCc),
    format: formatCc,
  },
  {
    key: "netCc",
    label: "Net (CC)",
    csvHeader: "net_cc",
    // The subtraction is the default rather than a stored field, so net can
    // never drift out of step with the two columns beside it.
    value: (r) => (r.netCc === undefined ? num(r.inboundCc) - num(r.outboundCc) : num(r.netCc)),
    format: formatCcSigned,
    tone: (v) => (v > 0 ? "pos" : v < 0 ? "neg" : ""),
  },
];

/* ── Grouping ──────────────────────────────────────────────────────────── */

/**
 * A contiguous run of rows shown as one line. `start`/`end` are the first and
 * last row actually present, not the nominal period bounds — a window that
 * begins mid-week should say "Jul 15 – Jul 19", not claim a Monday of data it
 * never had.
 */
type Period = {
  key: number;
  start: number;
  end: number;
  rows: BreakdownRow[];
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday, local time. */
function startOfWeek(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayOffset);
  return d.getTime();
}

/**
 * Fold rows into display periods. Daily folds by local day, which also merges
 * any two rows the caller handed over for the same date rather than silently
 * showing that date twice.
 */
function toPeriods(rows: readonly BreakdownRow[], grouping: Grouping): Period[] {
  const byKey = new Map<number, Period>();
  for (const row of rows) {
    const key = grouping === "weekly" ? startOfWeek(row.date) : startOfDay(row.date);
    const found = byKey.get(key);
    if (found) {
      found.rows.push(row);
      if (row.date < found.start) found.start = row.date;
      if (row.date > found.end) found.end = row.date;
    } else {
      byKey.set(key, { key, start: row.date, end: row.date, rows: [row] });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key - b.key);
}

function total(measure: Measure, rows: readonly BreakdownRow[]): number {
  let acc = 0;
  for (const row of rows) acc += measure.value(row);
  return acc;
}

/* ── Labels ────────────────────────────────────────────────────────────── */

const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const FULL_LABEL = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function periodLabel(p: Period, grouping: Grouping): string {
  if (grouping === "daily" || p.start === p.end) return DAY_LABEL.format(new Date(p.start));
  return `${DAY_LABEL.format(new Date(p.start))} – ${DAY_LABEL.format(new Date(p.end))}`;
}

/* ── Component ─────────────────────────────────────────────────────────── */

export function BreakdownTable({
  rows,
  title,
  range,
  filenameStem = "slay-activity",
  defaultGrouping = "daily",
}: BreakdownTableProps) {
  const [grouping, setGrouping] = useState<Grouping>(defaultGrouping);

  // Sorted once, defensively: the caller's order is not this component's
  // business, and weekly folding of an unsorted list would still be correct
  // but would render its periods in whatever order they first appeared.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.date - b.date),
    [rows]
  );

  const periods = useMemo(() => toPeriods(sorted, grouping), [sorted, grouping]);

  // "No activity" covers both no rows at all and a window of nothing but
  // zeroes. Thirty rows of 0.00 is not information; it is a table pretending
  // to be one, and it buries the one sentence the reader actually needs.
  const hasActivity = useMemo(
    () => MEASURES.some((m) => sorted.some((r) => m.value(r) !== 0)),
    [sorted]
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const windowStart = range?.start ?? first?.date ?? Date.now();
  const windowEnd = range?.end ?? last?.date ?? windowStart;

  if (!hasActivity) {
    return (
      <div className="breakdown">
        {title ? <h3 className="breakdown-title">{title}</h3> : null}
        <p className="breakdown-empty">
          No activity between {FULL_LABEL.format(new Date(windowStart))} and{" "}
          {FULL_LABEL.format(new Date(windowEnd))}. Nothing was sent or received in
          this window — there is nothing to break down.
        </p>
      </div>
    );
  }

  const onExport = () => {
    // The header and every field come from MEASURES, so the CSV cannot fall
    // out of step with the columns on screen.
    const headers = ["period_start", "period_end", ...MEASURES.map((m) => m.csvHeader)];
    const body: CsvValue[][] = periods.map((p) => [
      isoDay(p.start),
      isoDay(p.end),
      ...MEASURES.map((m) => total(m, p.rows)),
    ]);
    // The Total row is deliberately NOT exported. On screen it saves a reader
    // some addition; in a file it is a row that looks like data, so anyone who
    // selects the column and sums it gets double the true figure.
    downloadCsv(
      csvFilename(filenameStem, windowStart, windowEnd),
      toCsv(headers, body)
    );
  };

  const groupings: ReadonlyArray<{ id: Grouping; label: string }> = [
    { id: "daily", label: "Daily" },
    { id: "weekly", label: "Weekly" },
  ];

  return (
    <div className="breakdown">
      <div className="breakdown-head">
        {title ? <h3 className="breakdown-title">{title}</h3> : <span />}
        <div className="breakdown-actions">
          <div className="chart-toggles" role="group" aria-label="Group rows by">
            {groupings.map((g) => (
              <button
                key={g.id}
                type="button"
                aria-pressed={grouping === g.id}
                className={`chart-toggle ${grouping === g.id ? "active" : ""}`}
                onClick={() => setGrouping(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn ghost inline" onClick={onExport}>
            Export CSV
          </button>
        </div>
      </div>

      {/* The table scrolls inside this box. Six columns do not fit a phone,
          and a page that scrolls sideways loses the sidebar and the heading
          along with the overflow. */}
      <div className="breakdown-scroll" tabIndex={0} role="region" aria-label="Breakdown table">
        <table className="breakdown-table">
          <caption className="breakdown-caption">
            {grouping === "daily" ? "By day" : "By week (Mon–Sun)"} ·{" "}
            {periods.length} {periods.length === 1 ? "row" : "rows"}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="breakdown-date-col">
                {grouping === "daily" ? "Date" : "Week"}
              </th>
              {MEASURES.map((m) => (
                <th key={m.key} scope="col" className="num">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.key}>
                <th scope="row" className="breakdown-date-col">
                  <span title={FULL_LABEL.format(new Date(p.start))}>
                    {periodLabel(p, grouping)}
                  </span>
                </th>
                {MEASURES.map((m) => {
                  const v = total(m, p.rows);
                  return (
                    <td key={m.key} className={`num ${m.tone ? m.tone(v) : ""}`}>
                      {m.format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="breakdown-total">
              <th scope="row" className="breakdown-date-col">
                Total
                <span className="breakdown-total-sub">
                  {sorted.length} {sorted.length === 1 ? "day" : "days"}
                </span>
              </th>
              {MEASURES.map((m) => {
                const v = total(m, sorted);
                return (
                  <td key={m.key} className={`num ${m.tone ? m.tone(v) : ""}`}>
                    {m.format(v)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
