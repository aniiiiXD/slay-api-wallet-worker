/**
 * Renders an OpenAPI document to a self-contained HTML reference page.
 *
 * ── Where the design comes from ───────────────────────────────────────────
 * The layout is GitBook's, transcribed from computed styles read off a live
 * GitBook site (hyperliquid.gitbook.io) rather than eyeballed from a
 * screenshot. Every number in the token block below was measured, not
 * invented. Viewport was 1742px; the grid is symmetric about a 183px gutter.
 *
 *   gutter 183 · sidebar 288 · gap 48 · content 768 · gap 16 · toc 256
 *
 * Three deliberate deviations, all forced by "the page must load nothing
 * remote":
 *
 *   1. Inter        → system-ui stack. Near-identical metrics; SF Pro on Mac.
 *   2. IBM Plex Mono → ui-monospace stack.
 *   3. Accent #97FCE4 (Hyperliquid's brand teal) → #d2ff5a, Slay's own
 *      `--accent` from src/design/slay-tokens.css. Copying their palette
 *      would be borrowing someone else's identity, not their layout.
 *
 * Everything else — spacing, sizes, weights, letter-spacing, radii, the
 * 0.88-alpha blurred header — is the measured value.
 *
 * ── Why generated rather than hand-written ────────────────────────────────
 * One source of truth. The page is derived from the same openapi.yaml the
 * client and server agree on, so the docs cannot drift from the contract.
 * A CDN-hosted viewer (Scalar, Redoc, Swagger UI) would also put a third
 * party's script on the page documenting a wallet API — the exact dependency
 * this codebase refuses everywhere else.
 */

/* Minimal structural view of the parts we render. The spec is richer than
 * this; anything not modelled here is simply not displayed. */
interface Schema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  description?: string;
  example?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  default?: unknown;
  $ref?: string;
}
interface MediaType { schema?: Schema }
interface Response { description?: string; content?: Record<string, MediaType>; $ref?: string }
interface Param { name: string; in: string; required?: boolean; description?: string; schema?: Schema }
interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: Param[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses?: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
}
interface Doc {
  openapi?: string;
  info?: {
    title?: string; version?: string; summary?: string; description?: string;
    contact?: { name?: string; url?: string };
  };
  servers?: Array<{ url?: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  /* A path item is operations by method, plus an optional `servers` override.
   * The override matters: a spec can describe routes that live on more than
   * one host, and rendering them all against the top-level server is how a
   * reference confidently sends someone to a 404. */
  paths?: Record<string, Record<string, Operation> & { servers?: Array<{ url?: string }> }>;
  components?: {
    schemas?: Record<string, Schema>;
    responses?: Record<string, Response>;
    securitySchemes?: Record<string,
      { type?: string; scheme?: string; description?: string; "x-displayName"?: string }>;
  };
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Collected while rendering, then emitted as the nav tree and the TOC. */
interface Entry { id: string; label: string; level: 1 | 2; method?: string; path?: string }

/* ────────── text ────────── */

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Nav and TOC rows are plain text, so markdown ticks in a heading would show
 *  up literally there ("`clientTxId` is what makes a retry safe"). */
const plain = (s: string) => s.replace(/[`*]/g, "");

/**
 * The spec's descriptions are markdown. This handles the subset actually used
 * — headings, bold, inline code, links, paragraphs — rather than pretending to
 * be a markdown engine. Escaping happens first, so anything unhandled degrades
 * to visible text instead of injected markup.
 *
 * When `collect` is passed, `##` headings are given ids and registered, which
 * is how the intro's own sections end up in the nav and the TOC without being
 * listed anywhere by hand.
 */
function md(src?: string, collect?: Entry[]): string {
  if (!src) return "";
  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" rel="noopener noreferrer">$1</a>');

  return src.split(/\n{2,}/).map((block) => {
    const t = block.trim();
    if (!t) return "";
    const h = /^(#{2,4})\s+(.*)$/s.exec(t);
    if (h) {
      const text = h[2].trim();
      const id = slug(text);
      if (collect) collect.push({ id, label: text, level: 2 });
      return `<h2 id="${esc(id)}" class="mdh">${inline(text)}</h2>`;
    }

    /* A pipe table. Detected by the delimiter row, which is the only part of
     * the syntax that cannot occur by accident in prose — a paragraph
     * containing a stray `|` stays a paragraph. Without this the table falls
     * through to the paragraph branch and prints its own pipes. */
    const lines = t.split("\n").map((l) => l.trim());
    if (lines.length >= 2 && /^\|?[\s:-]*-[\s:|-]*\|?$/.test(lines[1]) && lines[0].includes("|")) {
      const cells = (row: string) =>
        row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(lines[0]);
      const body = lines.slice(2).filter(Boolean).map(cells);
      return `<table class="md"><thead><tr>${
        head.map((c) => `<th>${inline(c)}</th>`).join("")
      }</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")
      }</tbody></table>`;
    }

    /* Single newlines inside a paragraph are wrapping in the YAML block
     * scalar, not intentional breaks — join them. */
    return `<p>${inline(t.replace(/\s*\n\s*/g, " "))}</p>`;
  }).join("\n");
}

/* ────────── syntax highlighting ────────── */

/**
 * A single-pass tokeniser over already-escaped text. One combined regex, so a
 * match can never land inside markup a previous replacement inserted — the
 * failure mode of chained `.replace()` highlighters.
 */
function hl(escaped: string, lang: string): string {
  const rules: Array<[string, RegExp]> =
    lang === "json"
      ? [["s", /&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;(?=\s*:)/g],
         ["v", /&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;/g],
         ["n", /\b-?\d+(?:\.\d+)?\b/g],
         ["k", /\b(?:true|false|null)\b/g]]
      : lang === "bash"
      ? [["c", /#[^\n]*/g],
         ["v", /&#39;(?:[^&\\]|\\.)*&#39;|&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;/g],
         ["k", /\b(?:curl|export|echo)\b/g],
         ["f", /(?:^|\s)(--?[a-zA-Z][\w-]*)/g]]
      : lang === "python"
      ? [["c", /#[^\n]*/g],
         ["v", /&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;|&#39;(?:[^&\\]|\\.)*&#39;/g],
         ["k", /\b(?:import|from|def|return|if|else|raise|with|as|print|True|False|None)\b/g],
         ["n", /\b-?\d+(?:\.\d+)?\b/g]]
      : [["c", /\/\/[^\n]*/g],
         ["v", /&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;|&#39;(?:[^&\\]|\\.)*&#39;|`(?:[^`\\]|\\.)*`/g],
         ["k", /\b(?:const|let|await|async|function|return|new|if|else|throw|import|from|export)\b/g],
         ["n", /\b-?\d+(?:\.\d+)?\b/g]];

  const combined = new RegExp(rules.map(([, r]) => `(${r.source})`).join("|"), "g");
  return escaped.replace(combined, (m, ...groups) => {
    const i = groups.slice(0, rules.length).findIndex((g) => g !== undefined);
    const cls = i >= 0 ? rules[i][0] : "";
    return cls ? `<span class="t${cls}">${m}</span>` : m;
  });
}

function codeBlock(src: string, lang: string): string {
  return `<pre class="code"><code>${hl(esc(src), lang)}</code></pre>`;
}

/* ────────── schema ────────── */

const refName = (ref: string) => ref.split("/").pop() ?? ref;

function typeOf(s?: Schema): string {
  if (!s) return "";
  if (s.$ref) return refName(s.$ref);
  if (s.enum) return s.enum.map((e) => `"${String(e)}"`).join(" | ");
  const base = Array.isArray(s.type) ? s.type.join(" | ") : s.type ?? "object";
  if (base === "array" || (Array.isArray(s.type) && s.type.includes("array"))) {
    return `${typeOf(s.items) || "any"}[]`;
  }
  return s.format ? `${base} <${s.format}>` : base;
}

/** Builds an example payload from the `example` values on each property, so
 *  the code samples show something real rather than `"string"`. */
function sampleOf(s?: Schema): unknown {
  if (!s) return undefined;
  if (s.example !== undefined) return s.example;
  if (s.properties) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties)) {
      const val = sampleOf(v);
      if (val !== undefined) o[k] = val;
    }
    return Object.keys(o).length ? o : undefined;
  }
  if (s.enum?.length) return s.enum[0];
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if (t === "array") { const it = sampleOf(s.items); return it === undefined ? [] : [it]; }
  if (t === "integer" || t === "number") return 0;
  if (t === "boolean") return true;
  return undefined;
}

function propTable(s: Schema | undefined, depth = 0): string {
  if (!s) return "";
  if (s.$ref) return `<p class="dim">See <code>${esc(refName(s.$ref))}</code>.</p>`;
  const props = s.properties;
  if (!props) return `<p class="dim"><code>${esc(typeOf(s))}</code></p>`;

  const required = new Set(s.required ?? []);
  const rows = Object.entries(props).map(([name, p]) => {
    const eg = p.example !== undefined
      ? `<div class="eg">Example: <code>${esc(JSON.stringify(p.example))}</code></div>` : "";
    const nested = depth < 3 && p.properties
      ? `<div class="nested">${propTable(p, depth + 1)}</div>` : "";
    return `<div class="prop">
      <div class="phead">
        <code class="pname">${esc(name)}</code>
        <span class="ptype">${esc(typeOf(p))}</span>
        ${required.has(name) ? '<span class="preq">required</span>' : ""}
      </div>
      <div class="pbody">${md(p.description)}${eg}${nested}</div>
    </div>`;
  }).join("");

  return `<div class="props">${rows}</div>`;
}

const bodySchema = (c?: Record<string, MediaType>) => c?.["application/json"]?.schema;

/* ────────── code samples ────────── */

function samples(server: string, path: string, method: string, op: Operation, doc: Doc) {
  /* Substitute path params with their example so the sample is copy-pasteable. */
  let p = path;
  for (const par of op.parameters ?? []) {
    if (par.in === "path") {
      const v = String(par.schema?.example ?? par.schema?.enum?.[0] ?? `<${par.name}>`);
      p = p.replace(`{${par.name}}`, v);
    }
  }
  const query = (op.parameters ?? []).filter((x) => x.in === "query" && x.schema?.default !== undefined);
  const qs = query.length ? "?" + query.map((x) => `${x.name}=${x.schema!.default}`).join("&") : "";
  const url = `${server}${p}${qs}`;

  const body = sampleOf(bodySchema(op.requestBody?.content));
  const bodyJson = body !== undefined ? JSON.stringify(body, null, 2) : null;
  const M = method.toUpperCase();

  /* `security: []` overrides the global requirement with none. */
  const isPublic = op.security?.length === 0;
  const usesSession = op.security?.some((s) => "SessionCookie" in s);

  const authCurl = isPublic ? "" : usesSession
    ? ` \\\n  -H "Cookie: session=$SLAY_SESSION"`
    : ` \\\n  -H "Authorization: Bearer $SLAY_API_KEY"`;

  const curl =
    `curl -X ${M} "${url}"${authCurl}` +
    (bodyJson ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'` : "");

  const jsHeaders = isPublic ? "" :
    `\n  headers: {\n    Authorization: \`Bearer \${process.env.SLAY_API_KEY}\`,${
      bodyJson ? `\n    "Content-Type": "application/json",` : ""}\n  },`;
  const js =
    `const res = await fetch("${url}", {\n  method: "${M}",${jsHeaders}` +
    (bodyJson ? `\n  body: JSON.stringify(${JSON.stringify(body)}),` : "") +
    `\n});\nconst data = await res.json();`;

  const pyAuth = isPublic ? "" : `,\n    headers={"Authorization": f"Bearer {os.environ['SLAY_API_KEY']}"}`;
  const py =
    `import os, requests\n\nres = requests.${method.toLowerCase()}(\n    "${url}"${pyAuth}` +
    (bodyJson ? `,\n    json=${JSON.stringify(body).replace(/true/g, "True").replace(/false/g, "False").replace(/null/g, "None")}` : "") +
    `\n)\ndata = res.json()`;

  return { curl, js, py };
}

/* ────────── operations ────────── */

function renderOperation(
  path: string, method: string, op: Operation, doc: Doc, server: string, toc: Entry[]
): string {
  const id = op.operationId ?? slug(`${method}-${path}`);
  toc.push({ id, label: op.summary ?? id, level: 2, method, path });

  const params = op.parameters ?? [];
  const paramBlock = (label: string, list: Param[]) =>
    list.length ? `<h3>${label}</h3><div class="props">${list.map((p) => `
      <div class="prop">
        <div class="phead">
          <code class="pname">${esc(p.name)}</code>
          <span class="ptype">${esc(typeOf(p.schema))}</span>
          ${p.required ? '<span class="preq">required</span>' : ""}
        </div>
        <div class="pbody">${md(p.description)}${
          p.schema?.default !== undefined
            ? `<div class="eg">Default: <code>${esc(String(p.schema.default))}</code></div>` : ""
        }</div>
      </div>`).join("")}</div>` : "";

  const reqSchema = bodySchema(op.requestBody?.content);
  const responses = Object.entries(op.responses ?? {}).map(([code, r]) => {
    const resolved: Response = r.$ref
      ? doc.components?.responses?.[refName(r.$ref)] ?? r : r;
    const schema = bodySchema(resolved.content);
    const cls = code.startsWith("2") ? "ok" : code.startsWith("4") ? "warn" : "err";

    /* A named schema links to its own section rather than repeating itself.
     * An inline one has nowhere else to be documented, so it is expanded
     * here — otherwise fields like `cantonAddress`, which the spec describes
     * carefully, would exist in the contract and appear nowhere on the page. */
    let shape = "";
    let detail = "";
    if (schema?.$ref) {
      const n = refName(schema.$ref);
      shape = `<a class="rshape link" href="#schema-${esc(slug(n))}">${esc(n)}</a>`;
    } else if (schema?.properties) {
      shape = `<code class="rshape">object</code>`;
      const eg = sampleOf(schema);
      detail = `<details${code.startsWith("2") ? " open" : ""}>
        <summary>Fields</summary>
        ${propTable(schema)}
        ${eg !== undefined ? codeBlock(JSON.stringify(eg, null, 2), "json") : ""}
      </details>`;
    } else if (schema) {
      shape = `<code class="rshape">${esc(typeOf(schema))}</code>`;
    }

    return `<div class="resp">
      <div class="rhead"><span class="status ${cls}">${esc(code)}</span>${shape}</div>
      <div class="rbody">${md(resolved.description)}${detail}</div>
    </div>`;
  }).join("");

  const s = samples(server, path, method, op, doc);
  const tabId = `tabs-${id}`;
  const authPill = op.security?.length === 0
    ? '<span class="pill public">No auth</span>'
    : op.security?.some((x) => "SessionCookie" in x)
    ? '<span class="pill">Session</span>'
    : '<span class="pill">API key</span>';

  return `<section class="op" id="${esc(id)}">
    <h2 class="ophead">${esc(op.summary ?? id)}</h2>
    <div class="sig">
      <span class="m ${esc(method)}">${esc(method.toUpperCase())}</span>
      <code class="path">${esc(path)}</code>
      ${authPill}
    </div>
    <div class="desc">${md(op.description)}</div>

    <div class="tabs" data-tabs="${esc(tabId)}">
      <div class="tabbar" role="tablist">
        <button class="tab on" role="tab" data-i="0">cURL</button>
        <button class="tab" role="tab" data-i="1">JavaScript</button>
        <button class="tab" role="tab" data-i="2">Python</button>
        <button class="copy" type="button" title="Copy">Copy</button>
      </div>
      <div class="panes">
        <div class="pane on">${codeBlock(s.curl, "bash")}</div>
        <div class="pane">${codeBlock(s.js, "js")}</div>
        <div class="pane">${codeBlock(s.py, "python")}</div>
      </div>
    </div>

    ${paramBlock("Path parameters", params.filter((p) => p.in === "path"))}
    ${paramBlock("Query parameters", params.filter((p) => p.in === "query"))}
    ${reqSchema ? `<h3>Body</h3>${propTable(reqSchema)}` : ""}
    ${responses ? `<h3>Responses</h3><div class="resps">${responses}</div>` : ""}
  </section>`;
}

/* ────────── page ────────── */

/**
 * Slay's mark, inlined as a data URI.
 *
 * The header used to be a bare accent-coloured square — a placeholder that
 * read as "we did not get to this yet" on a page partners are asked to trust
 * with money. This is the real icon, the same one the dashboard and the
 * extension use, so the reference looks like it belongs to the product.
 *
 * Inlined rather than linked because the page is generated at build time and
 * served by a Worker with no static assets: an <img src="/logo.png"> here
 * would be a 404 in a header, which is worse than the placeholder was. 1.7KB.
 */
const SLAY_MARK =
  "data:image/png;base64,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";

export function renderDocs(input: unknown): string {
  const doc = input as Doc;
  const info = doc.info ?? {};
  const server = doc.servers?.[0]?.url ?? "";

  const intro: Entry[] = [];
  const introHtml = md(info.description, intro);

  /* Group operations by tag, in the order the spec declares them — the author's
   * ordering is meaningful and alphabetising would lose it. */
  const declared = (doc.tags ?? []).map((t) => t.name);
  const groups = new Map<string, { html: string[]; entries: Entry[] }>();

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      /* This path's own host if it declares one, otherwise the document's. */
      const opServer = item.servers?.[0]?.url ?? server;
      const tag = op.tags?.[0] ?? "Other";
      if (!groups.has(tag)) groups.set(tag, { html: [], entries: [] });
      const g = groups.get(tag)!;
      const before = g.entries.length;
      g.html.push(renderOperation(path, method, op, doc, opServer, g.entries));
      void before;
    }
  }

  const order = [
    ...declared.filter((t) => groups.has(t)),
    ...[...groups.keys()].filter((t) => !declared.includes(t)),
  ];
  const tagDesc = new Map((doc.tags ?? []).map((t) => [t.name, t.description ?? ""]));

  const sections = order.map((tag) => `<div class="group" id="tag-${esc(slug(tag))}">
      <h2 class="grouph">${esc(tag)}</h2>
      ${tagDesc.get(tag) ? `<p class="dim">${md(tagDesc.get(tag))}</p>` : ""}
      ${groups.get(tag)!.html.join("\n")}
    </div>`).join("\n");

  const schemaEntries: Entry[] = [];
  const schemas = Object.entries(doc.components?.schemas ?? {}).map(([name, s]) => {
    const id = `schema-${slug(name)}`;
    schemaEntries.push({ id, label: name, level: 2 });
    return `<section class="op" id="${esc(id)}">
      <h2 class="ophead">${esc(name)}</h2>
      ${md(s.description)}
      ${propTable(s)}
      ${(() => { const eg = sampleOf(s);
        return eg !== undefined ? codeBlock(JSON.stringify(eg, null, 2), "json") : ""; })()}
    </section>`;
  }).join("");

  const authEntries: Entry[] = [];
  const auth = Object.entries(doc.components?.securitySchemes ?? {}).map(([name, s]) => {
    const id = `auth-${slug(name)}`;
    /* `AgentKey` and `SessionCookie` are identifiers the spec needs in order to
     * reference a scheme; they are not what a reader should be shown. */
    const title = s["x-displayName"] ?? name;
    authEntries.push({ id, label: title, level: 2 });
    return `<section class="op" id="${esc(id)}">
      <h2 class="ophead">${esc(title)}</h2>
      <div class="desc">${md(s.description)}</div>
    </section>`;
  }).join("");

  /* ── nav tree ───────────────────────────────────────────────────────────
   * Collapsible groups with a disclosure chevron, matching the reference:
   * a 24x24 button holding a 12x12 icon, pinned to the right edge, tinted
   * with the accent while open and dim white while closed. Rows are 32px on
   * a 34px pitch and children indent by 21px — all measured, not chosen.
   *
   * The chevron is drawn here rather than lifted from an icon set, so the
   * page carries no third-party asset or its attribution requirement.
   */
  const CHEV =
    `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">` +
    `<path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const navItem = (e: Entry) =>
    `<li><a class="ni sub" href="#${esc(e.id)}" data-nav="${esc(e.id)}" data-s="${
      esc((e.label + " " + (e.path ?? "") + " " + (e.method ?? "")).toLowerCase())
    }">${
      e.method ? `<span class="mi ${esc(e.method)}">${esc(e.method.toUpperCase())}</span>` : ""
    }<span>${esc(plain(e.label))}</span></a></li>`;

  /** A top-level row. With children it gets a chevron and a collapsible list;
   *  without, it is a plain link so nothing suggests hidden content. */
  const navGroup = (label: string, href: string, kids: Entry[], open: boolean) =>
    kids.length
      ? `<li class="grp${open ? " open" : ""}">
           <div class="row">
             <a class="ni top" href="${esc(href)}" data-nav="${esc(href.replace(/^#/, ""))}"
                data-s="${esc(label.toLowerCase())}">${esc(label)}</a>
             <button class="chev" type="button" aria-expanded="${open}"
                     aria-label="Toggle ${esc(label)}">${CHEV}</button>
           </div>
           <ul class="kids">${kids.map(navItem).join("")}</ul>
         </li>`
      : `<li><a class="ni top" href="${esc(href)}" data-s="${esc(label.toLowerCase())}">${esc(label)}</a></li>`;

  const nav =
    `<ul class="tree">` +
    navGroup("Overview", "#overview", intro, false) +
    `</ul><div class="navsec">Reference</div><ul class="tree">` +
    order.map((tag) =>
      navGroup(tag, `#tag-${slug(tag)}`, groups.get(tag)!.entries, false)
    ).join("") +
    `</ul><div class="navsec">Resources</div><ul class="tree">` +
    navGroup("Authentication", "#authentication", authEntries, false) +
    navGroup("Schemas", "#schemas", schemaEntries, false) +
        `</ul>`;

  /* ── on this page ── */
  const all: Entry[] = [
    { id: "overview", label: "Overview", level: 1 },
    ...intro,
    ...order.flatMap((t) => [
      { id: `tag-${slug(t)}`, label: t, level: 1 as const },
      ...groups.get(t)!.entries,
    ]),
    { id: "authentication", label: "Authentication", level: 1 },
    ...authEntries,
    { id: "schemas", label: "Schemas", level: 1 },
    ...schemaEntries,
  ];
  const toc = all.map((e) =>
    `<a class="tocl${e.level === 2 ? " sub" : ""}" href="#${esc(e.id)}" data-toc="${esc(e.id)}">${esc(plain(e.label))}</a>`
  ).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.title ?? "API")}</title>
<link rel="icon" type="image/png" href="${SLAY_MARK}">
<meta name="description" content="${esc(info.summary ?? "")}">
<style>
/* ── tokens: measured from a live GitBook site, not estimated ───────────── */
:root{
  --bg:#1D1D1D;            /* body background                                */
  --fg:#FEFFFF;            /* primary text                                   */
  --dim:rgba(254,255,255,.64);
  --dim2:#BDC1C0;
  --line:#424443;          /* every divider and border                       */
  --line2:#383A39;         /* code-block border                              */
  --acc:#d2ff5a;           /* Slay --accent, in place of GitBook's teal      */
  --codebg:#222322;
  --inlinebg:#2B2C2C;
  --hdr:rgba(29,29,29,.88);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --gut:183px; --side:288px; --content:768px; --toc:256px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:88px;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/26px var(--sans);
  font-synthesis-weight:none;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
h1,h2,h3{margin:0;font-weight:600}
code{font-family:var(--mono);font-variant-ligatures:none}

/* ── header: 64px, sticky, 0.88 alpha + 16px blur ──────────────────────── */
/* The reference is 109px because it carries a tab row for its several
 * sections. We have one, and GitBook hides that row for single-section
 * sites — so 64px here is the same rule producing a different number,
 * not a divergence from it. Restore both if a second section appears. */
header{position:sticky;top:0;z-index:40;background:var(--hdr);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border-bottom:1px solid var(--line)}
.hrow{height:64px;display:flex;align-items:center;justify-content:space-between;
  padding:0 var(--gut)}
.brand{display:flex;align-items:center;gap:10px;font-size:16px;line-height:20px}
.mark{width:22px;height:22px;border-radius:6px;flex:none;display:block}
.search{width:224px;height:39px;border:1px solid var(--line);border-radius:12px;
  background:var(--bg);display:flex;align-items:center;gap:8px;padding:0 10px}
.search input{all:unset;flex:1;font:14px var(--sans);color:var(--fg);min-width:0}
.search input::placeholder{color:var(--dim2)}
.kbd{font:500 11px/1 var(--mono);color:var(--dim2);border:1px solid var(--line);
  border-radius:4px;padding:3px 5px}

/* ── grid ──────────────────────────────────────────────────────────────── */
/* The two gaps (48 then 16) live as left padding on the columns that follow,
 * so each column's CONTENT is the measured width — a 288px rail means 288px
 * of rail, not 288 minus the gutter. Total inner width 288+816+272 = 1376,
 * which is what the reference measures at a 1742px viewport. */
.shell{display:grid;justify-content:center;
  grid-template-columns:var(--side) calc(var(--content) + 48px) calc(var(--toc) + 16px);
  padding:0 var(--gut)}
.shell>nav{width:var(--side)}
.shell>main{width:var(--content);min-width:0;margin-left:48px;padding:32px 0 120px}
.shell>.toc{width:var(--toc);margin-left:16px}

/* ── left nav ──────────────────────────────────────────────────────────── */
nav{position:sticky;top:64px;align-self:start;height:calc(100vh - 64px);
  overflow-y:auto;padding:24px 0 16px;scrollbar-width:thin;
  display:flex;flex-direction:column}
.navsec{font:600 11px/16px var(--sans);letter-spacing:.06em;text-transform:uppercase;
  color:var(--dim2);margin:24px 0 8px;padding-left:12px}
.tree{list-style:none;margin:0;padding:0}
.tree li{margin-bottom:2px}          /* 32px row on a 34px pitch */
/* the row holds the link and its chevron; the chevron sits at the right edge */
.row{display:flex;align-items:center;gap:2px;padding-right:14px}
.row>.ni{flex:1;min-width:0}
.ni{display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px;
  color:var(--dim);padding:6px 6px 6px 12px;border-radius:6px;min-height:32px}
.ni.sub{padding-left:33px}           /* 12 + 21 measured indent */
.ni:hover{color:var(--fg);background:rgba(255,255,255,.04)}
.ni.on{color:var(--acc);font-weight:600}
.ni.hide{display:none}
.chev{all:unset;width:24px;height:24px;border-radius:8px;flex:none;cursor:pointer;
  display:flex;align-items:center;justify-content:center;color:var(--dim);
  transition:transform .15s ease,color .15s ease}
.chev:hover{background:rgba(255,255,255,.06);color:var(--fg)}
.grp.open>.row>.chev{transform:rotate(90deg);color:var(--acc)}
.kids{list-style:none;margin:0;padding:0;overflow:hidden}
.grp:not(.open)>.kids{display:none}
/* a group whose children are all filtered out has nothing left to show */
.grp.hide,.navsec.hide{display:none}
/* pinned to the bottom of the rail, like the reference's footer panel */
.navfoot{margin-top:auto;padding-top:16px}
.navfoot a{display:flex;align-items:center;gap:8px;border:1px solid var(--line);
  border-radius:12px;padding:10px 12px;font-size:13px;line-height:18px;
  color:var(--dim2)}
.navfoot a:hover{color:var(--fg);border-color:var(--dim2)}
.navfoot .dot{width:8px;height:8px;border-radius:50%;background:var(--acc);flex:none}
.mi{font:600 9px/1 var(--mono);letter-spacing:.04em;padding:3px 4px;border-radius:3px;
  color:var(--bg);flex:none}
.mi.get{background:#7cc4ff}.mi.post{background:#8ce99a}
.mi.put,.mi.patch{background:#ffd479}.mi.delete{background:#ff9d9d}

/* ── content ───────────────────────────────────────────────────────────── */
h1{font-size:36px;line-height:45px;font-weight:700;letter-spacing:-.9px}
.lede{color:var(--dim);margin:12px 0 0;font-size:16px;line-height:26px}
.meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
.chip{font:500 12px/1 var(--mono);color:var(--dim2);border:1px solid var(--line);
  border-radius:8px;padding:6px 9px}
a.chip:hover{color:var(--acc);border-color:var(--acc)}
main p{margin:0 0 16px}
main strong{font-weight:600}
main a[rel]{color:var(--acc);text-decoration:underline;text-underline-offset:2px}
.mdh,.ophead{font-size:24px;line-height:32px;font-weight:600;
  letter-spacing:-.3px;margin:32px 0 12px}
.grouph{font-size:12px;line-height:16px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;color:var(--dim2);margin:64px 0 0;padding-top:24px;
  border-top:1px solid var(--line)}
/* operations within a group need a seam, or short ones just float */
.op + .op{border-top:1px solid var(--line);padding-top:8px}
h3{font-size:16px;line-height:24px;font-weight:600;margin:28px 0 10px}
.dim{color:var(--dim)}
table.md{width:100%;border-collapse:collapse;margin:16px 0;display:block;
  overflow-x:auto;font-size:14px}
table.md th{text-align:left;font-weight:600;color:var(--fg);padding:10px 16px 10px 0;
  border-bottom:1px solid var(--line);white-space:nowrap}
table.md td{color:var(--dim);padding:11px 16px 11px 0;
  border-bottom:1px solid var(--line);vertical-align:top}
table.md tr:last-child td{border-bottom:0}
.desc{color:var(--dim)}
.op{padding-bottom:8px}

/* signature */
.sig{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 16px}
.m{font:700 11px/1 var(--mono);letter-spacing:.05em;padding:6px 8px;border-radius:6px;
  color:#12140f;flex:none}
.m.get{background:#7cc4ff}.m.post{background:#8ce99a}
.m.put,.m.patch{background:#ffd479}.m.delete{background:#ff9d9d}
.path{font-size:14px;color:var(--fg);font-weight:500}
.pill{font:500 12px/1 var(--sans);color:var(--dim2);border:1px solid var(--line);
  border-radius:99px;padding:5px 10px}
.pill.public{color:var(--acc);border-color:var(--acc)}

/* code */
.code{background:var(--codebg);border:1px solid var(--line2);border-radius:12px;
  padding:14px 16px;margin:0;overflow-x:auto;font:14px/24px var(--mono);
  color:var(--fg);white-space:pre}
.code code{font:inherit}
.ts{color:#a5d6ff}.tv{color:#a5d6ff}.tn{color:#ffab70}
.tk{color:var(--acc)}.tc{color:#6e7681;font-style:italic}.tf{color:#d2a8ff}
main :not(pre)>code{background:var(--inlinebg);border-radius:4px;padding:1px 6px;
  font-size:14px;color:var(--fg)}
.mdh code,.ophead code,.grouph code,h3 code{font-size:.86em;padding:1px 5px}

/* language tabs */
.tabs{margin:20px 0 4px;border:1px solid var(--line2);border-radius:12px;
  overflow:hidden;background:var(--codebg)}
.tabbar{display:flex;align-items:center;gap:2px;padding:6px 8px;
  border-bottom:1px solid var(--line2)}
.tab{all:unset;font:400 13px/1 var(--sans);color:var(--dim2);padding:6px 10px;
  border-radius:6px;cursor:pointer}
.tab:hover{color:var(--fg)}
.tab.on{color:var(--acc);background:rgba(210,255,90,.10)}
.copy{all:unset;margin-left:auto;font:400 12px/1 var(--sans);color:var(--dim2);
  padding:6px 9px;border:1px solid var(--line);border-radius:6px;cursor:pointer}
.copy:hover{color:var(--fg)}
.pane{display:none}.pane.on{display:block}
.pane .code{border:0;border-radius:0;background:transparent}

/* properties */
.props{border-top:1px solid var(--line);min-width:0}
.prop{border-bottom:1px solid var(--line);padding:14px 0}
.phead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pname{font-size:14px;font-weight:600;color:var(--fg)}
.ptype{font:400 13px/1 var(--mono);color:var(--dim2)}
.preq{font:500 11px/1 var(--sans);color:var(--acc)}
.pbody{color:var(--dim);font-size:14px;line-height:22px;margin-top:6px}
.pbody p{margin:0 0 8px}.pbody p:last-child{margin:0}
.eg{margin-top:6px;font-size:13px;color:var(--dim2)}
.eg code{overflow-wrap:anywhere}
.nested{margin-top:10px;padding-left:14px;border-left:1px solid var(--line)}

/* responses */
.resps{border-top:1px solid var(--line)}
.resp{border-bottom:1px solid var(--line);padding:14px 0;display:grid;
  grid-template-columns:120px minmax(0,1fr);gap:16px;align-items:start}
.rhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.status{font:700 12px/1 var(--mono);padding:5px 7px;border-radius:5px;
  border:1px solid currentColor}
.status.ok{color:#8ce99a}.status.warn{color:#ffd479}.status.err{color:#ff9d9d}
.rshape{font-size:12px;color:var(--dim2)}
.rbody{color:var(--dim);font-size:14px;line-height:22px;min-width:0}
.rbody p{margin:0 0 8px}.rbody p:last-child{margin:0}
details{margin-top:10px}
summary{cursor:pointer;font:500 13px/20px var(--sans);color:var(--dim2);
  list-style:none;display:flex;align-items:center;gap:6px;padding:4px 0}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";display:inline-block;transition:transform .12s;
  color:var(--dim2);font-size:11px}
details[open]>summary::before{transform:rotate(90deg)}
summary:hover{color:var(--fg)}
details .props{margin-top:6px}
details .code{margin-top:10px}
a.rshape.link{color:var(--acc);font-size:12px;text-decoration:underline;
  text-underline-offset:2px;font-family:var(--mono)}

/* on this page */
.toc{position:sticky;top:64px;align-self:start;height:calc(100vh - 64px);
  overflow-y:auto;padding-top:32px;scrollbar-width:thin}
.toch{font:600 11px/16px var(--sans);letter-spacing:.06em;text-transform:uppercase;
  color:var(--dim2);margin-bottom:12px}
.tocl{display:block;font-size:14px;line-height:20px;color:var(--dim2);padding:5px 0}
.tocl.sub{padding-left:12px;color:var(--dim)}
.tocl:hover{color:var(--fg)}
.tocl.on{color:var(--acc)}

footer{border-top:1px solid var(--line);margin-top:64px;padding-top:24px;
  color:var(--dim2);font-size:13px;line-height:22px}

@media(max-width:1500px){:root{--gut:48px}}
@media(max-width:1200px){
  .shell{grid-template-columns:var(--side) minmax(0,1fr);}
  .shell>.toc{display:none}
  .shell>main{width:auto}
}
@media(max-width:900px){
  :root{--gut:20px}
  .shell{grid-template-columns:minmax(0,1fr)}
  .shell>nav{display:none}
  .search{width:150px}
  .resp{grid-template-columns:1fr;gap:8px}
}
</style>
</head>
<body>
<header>
  <div class="hrow">
    <a class="brand" href="#overview"><img class="mark" src="${SLAY_MARK}" alt="" width="22" height="22">${esc(info.title ?? "API")}</a>
    <div class="search">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="#BDC1C0" stroke-width="1.5"/>
        <path d="M10.5 10.5 14 14" stroke="#BDC1C0" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <input id="q" type="search" placeholder="Search..." aria-label="Search" autocomplete="off">
      <span class="kbd">/</span>
    </div>
  </div>
</header>

<div class="shell">
  <nav id="nav">${nav}
    <div class="navfoot">
      <a href="/openapi.json"><span class="dot"></span>Spec v${esc(info.version ?? "")} · OpenAPI ${esc(doc.openapi ?? "")}</a>
    </div>
  </nav>
  <main>
    <h1 id="overview">${esc(info.title ?? "API")}</h1>
    <p class="lede">${esc(info.summary ?? "")}</p>
    <div class="meta">
      <span class="chip">v${esc(info.version ?? "")}</span>
      <span class="chip">OpenAPI ${esc(doc.openapi ?? "")}</span>
      ${server ? `<span class="chip">${esc(server)}</span>` : ""}
      <a class="chip" href="/openapi.json">openapi.json ↗</a>
    </div>
    ${introHtml}
    ${sections}
    <div class="group" id="authentication">
      <h2 class="grouph">Authentication</h2>${auth}
    </div>
    <div class="group" id="schemas">
      <h2 class="grouph">Schemas</h2>${schemas}
    </div>
    <footer>
      Generated from <code>openapi.yaml</code>. Every field was read off the
      handler — where the code and a tidier description disagreed, the code won.
      ${info.contact?.url
        ? `<a href="${esc(info.contact.url)}" rel="noopener noreferrer">${esc(info.contact.name ?? "")}</a>`
        : ""}
    </footer>
  </main>
  <aside class="toc">
    <div class="toch">On this page</div>
    ${toc}
  </aside>
</div>

<script>
/* Disclosure chevrons. The whole row is not the toggle — the label is a
   link to the section, the chevron alone opens and closes the group. */
document.querySelectorAll("#nav .chev").forEach(function (btn) {
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    var grp = btn.closest(".grp");
    var open = grp.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
  });
});

document.querySelectorAll("#nav .row > .ni").forEach(function (a) {
  a.addEventListener("click", function () {
    var grp = a.closest(".grp");
    if (grp) {
      grp.classList.add("open");
      var c = grp.querySelector(".chev");
      if (c) c.setAttribute("aria-expanded", "true");
    }
  });
});

/* Language tabs. */
document.querySelectorAll(".tabs").forEach(function (box) {
  var tabs = box.querySelectorAll(".tab"), panes = box.querySelectorAll(".pane");
  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      var i = +t.dataset.i;
      tabs.forEach(function (x, j) { x.classList.toggle("on", j === i); });
      panes.forEach(function (p, j) { p.classList.toggle("on", j === i); });
    });
  });
  var copy = box.querySelector(".copy");
  if (copy) copy.addEventListener("click", function () {
    var pane = box.querySelector(".pane.on code");
    if (!pane) return;
    navigator.clipboard.writeText(pane.innerText).then(function () {
      copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1200);
    });
  });
});

/* Scroll-spy over every anchored section, driving both the nav and the TOC.
   rootMargin pins the trigger line just under the sticky header. */
var targets = [].slice.call(document.querySelectorAll("[id]"))
  .filter(function (el) { return document.querySelector('[data-toc="' + CSS.escape(el.id) + '"]'); });
function mark(id) {
  document.querySelectorAll(".tocl.on,.ni.on").forEach(function (e) { e.classList.remove("on"); });
  var a = document.querySelector('[data-toc="' + CSS.escape(id) + '"]');
  var b = document.querySelector('[data-nav="' + CSS.escape(id) + '"]');
  if (a) { a.classList.add("on"); }
  if (b) {
    b.classList.add("on");
    /* An active row inside a collapsed group would be highlighted where
       nobody can see it, so opening it is part of marking it. */
    var grp = b.closest(".grp");
    if (grp && !grp.classList.contains("open")) {
      grp.classList.add("open");
      var c = grp.querySelector(".chev");
      if (c) c.setAttribute("aria-expanded", "true");
    }
  }
}
/* Driven by scroll position rather than IntersectionObserver.
 *
 * An observer only reports the moment a boundary is crossed, so which
 * section "wins" depends on callback ordering and on how many entries batch
 * together — and with smooth scroll-behavior a single anchor click fires
 * a long burst of them. The result lagged the viewport by a section or two.
 *
 * Position is the actual question being asked, so ask it directly: the
 * active section is the last one whose top has passed under the header.
 * Because targets is in document order, that is a single walk, and it
 * gives the same answer no matter how the scroll got there.
 */
var LINE = 96;                        /* just below the 64px sticky header */
var current = "";
function spy() {
  var pick = targets[0];
  for (var i = 0; i < targets.length; i++) {
    if (targets[i].getBoundingClientRect().top <= LINE) pick = targets[i];
    else break;
  }
  /* The last section is usually too short to reach the line, so at the
     bottom of the page nothing would ever mark it. */
  if (scrollY + innerHeight >= document.documentElement.scrollHeight - 4) {
    pick = targets[targets.length - 1];
  }
  if (pick && pick.id !== current) { current = pick.id; mark(pick.id); }
}
var ticking = false;
addEventListener("scroll", function () {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(function () { ticking = false; spy(); });
}, { passive: true });
addEventListener("resize", spy, { passive: true });
spy();

/* Nav filter. ~40 entries, so matching the text directly beats building an
   index — and it keeps the page free of any fetch. */
var q = document.getElementById("q");
q.addEventListener("input", function () {
  var v = q.value.trim().toLowerCase();
  document.querySelectorAll("#nav .ni").forEach(function (a) {
    var hay = (a.dataset.s || a.textContent).toLowerCase();
    a.classList.toggle("hide", v.length > 0 && hay.indexOf(v) === -1);
  });
  document.querySelectorAll("#nav .grp").forEach(function (g) {
    var kids = [].slice.call(g.querySelectorAll(".kids .ni"));
    var parent = g.querySelector(".row .ni");
    var anyKid = kids.some(function (k) { return !k.classList.contains("hide"); });
    var self = parent && !parent.classList.contains("hide");
    /* Hide a group only when neither it nor any child matched, and force it
       open while filtering so matches are never hidden behind a chevron. */
    g.classList.toggle("hide", v.length > 0 && !anyKid && !self);
    if (v.length > 0 && anyKid) g.classList.add("open");
  });
  document.querySelectorAll("#nav .navsec").forEach(function (s) {
    s.classList.toggle("hide", v.length > 0);
  });
});
document.addEventListener("keydown", function (e) {
  if (e.key === "/" && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  if (e.key === "Escape" && document.activeElement === q) { q.value = ""; q.dispatchEvent(new Event("input")); q.blur(); }
});
</script>
</body></html>`;
}
