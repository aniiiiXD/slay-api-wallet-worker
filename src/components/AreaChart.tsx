/**
 * Single-series area chart, hand-rolled SVG. No chart library — the app has
 * two runtime dependencies and this is not a reason for a third.
 *
 * Follows the dataviz method:
 *   - one series → no legend box; the card title names it
 *   - 2px line, area as a low-alpha wash of the same hue, recessive grid
 *   - series color #7ba315 — validated (OKLCH L in the dark band, ≥3:1
 *     against --surface) with the palette script, not eyeballed. The UI
 *     accent --accent is too light to be a mark color; text stays in text
 *     tokens, never the series color.
 *   - hover layer is not optional: crosshair + nearest-point dot + tooltip
 */

import { useMemo, useRef, useState } from "react";

export type ChartPoint = { t: number; p: number };

const W = 720; // viewBox units — scales to container width
const H = 220;
const PAD = { top: 12, right: 8, bottom: 22, left: 46 };

/**
 * Series color lives in CSS (--chart-series) so light mode can swap it:
 * #7ba315 passes the dark-surface checks, #6f9412 the light-surface ones —
 * both validated with the palette script. SVG presentation attributes can't
 * read var(), so color is applied via style objects.
 */
const SERIES_STYLE = { stroke: "var(--chart-series)" } as const;
const DOT_STYLE = { fill: "var(--chart-series)", stroke: "var(--surface)" } as const;

function fmtUsd(p: number): string {
  return `$${p.toFixed(p < 0.5 ? 4 : 2)}`;
}

function fmtTime(t: number, window: "24h" | "7d"): string {
  const d = new Date(t);
  return window === "24h"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function AreaChart({
  points,
  window,
}: {
  points: ChartPoint[];
  window: "24h" | "7d";
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null); // index into points

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t;
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const pt of points) {
      if (pt.p < pMin) pMin = pt.p;
      if (pt.p > pMax) pMax = pt.p;
    }
    // Pad the y-range 6% so the line doesn't kiss the frame; guard the
    // flat-series case where min === max.
    const span = pMax - pMin || pMax * 0.02 || 1;
    pMin -= span * 0.06;
    pMax += span * 0.06;

    const x = (t: number) =>
      PAD.left + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.left - PAD.right);
    const y = (p: number) =>
      PAD.top + (1 - (p - pMin) / (pMax - pMin)) * (H - PAD.top - PAD.bottom);

    const line = points
      .map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`)
      .join("");
    const area =
      line +
      `L${x(t1).toFixed(1)},${H - PAD.bottom}L${x(t0).toFixed(1)},${H - PAD.bottom}Z`;

    // Three horizontal gridlines with y-axis labels; first/mid/last x labels.
    const yTicks = [0.1, 0.5, 0.9].map((f) => {
      const p = pMin + (1 - f) * (pMax - pMin);
      return { yPx: PAD.top + f * (H - PAD.top - PAD.bottom), p };
    });
    const xTicks = [0, Math.floor(points.length / 2), points.length - 1].map(
      (i) => ({ xPx: x(points[i]!.t), t: points[i]!.t })
    );

    return { x, y, line, area, yTicks, xTicks };
  }, [points]);

  if (!geom) {
    return <div className="chart-empty">No chart data for this window.</div>;
  }

  const onMove = (e: React.MouseEvent) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const frac = (e.clientX - box.left) / box.width;
    const xu = frac * W;
    // Nearest point by x — points are evenly spaced enough for index math,
    // but scan defensively since upstream gaps happen.
    let best = 0;
    let bestD = Infinity;
    points.forEach((pt, i) => {
      const d = Math.abs(geom.x(pt.t) - xu);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  const hp = hover !== null ? points[hover] : null;
  const tipLeftPct = hp ? (geom.x(hp.t) / W) * 100 : 0;

  return (
    <div
      ref={wrapRef}
      className="chart-wrap"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="chart-svg"
        role="img"
        aria-label="Canton Coin price chart"
      >
        <defs>
          <linearGradient id="ccArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--chart-series)" }} stopOpacity="0.26" />
            <stop offset="100%" style={{ stopColor: "var(--chart-series)" }} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {geom.yTicks.map((tk) => (
          <g key={tk.yPx}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={tk.yPx}
              y2={tk.yPx}
              className="chart-grid"
            />
            <text x={PAD.left - 6} y={tk.yPx + 3} className="chart-tick" textAnchor="end">
              {fmtUsd(tk.p)}
            </text>
          </g>
        ))}

        <path d={geom.area} fill="url(#ccArea)" />
        <path d={geom.line} fill="none" style={SERIES_STYLE} strokeWidth="2" vectorEffect="non-scaling-stroke" />

        {geom.xTicks.map((tk, i) => (
          <text
            key={tk.xPx}
            x={tk.xPx}
            y={H - 6}
            className="chart-tick"
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          >
            {fmtTime(tk.t, window)}
          </text>
        ))}

        {hp ? (
          <g>
            <line
              x1={geom.x(hp.t)}
              x2={geom.x(hp.t)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              className="chart-crosshair"
            />
            <circle cx={geom.x(hp.t)} cy={geom.y(hp.p)} r="4" style={DOT_STYLE} strokeWidth="2" />
          </g>
        ) : null}
      </svg>

      {hp ? (
        <div
          className="chart-tip"
          style={{
            left: `${tipLeftPct}%`,
            transform: `translateX(${tipLeftPct > 82 ? "-100%" : tipLeftPct < 12 ? "0" : "-50%"})`,
          }}
        >
          <span className="chart-tip-val">{fmtUsd(hp.p)}</span>
          <span className="chart-tip-t">
            {new Date(hp.t).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
