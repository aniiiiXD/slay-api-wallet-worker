/**
 * Vendored-code drift detector.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * This repo is a deliberate fork. 24 files — including wallet/service.ts,
 * fees/send-fees.ts and db/schema.ts, roughly 4,000 lines of ledger code —
 * are copies of files that also live in slay-money-api and are still being
 * changed there.
 *
 * That was a considered trade: physical isolation from Slay's release cadence
 * in exchange for duplication. The known cost of that trade is DRIFT — a fix
 * lands upstream, nobody copies it here, and the two Workers quietly disagree
 * about how money moves. Silent drift in a money path is the worst outcome
 * available to this design, so it is made loud instead.
 *
 * Every vendored file is byte-identical to its upstream original at the moment
 * it was accepted, and VENDOR.json records the SHA-256 of both sides. This
 * script re-hashes and reports three cases, which need three different
 * responses:
 *
 *   UPSTREAM CHANGED  — someone edited slay-money-api. Read the diff and
 *                       decide whether it is a fix partners need. Then
 *                       `npm run drift:accept` after copying it across.
 *   LOCAL CHANGED     — someone edited the copy here. That is allowed, but it
 *                       must be intentional; from then on the file is ours.
 *   BOTH CHANGED      — the divergence this whole file exists to catch.
 *
 * Run it in `npm run verify`, and therefore before every deploy.
 *
 * `--accept` re-records current hashes. It is not a fix; it means "I have
 * looked at these and this repo is where I want it to be".
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "VENDOR.json");

/* Upstream location. Overridable because a CI checkout will not have it as a
 * sibling directory; if it is absent we say so rather than passing silently,
 * because a check that skips itself is worse than no check. */
const UPSTREAM =
  process.env.SLAY_UPSTREAM ?? resolve(root, "..", "slay-money-api-swap");

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (!existsSync(MANIFEST)) {
  console.error("✗ VENDOR.json is missing. Run: npm run drift:accept");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const accept = process.argv.includes("--accept");

if (!existsSync(UPSTREAM)) {
  console.error(`✗ Cannot find slay-money-api at ${UPSTREAM}`);
  console.error("  Set SLAY_UPSTREAM to its path, or check it out beside this repo.");
  console.error("  Refusing to pass: an unrun drift check is not a clean one.");
  process.exit(1);
}

const rows = [];
for (const entry of manifest.files) {
  const localPath = join(root, entry.path);
  const upstreamPath = join(UPSTREAM, entry.upstream ?? entry.path);

  if (!existsSync(localPath)) {
    rows.push({ path: entry.path, state: "MISSING LOCALLY" });
    continue;
  }
  const local = sha(localPath);
  const up = existsSync(upstreamPath) ? sha(upstreamPath) : null;

  if (accept) {
    entry.localSha = local;
    entry.upstreamSha = up;
    continue;
  }

  if (up === null) rows.push({ path: entry.path, state: "GONE UPSTREAM" });
  else {
    const localMoved = local !== entry.localSha;
    const upMoved = up !== entry.upstreamSha;
    if (localMoved && upMoved) rows.push({ path: entry.path, state: "BOTH CHANGED" });
    else if (upMoved) rows.push({ path: entry.path, state: "UPSTREAM CHANGED" });
    else if (localMoved) rows.push({ path: entry.path, state: "LOCAL CHANGED" });
  }
}

if (accept) {
  manifest.acceptedAt = new Date().toISOString();
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`✓ Recorded ${manifest.files.length} vendored files as accepted.`);
  process.exit(0);
}

if (rows.length === 0) {
  console.log(`✓ ${manifest.files.length} vendored files match slay-money-api.`);
  process.exit(0);
}

console.error(`\n  ${rows.length} vendored file(s) have moved:\n`);
for (const r of rows) console.error(`    ${r.state.padEnd(18)} ${r.path}`);
console.error(`
  UPSTREAM CHANGED   read the upstream diff. If partners need the fix, copy it
                     across, then: npm run drift:accept
  LOCAL CHANGED      intentional divergence — confirm, then accept it.
  BOTH CHANGED       reconcile by hand. Do not accept without reading both.

  Diff a file with:
    diff ${UPSTREAM}/src/wallet/service.ts src/wallet/service.ts
`);
process.exit(1);
