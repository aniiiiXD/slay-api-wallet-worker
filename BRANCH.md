# `api-docs` — the reference as a page you can serve

Three files, no build step, no server: the partner API reference rendered to
static HTML, plus the spec it came from.

    index.html                the rendered reference — one file, no external assets
    openapi.json              the spec, generated
    openapi.yaml              the spec, source of truth
    PARTNER_QUICKSTART.md     the provider surface, from nothing to a wallet

The reference covers the **single-wallet** API: one key, one wallet. Wallet
providers who need to create and operate wallets for their own users want
`/api/partner/v1` on the main API, which is what the quickstart covers — and
which the reference now points at rather than leaving someone to discover the
single-wallet model is all there is.

`index.html` inlines its CSS, its JavaScript and the Slay mark as a data URI.
The only two outbound links in it are the CIP-0103 spec on GitHub and
slay.money. So it opens from a filesystem, serves from any static host, and
survives being emailed to someone as an attachment.

## Why a branch and not a folder

The Worker already serves this at `/docs`, generated at build time, and that
stays the canonical copy — it cannot drift from the contract because it is
built from it.

This branch exists for the cases the Worker cannot cover: handing the
reference to someone before they have a key, publishing it to GitHub Pages,
or reading it when the Worker is down — which is exactly when an integrator
most wants to know whether the problem is theirs.

## Regenerating

It is a snapshot, and a snapshot goes stale silently. Rebuild it from the
Worker rather than editing the HTML by hand — editing the render is how the
reference starts disagreeing with the API it documents.

    git checkout main
    npm run docs:gen                  # openapi.yaml → src/docs/spec.gen.ts
    npx wrangler dev --port 8788      # then, from another shell:
    curl -s localhost:8788/docs         -o index.html
    curl -s localhost:8788/openapi.json -o openapi.json

Then commit those three files back to this branch, along with `openapi.yaml`.

## Serving it on GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → `api-docs` / `/ (root)`.
`index.html` at the root is all it needs.

## What it documents

Seven endpoints on the wallet provider Worker
(`slay-api-wallet-providers.slay-money-api.workers.dev`):

    GET  /api/v1/balance                 balance:read
    GET  /api/v1/transactions            tx:read
    POST /api/v1/transfers               tx:write + an approved account
    GET  /api/v1/transfers/{clientTxId}  tx:read
    GET  /api/v1/config                  enabled assets and your own fee
    GET  /health                         readiness — alert on this, not /
    GET  /                               liveness

Issuing a key, applying for approval and everything else are on the main API
and answer 404 here, deliberately.
