/**
 * Activity — the full transaction list, filterable, exportable.
 *
 * Direction is taken from the SIGN of `amountCc`, which the Worker sends as a
 * JSON number. Totals are summed from those numbers directly; no figure in
 * this file is ever read back out of a formatted string.
 */

import { useMemo, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { Notice, Spinner } from "../components/Notice";
import { useAsync } from "../components/useAsync";
import { wallet, type Transaction } from "../api";
import { TxRow } from "./Overview";
import { formatCc, humanizeType, isAmount, toIso } from "../format";

const PAGE_LIMIT = 250;

export function Activity({ onSignOut }: { onSignOut: () => void }) {
  const state = useAsync<Transaction[]>(() => wallet.transactions(PAGE_LIMIT));
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");

  const all = useMemo(() => state.data ?? [], [state.data]);

  const types = useMemo(() => {
    const seen = new Set<string>();
    for (const tx of all) if (tx.type) seen.add(tx.type);
    return Array.from(seen).sort();
  }, [all]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((tx) => {
      if (type !== "all" && tx.type !== type) return false;
      if (!q) return true;
      // Deliberately not matching against the amount: a text search that
      // compares "12.5" to a formatted "+12.50" is a coin flip, and parsing
      // the query as money to compare is exactly what we refuse to do.
      return (
        tx.id.toLowerCase().includes(q) ||
        tx.type.toLowerCase().includes(q) ||
        (tx.counterpartyHandle ?? "").toLowerCase().includes(q) ||
        (tx.memo ?? "").toLowerCase().includes(q) ||
        (tx.status ?? "").toLowerCase().includes(q)
      );
    });
  }, [all, query, type]);

  const totals = useMemo(() => {
    let inCc = 0;
    let outCc = 0;
    let unknown = 0;
    for (const tx of filtered) {
      if (!isAmount(tx.amountCc)) {
        unknown += 1;
        continue;
      }
      if (tx.amountCc > 0) inCc += tx.amountCc;
      else outCc += Math.abs(tx.amountCc);
    }
    return { inCc, outCc, net: inCc - outCc, unknown };
  }, [filtered]);

  if (state.loading) return <Spinner label="Loading transactions" />;
  if (state.error) {
    return (
      <ErrorState
        error={state.error}
        what="your transactions"
        onRetry={state.reload}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <div className="stack-lg">
      <header className="page-head">
        <div>
          <span className="eyebrow">Activity</span>
          <h1 className="display">Every transaction.</h1>
        </div>
        <button
          className="btn ghost inline"
          onClick={() => downloadCsv(filtered)}
          disabled={filtered.length === 0}
        >
          Export CSV
        </button>
      </header>

      <section className="totals">
        <div className="total">
          <span className="label">Money in</span>
          <span className="total-val pos">{formatCc(totals.inCc)} CC</span>
        </div>
        <div className="total">
          <span className="label">Money out</span>
          <span className="total-val neg">{formatCc(totals.outCc)} CC</span>
        </div>
        <div className="total">
          <span className="label">Net</span>
          <span className="total-val">{formatCc(totals.net)} CC</span>
        </div>
        <div className="total">
          <span className="label">Showing</span>
          <span className="total-val">
            {filtered.length}
            <span className="text-faint"> / {all.length}</span>
          </span>
        </div>
      </section>

      {totals.unknown > 0 ? (
        <p className="note text-faint">
          {totals.unknown} transaction{totals.unknown === 1 ? "" : "s"} had no usable amount and
          {totals.unknown === 1 ? " was" : " were"} left out of the totals.
        </p>
      ) : null}

      <section className="filters">
        <label className="field grow">
          <input
            type="search"
            placeholder="Filter by handle, memo, id, status…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="field select-field">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {humanizeType(t)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card">
        {all.length === 0 ? (
          <Notice tone="info" title="No transactions yet">
            <p>Once you move CC, the history shows up here.</p>
          </Notice>
        ) : filtered.length === 0 ? (
          <Notice tone="info" title="Nothing matches those filters">
            <p>
              {all.length} transaction{all.length === 1 ? "" : "s"} loaded, none matching. Clear
              the filter to see them all.
            </p>
          </Notice>
        ) : (
          <ul className="tx-list">
            {filtered.map((tx) => (
              <TxRow key={tx.id} tx={tx} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ──────────── CSV ──────────── */

const CSV_COLUMNS = [
  "id",
  "created_at",
  "type",
  "status",
  "counterparty",
  "memo",
  "amount_cc",
] as const;

/**
 * Quote a CSV cell, and defuse formula injection.
 *
 * A memo of `=HYPERLINK(...)` is a live formula the moment the export lands in
 * a spreadsheet, so text cells that open with a formula sigil get a leading
 * apostrophe. Numbers are written raw and unformatted — the export is data,
 * not a rendering, and a thousands separator would make the column unusable.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(txs: Transaction[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const tx of txs) {
    rows.push(
      [
        csvCell(tx.id),
        csvCell(toIso(tx.createdAt)),
        csvCell(tx.type),
        csvCell(tx.status),
        csvCell(tx.counterpartyHandle),
        csvCell(tx.memo),
        csvCell(isAmount(tx.amountCc) ? tx.amountCc : null),
      ].join(",")
    );
  }
  return rows.join("\r\n");
}

function downloadCsv(txs: Transaction[]): void {
  const blob = new Blob([toCsv(txs)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slay-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
