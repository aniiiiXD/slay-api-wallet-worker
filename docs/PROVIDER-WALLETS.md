# Wallets a provider can create — moved

The plan now lives in the repo where the code goes:

    slay-money-api/docs/PARTNER_API.md

## Why it moved

This was written assuming the surface would be built here. It will not be: the
partner routes are being built as a first-class `/api/partner/v1` in the main
Worker, and this Worker is not going to production.

The reasoning, kept short — the full version is in the plan. This Worker was
never a different API. It served a **second copy** of `/api/v1`, which the main
Worker has been serving all along, differing by one file of 75 lines. What the
split bought was isolation from Slay's release cadence, and what it cost was 62
vendored files, a drift ritual on every money-path change, a second set of 34
secrets and a second deploy. With zero live integrations, that is a premium
paid on a policy protecting nobody.

Two plans for one surface is exactly the drift this repo was built to catch,
so there is one, and it is over there.

## What this repo is now

The spec, the rendered reference and the SDK:

    openapi.yaml           the contract
    src/docs/              the renderer that turns it into /docs
    sdk/                   @slay/wallet, the typed client

Those are worth their own repo and cost nothing to keep here. The vendored
runtime is no longer load-bearing.
