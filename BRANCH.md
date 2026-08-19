# `dashboard` — the B2B dashboard, parked on a branch

This branch is not part of the wallet provider Worker. It shares no code with
`main` and is never merged into it; it lives here because the dashboard's own
repository has **no git remote at all**, so this was the only copy that existed
outside one laptop.

Read `main` for the Worker. Read this for the dashboard.

## What it is

The signed-in web dashboard a business uses: balances and activity, extension
connections, the CIP-0103 integration economics, and — the part that matters
to this Worker — **the screen where an API key is minted**.

    Overview     Worker      balances, KPIs
    Activity     Worker      transaction history
    Connections  On-device   extension connections, never seen by the server
    API keys     Worker      mint, freeze, rotate, revoke + apply for approval
    Integrate    Worker      CIP-0047 economics, per-app rollup

## Condition, audited 2026-08-20

Every endpoint the dashboard calls was probed against production. **18 calls,
17 real, 1 not built — and no fixtures anywhere.**

| Endpoint | Live |
|---|---|
| `/api/stats`, `/api/prices/cc`, `/api/prices/cc/history` | 200 |
| `/api/kpis`, `/api/wallet`, `/api/wallet/transactions` | 401 — real, session-gated |
| `/api/trading/status`, `/api/trading/apply` | 401 — real |
| `/api/keys` + 5 sub-routes | **404 until the Worker deploys** — see below |
| `/api/auth/*` (email OTP, sign-out) | real |
| `/api/integrations/stats` | **404 — never built** |

`/api/integrations/stats` backs the "Your app" per-origin rollup. It is the
one thing here with no server behind it, and the page **says so**: on a 404 it
renders "Per-app rollups need attribution the Worker doesn't record yet",
naming the `source_origin` migration that would make it work. It does not
invent numbers.

That restraint is the whole reason this rebuild exists. The previous Agents
pages were deleted in August because every endpoint behind them 404'd and they
ran on fixtures — a dashboard whose majority surface is demo data teaches
people to distrust the parts that are real.

The economics figures on Integrate are the other case worth knowing: they read
live values from `/api/stats` and fall back to constants in `economics.ts`
dated "Aug 7, 2026". The page labels which is which rather than presenting the
fallback as live.

## Deploy order matters, once

The dashboard now calls `/api/keys`. That route exists only in an unpushed
commit on `slay-money-api`; production still serves `/api/agents`. **Deploy the
Worker first.** Ship this first and the API keys screen 404s against
production.

## Running it

    npm install
    npm run dev        # :5173, pointed at the production Worker
    npm run build

`VITE_API_URL` in `.env.local` points it at a local Worker instead.
