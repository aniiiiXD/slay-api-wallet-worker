/**
 * openapi.yaml → src/docs/spec.gen.ts
 *
 * The Worker cannot read the filesystem at runtime and we do not want a YAML
 * parser in the bundle, so the spec is compiled to a TS module at build time.
 * `openapi.yaml` stays the single source of truth; this file is generated and
 * should never be hand-edited.
 *
 *   npm run docs:gen     regenerate
 *   npm run docs:check   fail if the committed copy is stale
 *
 * The check exists because the generated file is committed — deploy must not
 * depend on the generator having been run — and a committed artefact that can
 * silently drift from its source is worse than no artefact at all.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "openapi.yaml");
const OUT = join(root, "src", "docs", "spec.gen.ts");

const spec = parse(readFileSync(SRC, "utf8"));

/* Cheap sanity gates. A spec that parses but is missing its paths would
 * otherwise generate a docs page that renders an empty, confident nothing. */
if (!spec?.openapi) throw new Error("openapi.yaml: no `openapi` version key");
if (!spec?.paths || Object.keys(spec.paths).length === 0) {
  throw new Error("openapi.yaml: no paths");
}

const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit.\n" +
  " *\n" +
  " * Source: openapi.yaml\n" +
  " * Regenerate: npm run docs:gen\n" +
  " *\n" +
  " * Edit the YAML, not this. `npm run docs:check` fails if they disagree.\n" +
  " */\n\n";

/* Emitted untyped on purpose. `as const` would make tsc widen a 460-line
 * literal into a deeply-readonly type for no benefit — the renderer casts to
 * its own minimal structural type instead. */
const body =
  "export const spec: unknown = " + JSON.stringify(spec, null, 2) + ";\n\n" +
  "export default spec;\n";

const next = banner + body;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error("✗ src/docs/spec.gen.ts is missing. Run: npm run docs:gen");
    process.exit(1);
  }
  if (current !== next) {
    console.error("✗ spec.gen.ts is stale — openapi.yaml changed since it was generated.");
    console.error("  Run: npm run docs:gen");
    process.exit(1);
  }
  console.log(`✓ spec.gen.ts matches openapi.yaml (${Object.keys(spec.paths).length} paths)`);
  process.exit(0);
}

writeFileSync(OUT, next);
console.log(
  `✓ src/docs/spec.gen.ts ← openapi.yaml  (${Object.keys(spec.paths).length} paths, ` +
    `${Object.keys(spec.components?.schemas ?? {}).length} schemas)`
);
