/**
 * CSV writing — RFC 4180 quoting plus a formula-injection guard.
 *
 * ── Why the guard exists ───────────────────────────────────────────────────
 *
 * Excel, Sheets, LibreOffice and Numbers all treat a cell whose text begins
 * with `=`, `+`, `-`, `@`, a tab or a carriage return as a FORMULA, not as
 * text. A memo of `=HYPERLINK("http://evil","click")` — or the classic
 * `=cmd|'/c calc'!A1` — runs the moment the export is opened. The memo is
 * user-supplied and arrives from the Worker verbatim, so an unguarded export
 * hands whoever wrote that memo a foothold on the machine of whoever opens
 * the spreadsheet.
 *
 * This is not hypothetical: a transaction memo can be any text the user
 * whose memo is `=SUM(A1:A9) formula-looking memo`. If that lands in a cell
 * without a leading apostrophe, this file is broken.
 *
 * ── Rules ──────────────────────────────────────────────────────────────────
 *
 * 1. TEXT cells that start with a sigil get a leading `'`, which every
 *    spreadsheet reads as "the rest of this cell is literal text".
 * 2. NUMBERS are never guarded and never formatted. `-42.5` legitimately
 *    starts with `-`; quoting or apostrophising it would turn a numeric
 *    column into text and make the export unsummable. Numbers are written
 *    raw — no thousands separators, no currency symbols. The export is data,
 *    not a rendering.
 * 3. Quoting happens only where RFC 4180 requires it (comma, double quote,
 *    CR or LF), with embedded quotes doubled.
 * 4. Rows are joined with CRLF, per RFC 4180.
 *
 * No UTF-8 BOM is emitted. It would help older Excel builds guess the
 * encoding, but it also corrupts the first header name for every naive
 * parser, and the `charset=utf-8` on the Blob covers the browser path.
 */

/** Everything a cell may hold. `null`/`undefined` both write an empty field. */
export type CsvValue = string | number | null | undefined;

/** RFC 4180: these characters force the field to be quoted. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * A formula sigil at the start of the cell. Leading whitespace is skipped
 * deliberately — a space in front of `=` is not reliable protection, because
 * some importers trim the field before deciding whether it is a formula.
 */
const FORMULA_LEAD = /^\s*[=+\-@]/;

/**
 * A cell that opens with a tab or carriage return, sigil or not. Excel treats
 * both as the start of a formula context, and they also break field alignment
 * for anything reading the file line by line.
 */
const CONTROL_LEAD = /^[\t\r]/;

/** True when `text` would be evaluated rather than displayed. Exported so a
 *  test — or a reviewer — can check the guard without exporting a file. */
export function isFormulaLike(text: string): boolean {
  return FORMULA_LEAD.test(text) || CONTROL_LEAD.test(text);
}

/**
 * One field, escaped and neutralised. See the header comment for the rules.
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";

  // Numbers go out raw. NaN/Infinity are not representable in a spreadsheet
  // as numbers, so they become blanks rather than the string "NaN", which
  // would poison the column's type.
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }

  const guarded = isFormulaLike(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * A complete CSV document: one header row, then one line per row.
 *
 * Headers run through the same escaping as the body — a column named
 * `-net (cc)` is just as executable as a memo.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[]
): string {
  const lines: string[] = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

/**
 * `YYYY-MM-DD` in LOCAL time.
 *
 * Not `toISOString().slice(0, 10)`: the day buckets these exports describe are
 * local-midnight timestamps, and UTC would file a bucket labelled "Aug 12" in
 * the row for Aug 11 for anyone west of Greenwich. `format.ts#toIso` stays the
 * right call for instants; this is the right call for days.
 */
export function isoDay(value: number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `slay-activity-2026-07-14-to-2026-08-12.csv`.
 *
 * The window is in the filename because these files end up in a downloads
 * folder next to five others, where "export.csv" tells you nothing.
 */
export function csvFilename(stem: string, start: number | Date, end: number | Date): string {
  // Anything that is not filename-safe becomes a hyphen; runs collapse.
  const safe = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  const from = isoDay(start);
  const to = isoDay(end);
  if (!from || !to) return `${safe}.csv`;
  return from === to ? `${safe}-${from}.csv` : `${safe}-${from}-to-${to}.csv`;
}

/**
 * Hand the CSV to the browser as a download.
 *
 * The object URL is revoked once the click has been dispatched. The revoke is
 * deferred by a tick rather than run inline: a few browsers snapshot the URL
 * asynchronously after the synthetic click, and revoking in the same statement
 * has historically produced empty files there.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    // Firefox only honours a synthetic click on an anchor that is in the
    // document, so the link is attached and removed rather than orphaned.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
