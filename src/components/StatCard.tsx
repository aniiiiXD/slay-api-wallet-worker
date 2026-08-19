/**
 * A single headline figure.
 *
 * The `info` affordance is the point of this component, not decoration. These
 * cards sit side by side and look equally authoritative, but they are not
 * equally trustworthy: some read live from chain, some are stamped constants
 * from a date, some are estimates built on an assumed constant. A number that
 * cannot say where it came from teaches people to distrust the ones that can.
 *
 * `origin` renders that difference visibly — a live figure says so, a stamped
 * one says as-of-when, an estimate says it is one.
 */

export type Origin =
  | { kind: "live" }
  /** A constant, with the date it was stamped. */
  | { kind: "stamped"; asOf: string }
  /** Derived from an assumed constant — true of anything using EST_KB_PER_TX. */
  | { kind: "estimate" }
  /** No provenance claim: the value is simply what the account holds. */
  | { kind: "plain" }
  /**
   * The metric is specified but has no data source yet. Renders a dash and
   * names what it is waiting on.
   *
   * This exists so the UI can carry the full KPI set without inventing
   * numbers. A fixture that looks real teaches people to distrust the tiles
   * that ARE real — this repo deleted four pages for exactly that. An empty
   * tile that names its missing endpoint is also a better spec for whoever
   * builds it than a plausible number would be.
   */
  | { kind: "pending"; needs: string };

export function StatCard({
  label,
  value,
  unit,
  sub,
  info,
  origin = { kind: "plain" },
  tone,
  emphasis,
}: {
  label: string;
  value: string;
  /* `| undefined` on each optional: the project sets
     exactOptionalPropertyTypes, so "may be omitted" and "may be passed as
     undefined" are different contracts, and callers computing a tone from
     a sign need the second. */
  unit?: string | undefined;
  sub?: string | undefined;
  /** Explains what the number means and how it is derived. */
  info?: string | undefined;
  origin?: Origin | undefined;
  tone?: "green" | "red" | undefined;
  emphasis?: boolean | undefined;
}) {
  const badge =
    origin.kind === "live" ? (
      <span className="stat-origin live">
        <span className="stat-dot" />
        Live
      </span>
    ) : origin.kind === "stamped" ? (
      <span className="stat-origin stamped">as of {origin.asOf}</span>
    ) : origin.kind === "estimate" ? (
      <span className="stat-origin estimate">Estimate</span>
    ) : origin.kind === "pending" ? (
      <span className="stat-origin pending">Needs {origin.needs}</span>
    ) : null;

  return (
    <div className={`stat ${emphasis ? "stat-emphasis" : ""}`}>
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        {info ? (
          // Native title rather than a custom tooltip: it is keyboard and
          // screen-reader reachable for free, and this text is explanatory
          // rather than essential — nothing is hidden behind it.
          <span className="stat-info" tabIndex={0} role="note" aria-label={info} title={info}>
            i
          </span>
        ) : null}
      </div>
      <div
        className={`stat-value ${tone ? `tone-${tone}` : ""} ${
          origin.kind === "pending" ? "stat-pending" : ""
        }`}
      >
        {origin.kind === "pending" ? "—" : value}
        {unit && origin.kind !== "pending" ? <span className="stat-unit">{unit}</span> : null}
      </div>
      <div className="stat-foot">
        {sub ? <span className="stat-sub">{sub}</span> : null}
        {badge}
      </div>
    </div>
  );
}
