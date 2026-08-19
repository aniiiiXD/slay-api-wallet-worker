/**
 * Public API documentation.
 *
 * Mounted on the root app, not `api` — these three routes are unauthenticated
 * by design and must not inherit the session stack. They read nothing and
 * touch no user data; the entire response is derived from a build-time
 * constant.
 *
 *   GET /docs           the reference page
 *   GET /openapi.json   the machine-readable spec
 *   GET /openapi.yaml   redirects to .json (the YAML lives in git, not here)
 */
import { Hono } from "hono";
import { spec } from "./spec.gen";
import { renderDocs } from "./render";

const docs = new Hono();

/* The spec is a build-time constant, so the page is identical for every
 * caller and for the life of a deploy. Rendering once and reusing avoids
 * doing the same string work on every request. */
let cached: string | null = null;

const CACHE = "public, max-age=300, stale-while-revalidate=86400";

docs.get("/docs", (c) => {
  if (cached === null) cached = renderDocs(spec);
  return c.html(cached, 200, {
    "Cache-Control": CACHE,
    /*
     * `default-src 'none'` is the load-bearing part: the page cannot fetch,
     * connect, frame or embed anything — no CDN, no analytics, no
     * exfiltration path — which is the property worth guaranteeing on a page
     * documenting a wallet API.
     *
     * script-src/style-src allow inline only. The tabs, copy buttons,
     * scroll-spy and nav filter are inline and first-party; a hash would be
     * exact but silently breaks the page on every edit to render.ts, and a
     * stale hash fails closed in a way nobody notices until the docs are
     * already live and inert. Inline-with-no-connect-src is the honest
     * trade: script can run, but it has nowhere to send anything.
     */
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; " +
      "frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
});

docs.get("/openapi.json", (c) =>
  c.json(spec as Record<string, unknown>, 200, {
    "Cache-Control": CACHE,
    /* Generated clients are the point of publishing this, and they fetch
     * cross-origin. Read-only and public, so `*` costs nothing. */
    "Access-Control-Allow-Origin": "*",
  })
);

docs.get("/openapi.yaml", (c) => c.redirect("/openapi.json", 302));

export default docs;
