/**
 * Day-wise bar chart.
 *
 * Deliberately not the AreaChart: that one plots a continuous price series
 * where the line between two samples means something. A day's transaction
 * count is a discrete bucket — there is no value "between" Tuesday and
 * Wednesday, and drawing a slope across one implies a reading that was never
 * taken.
 *
 * Empty days are rendered as empty days rather than skipped. A gap is a fact
 * about the account; compressing it out makes a quiet week look busy.
 */

import { useMemo, useRef, useState } from "react";

export type DayBucket = {
  /** Local-midnight timestamp for the day. */
  t: number;
  /** Bar height. */
  v: number;
};

/** Bucket timestamps into local days, keeping empty days in the range. */
export function bucketByDay(times: number[], values: number[], days: number): DayBucket[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));

  const buckets = new Map<number, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    buckets.set(d.getTime(), 0);
  }

  times.forEach((ms, i) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + (values[i] ?? 0));
  });

  return [...buckets.entries()].map(([t, v]) => ({ t, v }));
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });

export function DayBars({
  data,
  format,
  label,
}: {
  data: DayBucket[];
  /** How a bar's value reads in the tooltip. */
  format: (v: number) => string;
  label: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const max = useMemo(() => Math.max(1, ...data.map((d) => d.v)), [data]);

  if (data.length === 0) {
    return <div className="chart-empty">No activity in this window.</div>;
  }

  const allZero = data.every((d) => d.v === 0);

  return (
    <div className="daybars" ref={wrapRef}>
      <div className="daybars-plot" role="img" aria-label={`${label} by day`}>
        {/* Three reference lines. Quiet on purpose — they are for reading a
            height, not for looking at. */}
        <div className="daybars-grid" aria-hidden="true">
          <span style={{ bottom: "100%" }} />
          <span style={{ bottom: "50%" }} />
          <span style={{ bottom: "0%" }} />
        </div>

        {data.map((d, i) => (
          <div
            key={d.t}
            className={`daybar ${hover === i ? "on" : ""}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className="daybar-fill"
              // A zero day gets a hairline rather than nothing: an invisible
              // bar is indistinguishable from a missing day.
              style={{ height: d.v === 0 ? "1px" : `${Math.max(2, (d.v / max) * 100)}%` }}
            />
            {hover === i ? (
              <div className="daybar-tip">
                <strong>{format(d.v)}</strong>
                <span>{DAY.format(new Date(d.t))}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="daybars-axis" aria-hidden="true">
        {data.map((d, i) =>
          // Every label collides at 30 days. Show roughly six.
          i % Math.ceil(data.length / 6) === 0 ? (
            <span key={d.t} style={{ left: `${(i / data.length) * 100}%` }}>
              {DAY.format(new Date(d.t))}
            </span>
          ) : null
        )}
      </div>

      {allZero ? (
        <div className="chart-note">Nothing recorded in this window — the axis is real, the bars are all zero.</div>
      ) : null}
    </div>
  );
}
