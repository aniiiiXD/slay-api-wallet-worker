/**
 * Cloudflare Workers env bindings, populated from wrangler.toml + .dev.vars +
 * `wrangler secret` in production. Hono types it via `Hono<{ Bindings: Env }>`.
 */
export type Env = {
  // Durable Object: live Pyth spot fan-out for the crypto up/down graph.
  PRICE_STREAM: DurableObjectNamespace;
  POLYMARKET_STREAM: DurableObjectNamespace;
  TWAP_STREAM: DurableObjectNamespace;
  M2M_TOKEN_CACHE?: KVNamespace;
  /** R2 bucket holding profile pictures. Optional so a deploy without the
   *  bucket still boots — the avatar routes 503 instead of the Worker dying. */
  AVATARS?: R2Bucket;
  /** Origin used to build public asset URLs (avatars). Falls back to
   *  BETTER_AUTH_URL, which is already the API's own origin. */
  PUBLIC_API_URL?: string;
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_URL: string;
  /**
   * Comma-separated `chrome-extension://<id>` origins allowed to call the auth
   * routes. Better Auth rejects any origin not on its trusted list with a 403,
   * and a browser extension's origin is its own id — it can never be inferred,
   * so it has to be declared.
   *
   * Unpacked extensions derive their id from the folder path, so each
   * developer's is different; the published build has one stable id. Hence a
   * list, and hence an env var rather than a constant.
   */
  EXTENSION_ORIGINS?: string;
  // SMTP — same env contract as nowornever2 so secrets are copy-paste.
  // In dev, leave SMTP_HOST unset and OTPs print to the wrangler console.
  // AWS SES (preferred when set — SMTP relay hit its monthly cap). Uses the
  // SESv2 HTTPS SendEmail API via SigV4 (Workers-compatible, no raw SMTP).
  // FROM must be a verified SES identity (e.g. no-reply@mail.swapso.io) since
  // slay.money is currently lapsed. Falls back to SMTP when these are unset.
  // Comma-separated extra disposable/temp email domains to block at OTP-send
  // (on top of the built-in denylist in lib/disposable-domains.ts). Lets us add
  // new throwaway domains without a redeploy.
  DISPOSABLE_DOMAINS_EXTRA?: string;
  AWS_SES_ACCESS_KEY_ID?: string;
  AWS_SES_SECRET_ACCESS_KEY?: string;
  AWS_SES_REGION?: string;       // default us-east-1
  SES_FROM?: string;             // 'Slay Money <no-reply@mail.swapso.io>'
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  // Canton / Daml ledger (local sandbox in dev, real participant in prod).
  JSON_API_URL: string;        // https://ledger.mainnet-validator.slay.money in prod (wallet participant, v1)
  /** DNS-outage stopgap. When set (e.g. "52.20.197.40"), v1 ledger fetches use
   *  Cloudflare resolveOverride to reach the box IP directly, keeping the
   *  JSON_API_URL hostname as SNI/Host so the existing TLS cert still matches.
   *  Bypasses public DNS for the ledger when the domain lapses/parks. */
  LEDGER_RESOLVE_IP?: string;
  /** Prediction participant (validator-2) ledger. When set, prediction-market
   *  legs whose party is hosted on v2 (the prediction party) submit here.
   *  The endpoint is a no-auth ledger behind a Caddy shared-secret gate, so
   *  every v2 call MUST carry the X-Ledger-Gate header (JSON_API_V2_GATE). */
  JSON_API_URL_V2?: string;    // https://ledger.mainnet-validator2.slay.money
  /** Which ledger the prediction market's on-chain ops settle on. "v2" routes
   *  to validator-2 (the separate GSF featured app). Default v1 until verified. */
  PREDICTION_LEDGER?: string;  // "v1" | "v2"
  /** Polymarket-mirror execution service (persistent VPS: hot wallet + clob-client
   *  + fills WS). The Worker calls it over this URL with the X-Exec-Gate header. */
  EXEC_SERVICE_URL?: string;
  EXEC_GATE?: string;          // shared secret sent as X-Exec-Gate
  JSON_API_V2_GATE?: string;   // X-Ledger-Gate shared secret enforced by v2's Caddy
  JSON_API_GATE?: string;      // same, for v1. Unset today (v1 is IP-allowlisted instead).
  LEDGER_JWT_SECRET: string;   // "unsafe" for Splice disable-auth; real OIDC otherwise
  LEDGER_JWT_AUDIENCE?: string; // "https://canton.network.global" by default
  LEDGER_USER_ID?: string;     // Canton user the backend authenticates as. "slay-money-api" default.
  LEDGER_ID: string;           // sandbox default — see daml.yaml
  /** Long-lived admin JWT for ledger reads (active-contracts, ledger-end).
   *  Used by the CBTC accept-cron to list incoming TransferInstructions
   *  across every Slay party. Mint via splice's get-token.py on the
   *  validator host: `python3 get-token.py participant_admin`.
   *  In production the canton/jwt minter should replace this. */
  JSON_LEDGER_ADMIN_TOKEN?: string;
  SLAY_PARTY_ID: string;       // custodian party ID, e.g. "slay::1220abc...::sandbox"
  // Splice Validator API (DevNet onwards). Optional until cutover from the
  // local sandbox path — see SPLICE_VALIDATOR_SETUP.md.
  //
  // Feature flag: presence of SPLICE_VALIDATOR_URL toggles the on-chain
  // backend in wallet/service.ts from local Daml sandbox → real Splice
  // validator. Keeping both code paths lets us run sandbox-only locally
  // (no DevNet box required) AND real DevNet in deployed envs.
  SPLICE_VALIDATOR_URL?: string;    // https://validator.slay.money
  /** Legacy treasury+memo / per-party wallet-API deposit poller. Off by default
   *  — the watermark + deposit-trees crediters (JSON /v2 API) are authoritative;
   *  this path 403s under Slay's custodial auth. */
  DEPOSITS_POLL_ENABLED?: string;
  SPLICE_AUTH_SECRET?: string;      // HS256 secret matching the validator's auth service
  // On DevNet with the disable-auth overlay, the audience is the placeholder
  // "https://validator.example.com" (from compose-disable-auth.yaml).
  // On MainNet with real OIDC this becomes the actual Auth0/Keycloak audience.
  SPLICE_AUTH_AUDIENCE?: string;
  // The "sub" claim used for service-level admin calls (POST /admin/users etc).
  // In disable-auth mode this is whatever WALLET_ADMIN_USER is set to in the
  // overlay — default "administrator". Override if you change the overlay.
  SPLICE_AUTH_SUBJECT?: string;
  // The wallet-user identity to mint JWTs as when the operator (treasury)
  // sends CC — currently "administrator" by default, which matches the
  // single entry in the validator's `validator-wallet-users` list. If you
  // add more wallet users to the validator config, point this at whichever
  // one owns the operator party.
  SPLICE_OPERATOR_WALLET_USER?: string;
  // When "1", log raw Splice API responses for debugging the response
  // shape. Leave unset in production — it's verbose.
  SPLICE_DEBUG?: string;
  // Our validator's own operator party ID, captured from the docker-compose
  // logs at first boot. Used for actAs/readAs headers in some calls.
  SPLICE_VALIDATOR_PARTY_ID?: string;
  // Synchronizer migration counter — DevNet=1 today. Some Splice endpoints
  // need this in the URL path or request body.
  SPLICE_MIGRATION_ID?: string;
  // SV sponsor URL — sometimes needed when querying scan endpoints directly.
  SPLICE_SV_SPONSOR_URL?: string;
  // Global synchronizer id + this participant's id — used by the direct
  // AmuletRules_BuyMemberTraffic buy (splice/traffic.ts). Both have safe
  // MainNet defaults baked in; set only to override.
  SPLICE_SYNCHRONIZER_ID?: string;
  SPLICE_PARTICIPANT_ID?: string;
  /** v2's participant vetted a different Slay build (package 40d1…) than v1's
   *  (51e7… = SLAY_DAR_PACKAGE_ID). Same 0.1.0 source. Used when minting/betting
   *  Slay.Market contracts on v2 (target:"v2"). */
  SLAY_DAR_PACKAGE_ID_V2?: string;
  /** Oracle prediction market on-chain footprint lives on v2 (custodial): the
   *  Slay.Market is minted on v2 and each bot bet is recorded as an operator-
   *  signed PmBet on v2 (bettor = the v1 party id as data). Parimutuel pools +
   *  payouts stay in Postgres. Keeps prediction traffic off v1. */
  PREDICTION_V2_ONCHAIN?: string;
  /** CBTC:CC bet mix for the prediction bots when both are live. 0.75 = 3:1
   *  CBTC:CC (default). */
  PREDICTION_CBTC_BET_RATIO?: string;
  /** Per-tick chance each open round receives one bot bet (default 0.15). Spreads
   *  bets across the round's open window instead of bursting at creation. */
  PREDICTION_BOT_ROUND_BET_CHANCE?: string;
  // Dedicated AWS KMS for per-user wallet key custody (self-custody migration).
  // Symmetric ENCRYPT_DECRYPT key; used for envelope encryption of each user's
  // ed25519 private key. Least-privilege IAM user (GenerateDataKey + Decrypt).
  SLAY_KMS_KEY_ID?: string;
  SLAY_KMS_AWS_REGION?: string;
  SLAY_KMS_AWS_ACCESS_KEY_ID?: string;
  SLAY_KMS_AWS_SECRET_ACCESS_KEY?: string;
  /** Common on-chain party hint for ALL self-custody user parties — the part
   *  before "::". Gives every slay user a shared brand prefix
   *  (slay-money::<their-unique-key-fingerprint>) so partners can identify a
   *  transaction as coming from a slay-money user. Default "slay-money". */
  SLAY_PARTY_HINT?: string;
  /** Conservative per-activity traffic burn (KB) for a v2 prediction on-chain
   *  action (Slay.Market create / PmBet). Drives burn-proportional v2 marker
   *  weight + the v2 fair-use burn tracking. Default 8 (below a real create, so
   *  the 1.15× ratio stays safe). */
  V2_ACTIVITY_BURN_KB?: string;
  // Public Splice scan base URL — used for read-only holdings/state lookups
  // when validator-side query 413s on operator party. Defaults to sv-1.
  SPLICE_SCAN_PUBLIC_URL?: string;
  // Shared secret for admin endpoints (market resolution, etc.). Pre-MainNet
  // shortcut — replace with role-based auth before opening these up further.
  ADMIN_SECRET: string;

  /* ---- Agent API: who reviews applications, and whether anyone has to ----
   *
   * AGENT_AUTO_APPROVE   "1" approves every application the moment it is
   *                      submitted. Open access, with the review step wired
   *                      and switched off rather than absent — set it to
   *                      anything else and the queue is manual again, with
   *                      no code change and no deploy.
   *
   *                      Auto-approval still writes ceilings, because an
   *                      approval without one is an unbounded account. It is
   *                      audited as `auto` rather than as a person, so every
   *                      account granted this way can be found again on the
   *                      day the gate goes back on.
   *
   * AGENT_AUTO_APPROVE_PER_TX / _PER_DAY
   *                      Those ceilings, decimal CC. Defaults 25 and 250.
   *                      While access is open these are the ONLY bound on
   *                      what a stranger's program can move, so they are
   *                      deliberately small.
   *
   * AGENT_ALERT_EMAIL    Where application alerts go. Unset means nobody is
   *                      told — which is what happened before this existed:
   *                      the row was written and sat there.
   */
  AGENT_AUTO_APPROVE?: string;
  AGENT_AUTO_APPROVE_PER_TX?: string;
  AGENT_AUTO_APPROVE_PER_DAY?: string;
  AGENT_ALERT_EMAIL?: string;

  /**
   * "1" makes the free tier belong to the account that PAYS rather than to
   * the wallet that sent — a provider's sub-accounts share the provider's
   * three sends a day instead of getting three each.
   *
   * Inert until a partner wallet exists: with no rows in partner_wallets
   * every account bills to itself. The flag is here so the extra lookup can
   * be switched off as well, and so the behaviour can be reverted by changing
   * a secret rather than by shipping a deploy.
   */
  PARTNER_BILLING_ENABLED?: string;

  /**
   * "1" mounts /api/partner/v1. Off by default and checked before
   * authentication, so a disabled surface costs one string comparison and
   * never touches the database.
   *
   * A switch rather than a deploy: while the partner API is young, the answer
   * to it misbehaving should be thirty seconds, not a rollback of everything
   * else that shipped with it.
   */
  PARTNER_API_ENABLED?: string;
  // --- On-chain (Daml) wiring ---------------------------------------------
  // Package id of the uploaded slay-money DAR. Use `daml damlc inspect-dar`
  // to look up after `daml build` if you don't know it. Required when any
  // USE_ONCHAIN_* feature flag is on.
  SLAY_DAR_PACKAGE_ID?: string;
  // Package id of Splice's Amulet DAR on the participant. Used when the
  // backend submits AmuletRules_Transfer directly via the v2 ledger API
  // (Slay.Reward V2 path — real CC moves per signup). On MainNet 0.6.3
  // this is "6c5802f86709a0ad4784af81f0bab40f3070b2f58128d8843da1e1784c147802".
  // Confirm with: query /v2/state/active-contracts and look for any
  // Splice.Amulet:* template id — the prefix before the colon is this.
  SPLICE_AMULET_PACKAGE_ID?: string;
  // DSO party id is no longer read from env — we read it live from the
  // AmuletRules payload per call. Keeping the field around for backward
  // compatibility / sanity-check overrides only.
  SPLICE_DSO_PARTY_ID?: string;
  // Feature flags — when "1" / "true", route the matching service module
  // to the on-chain implementation instead of Postgres-only. Default off so
  // we ship migration features one at a time and can roll back without
  // re-deploying.
  USE_ONCHAIN_MARKETS?: string;
  MULTI_ASSET_MARKETS?: string;
  FEATURED_APP_REWARDS?: string;
  MARKER_BURN_BUDGET_USD?: string;
  /** Minutes between batched marker flushes (default 10). */
  MARKER_FLUSH_MINUTES?: string;
  /** Compliance control: max marker weight a single flush may file (default
   *  150), so accrued weight can never be concentrated into one round. */
  MARKER_MAX_PER_FLUSH?: string;
  // Burn-tied marker weight inputs — weight = floor(factor × burnKb × price /
  // markerValue), so each marker captures the full fair-use reward (reward ≤
  // 1.15× burn) at current prices. All tunable live (no redeploy).
  /** USD burned per KB of traffic (default 0.062). */
  TRAFFIC_PRICE_USD_PER_KB?: string;
  /**
   * The FIXED fair-use accounting unit per marker (featuredAppActivityMarkerAmount,
   * ~$1). This is the value the 1.15x compliance cap counts each marker as — it
   * does NOT fluctuate. Do NOT set this to the diluted pool payout (the ~$0.51
   * "Marker Value" that moves every ~10min); doing so doubles the weight and
   * breaches the cap. Default 1.0. Only change if governance changes the unit.
   */
  MARKER_VALUE_USD?: string;
  /** Fair-use headroom factor, must stay ≤ 1.15 (default 1.1 for a safety buffer). */
  MARKER_FAIRUSE_FACTOR?: string;
  /** Traffic (KB) one token transfer burns, two-phase offer+accept (default 15). */
  TOKEN_TRANSFER_BURN_KB?: string;
  TRANSACTION_FEE_BPS?: string;
  /** Free outgoing sends per user per UTC day before the fee formula applies (default 3). */
  FREE_TXNS_PER_DAY?: string;
  /** Same, for is_synthetic bots only (default 4). Real users are unaffected. */
  SYNTHETIC_FREE_TXNS_PER_DAY?: string;
  /** Dust floor on every send, in USD, excluding the fee. Default 0.20. */
  MIN_SEND_USD?: string;
  /** Bursty CC bot-to-bot volume. Deliberately separate from the CBTC knobs. */
  SYNTHETIC_CC_VOLUME_ENABLED?: string;
  SYNTHETIC_CC_MIN_CC?: string;
  SYNTHETIC_CC_MAX_PCT?: string;
  SYNTHETIC_CC_MAX_BURST?: string;
  /** Target CC bot transfers per day (default 350). Shape stays bursty. */
  SYNTHETIC_CC_PER_DAY?: string;
  FEE_CC_INTERNAL_CC?: string;
  FEE_CC_EXTERNAL_CC?: string;
  FEE_TOKEN_INTERNAL_CC?: string;
  FEE_TOKEN_EXTERNAL_CC?: string;
  SLAY_FEES_PARTY?: string;
  SLAY_PREDICTION_PARTY?: string;
  /** validator-2 operator party (fee-input provider for v2 preapprovals). */
  SLAY_V2_VALIDATOR_PARTY?: string;
  /* ── Brale (smUSD custodial stablecoin) ── */
  BRALE_ENABLED?: string;
  BRALE_CLIENT_ID?: string;
  BRALE_CLIENT_SECRET?: string;
  BRALE_API_URL?: string;
  BRALE_AUTH_URL?: string;
  BRALE_ACCOUNT_ID?: string;
  /** Our smUSD treasury Canton address_id on Brale (slay-money-validator). */
  BRALE_SMUSD_ADDRESS_ID?: string;
  /** smUSD value_type code Brale uses in transfers (confirm from a live resp). */
  BRALE_SMUSD_VALUE_TYPE?: string;
  SLAY_WALLET_FEATURED_RIGHT_CID?: string;
  SLAY_PREDICTION_FEATURED_RIGHT_CID?: string;
  SLAY_PREDICTION_FEATURED_RIGHT_BLOB?: string;
  /** v2 FeaturedAppRight (held by SLAY_V2_VALIDATOR_PARTY) — used to file markers
   *  for on-chain PmBet/escrow activity on the v2 participant so v2 earns rewards. */
  SLAY_V2_FEATURED_RIGHT_CID?: string;
  SLAY_V2_FEATURED_RIGHT_BLOB?: string;
  USE_ONCHAIN_TRADE?: string;
  USE_ONCHAIN_P2P?: string;
  USE_ONCHAIN_REWARDS?: string;
  USE_ONCHAIN_SEND?: string;

  /** Kill switch for the 50 CC welcome bonus. Truthy string ⇒ DISABLED:
   *    "1", "true", "yes", "on" ⇒ bonus is OFF
   *    "0", "false", "no", "off", "" or unset ⇒ bonus is ON
   *  When OFF:
   *  - auth.ts skips auto-grant on signup
   *  - /signup-bonus/claim returns 410 Gone
   *  - claimSignupBonusFor throws 410
   *  - the retry cron skips the signup-bonus loop entirely
   *  Set when the welcome bonus needs to be retired (e.g. CBTC
   *  migration, treasury preservation) without code changes.
   *  Use isSignupBonusDisabled(env) from rewards/config — NEVER
   *  string-compare this directly. */
  SIGNUP_BONUS_DISABLED?: string;
  /** Master rewards kill-switch → "coming soon" (pauses milestone/referral claims). */
  REWARDS_COMING_SOON?: string;
  /** Maintenance switch: when on, blocks NEW account creation (existing users
   *  can still log in). Set to stop the bot-signup abuse. Parse via
   *  isSignupsFrozen(env) — never string-compare directly. */
  SIGNUPS_FROZEN?: string;
  /** "1" enables the repeat-deposit reconcile cron (credits on-chain−pgTotal
   *  for non-bettors). Off by default so it can't run unreviewed. */
  REPEAT_RECONCILE_ENABLED?: string;
  /** "1" = app-wide read-only lockdown: every account except the lockdown
   *  allowlist is frozen to balance-view only (all mutations 503). */
  APP_LOCKDOWN?: string;

  /** Master switch for the Slay Reward Program rollout. When truthy (the
   *  DEFAULT — unset counts as ON), brand-new signups get NO Canton party
   *  and NO 50 CC welcome bonus; they land in the points-only Slay Reward
   *  program instead (src/slay-rewards/*). Existing users who already have a
   *  party (wallets.cantonAddress set) are unaffected — they keep full app
   *  access. Set to "0"/"false"/"no"/"off" to restore legacy behaviour where
   *  every signup gets a party (useful for local ledger testing).
   *  Parse via isPartyCreationDisabled(env) from slay-rewards/config —
   *  NEVER string-compare directly (the default-ON semantics are subtle). */
  PARTY_CREATION_DISABLED?: string;

  /** Master switch for the synthetic CBTC volume generator
   *  (src/synthetic/volume-cron.ts). When truthy, the 1-minute cron
   *  fires 2-6 random user→user CBTC transfers from the
   *  is_synthetic=true user pool, targeting ~16s average inter-tx
   *  cadence for the BitSafe Incentives dashboard. Off by default —
   *  flip on only after running POST /api/admin/synthetic/seed to
   *  populate the pool. Accepts 1/true/yes/on (case-insensitive). */
  SYNTHETIC_VOLUME_ENABLED?: string;

  /** Pause the prediction market: when on, all bet/parlay/cashout mutations
   *  under /api/markets and /api/parlay return 503. Browsing (GET) + the rest
   *  of the app (wallet/send/withdraw) stay fully open. Accepts 1/true/yes/on. */
  MARKETS_FROZEN?: string;
  /** Restore the old Postgres-only fallback on on-chain send failure (default
   *  OFF = strict on-chain-only; a failed transfer errors instead of creating
   *  an unbacked balance). Only enable if the network goes intermittent. */
  SEND_POSTGRES_FALLBACK?: string;

  /* ──────────────────────────────────────────────────────────────
   *  CBTC (BitSafe Finance) — Phase A integration
   *
   *  Slay extends to CBTC alongside CC. Auth flow: Keycloak service
   *  account at operator level (one token, all users via grantUserActAs).
   *  The participant needs to be configured to trust BitSafe's
   *  Keycloak as a JWT issuer — see /docs/cbtc.md (to be added).
   * ────────────────────────────────────────────────────────────── */
  /** Master switch — when "1" / "true", CBTC routes are mounted and the
   *  Keycloak JWT minter is allowed to run. Default off so nothing
   *  fires until credentials + participant config are in place. */
  CBTC_ENABLED?: string;
  /** BitSafe Token Standard registry — MainNet:
   *  https://api.utilities.digitalasset.com */
  CBTC_REGISTRY_URL?: string;
  /** BitSafe's CBTC network operator party (admin for the instrument).
   *  NOT our validator. MainNet:
   *  cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262 */
  CBTC_ADMIN_PARTY?: string;
  /** Instrument id — for CBTC this is the literal string "CBTC". */
  CBTC_INSTRUMENT_ID?: string;
  /** OIDC service account — provided during BitSafe partner onboarding.
   *  Keycloak is officially supported by BitSafe; Auth0 works with the
   *  extra `audience` claim. We use the OAuth2 client_credentials grant
   *  (server-to-server) for one JWT at operator level, reused across
   *  all CBTC ops via cached/refreshed access tokens. */
  CBTC_KEYCLOAK_HOST?: string;
  CBTC_KEYCLOAK_REALM?: string;
  CBTC_KEYCLOAK_CLIENT_ID?: string;
  /** Client secret for the OAuth2 client_credentials grant. Never expose
   *  in client/frontend code — this is a backend-only secret. */
  CBTC_KEYCLOAK_CLIENT_SECRET?: string;
  /** Required for Auth0, ignored by Keycloak. Set to the participant's
   *  Ledger API base URL (e.g. https://ledger.mainnet-validator.slay.money/v2/).
   *  Without it, Auth0 returns an opaque token the participant rejects. */
  CBTC_KEYCLOAK_AUDIENCE?: string;
  /** Token endpoint path prefix. Modern Keycloak (17+) uses
   *  "/realms/<realm>/..." (no prefix). Older Keycloak uses
   *  "/auth/realms/<realm>/...". Set to "auth" for older Keycloak,
   *  leave empty (default) for modern. Auth0 ignores this since we
   *  go through /oauth/token regardless. */
  CBTC_KEYCLOAK_PATH_PREFIX?: string;
  /** Set to "auth0" when using Auth0 instead of Keycloak. Changes the
   *  endpoint path to /oauth/token (Auth0 convention) instead of
   *  Keycloak's /realms/.../protocol/openid-connect/token. */
  CBTC_KEYCLOAK_PROVIDER?: string;
  /** Package id (64-char hex hash) of BitSafe's `utility-registry-app-v0`
   *  DAR that defines the `Utility.Registry.Holding:Holding` template.
   *  Used to construct a TemplateFilter on /v2/state/active-contracts
   *  queries so the participant filters server-side, avoiding the 200-
   *  element response cap. BitSafe's metadata registry doesn't return
   *  this on MainNet (June 2026), so we plug it in via env.
   *
   *  Look it up from the DAR you uploaded to the participant:
   *    unzip -p ~/cbtc-dars/utility-registry-app-v0-*.dar META-INF/MANIFEST.MF \
   *      | grep Main-Dalf
   *  The 64-char hex prefix before "-utility-registry-app-v0.dalf" is the
   *  package id. Rotate this when BitSafe ships a DAR upgrade. */
  CBTC_HOLDING_TEMPLATE_PACKAGE_ID?: string;
  /** Package id of the Splice Token Standard `HoldingV1` interface DAR
   *  (`splice-api-token-holding-v1`). Used as fallback to TemplateFilter
   *  via InterfaceFilter — Canton 3.5.1 ignores the former in our setup
   *  but may honor the latter. Extracted from the same DAR-inspect
   *  workflow as the concrete template package id. */
  CBTC_HOLDING_INTERFACE_PACKAGE_ID?: string;
  /** Trim BitSafe-registry-supplied disclosedContracts down to only those
   *  cids actually referenced by the exercise's choiceContextData. Cuts
   *  per-tx traffic cost ~30%. Off by default — set to "1" to enable
   *  after dry-run logs confirm savings without participant errors. */
  CBTC_TRIM_DISCLOSED?: string;
  /** Kill switch for the 1-min accept-cron. "0" = skip the tick.
   *  Use to stop traffic burn from backlog drain while keeping synth
   *  volume + user-facing CBTC sends running (those go through transferCbtc,
   *  gated only on CBTC_ENABLED). */
  CBTC_ACCEPT_CRON_ENABLED?: string;
  /** Set to "0" to disable the v2 prediction-party registry accept-cron. */
  V2_ACCEPT_CRON_ENABLED?: string;
  /** Override the accept-cron per-tick cap. Default 10. Bump for backlog drain. */
  ACCEPT_CRON_MAX_PER_TICK?: string;
  /** Override the accept-cron parallel concurrency. Default 2. */
  ACCEPT_CRON_CONCURRENCY?: string;
  /** Fire synth volume only every N minutes. Default 1 = every tick. */
  SYNTHETIC_THROTTLE_MINUTES?: string;
  /** When set (>0), each firing sends EXACTLY this many synth txs instead of
   *  the bursty 0-N draw. Set to 1 (with THROTTLE_MINUTES=10) for a steady
   *  "1 tx per 10 min". */
  SYNTHETIC_TX_PER_FIRE?: string;
  /** Traffic-cost gate for synthetic volume. Below this much free base traffic
   *  (bytes) we treat the validator as running on PURCHASED traffic and only
   *  generate volume when the marker beats SYNTHETIC_MARKER_MIN_USD. */
  SYNTHETIC_FREE_MIN_BYTES?: string;
  /** Min marker value (USD) to keep generating synthetic volume while burning
   *  PURCHASED traffic. Default 0.5. On free traffic this check is skipped. */
  SYNTHETIC_MARKER_MIN_USD?: string;
  /** cETH synthetic volume kill-switch. "1" = on. Independent of the CBTC one. */
  SYNTHETIC_CETH_VOLUME_ENABLED?: string;
  /** Target cETH synthetic transfers per day (default 20). */
  SYNTHETIC_CETH_PER_DAY?: string;
  /** Min cETH send amount in raw units (default 500). */
  SYNTHETIC_CETH_MIN_RAW?: string;
  /** Max cETH send as a fraction of sender balance (default 0.05). */
  SYNTHETIC_CETH_MAX_PCT?: string;
  /** tUSD synthetic volume kill-switch. "1" = on. Independent of the others. */
  SYNTHETIC_TUSD_VOLUME_ENABLED?: string;
  /** Target tUSD synthetic transfers per day (default 144 = ~1 per 10 min). */
  SYNTHETIC_TUSD_PER_DAY?: string;
  /** Min tUSD send amount in raw units (default 500). */
  SYNTHETIC_TUSD_MIN_RAW?: string;
  /** Max tUSD send as a fraction of sender balance (default 0.05). */
  SYNTHETIC_TUSD_MAX_PCT?: string;
  /** Run the 5-min preapproval backfill cron. "1" = on. Default off so
   *  manual drains via /admin/cc/backfill-preapprovals don't compete
   *  with the auto-cron for operator-amulet cache writes. */
  PREAPPROVAL_BACKFILL_CRON_ENABLED?: string;
  /** Live-credit inbound external CC receives that the chain settled but
   *  Postgres never recorded (event-mirror has no Amulet handler). "1" =
   *  actually credit. Default OFF = the cron runs in DRY-RUN, logging what
   *  it WOULD credit without mutating balances. Flip to "1" only after the
   *  dry-run logs confirm the detected amounts are correct — this moves
   *  real money. */
  CC_INBOUND_CREDIT_ENABLED?: string;
  /** Event-driven deposit crediter (deposit-trees.ts). Walks /v2/updates/trees
   *  by user party, credits external deposits with their real on-chain
   *  updateId. Default = DRY-RUN (logs "WOULD credit", mutates nothing). "1" =
   *  live — this REPLACES the watermark deposit crediter, so flip it on in the
   *  same change that disables reconcileWatermarkDeposits or you double-credit. */
  DEPOSIT_TREES_ENABLED?: string;
  /** When "1", exercise() logs the submission body + disclosed-blob byte sizes
   *  per call ("[traffic] choice=… bodyBytes=…"). Measures per-tx sequencer
   *  traffic cost. Cheap + gated; safe to leave off. */
  TRAFFIC_DEBUG?: string;
  /** Async bet settlement: bet is instant in Postgres (balance→locked), then
   *  PlaceBet + real CC escrow (user→operator) settle on-chain in the
   *  background (ctx.waitUntil) + a reconcile cron. "1" = live. Default = the
   *  current synchronous on-chain placeBet. */
  ASYNC_BET_ESCROW?: string;
  /** Early cash-out feature. "1" = live. Lets a user exit an open, escrow-
   *  settled bet before resolution for an EV-fair value. */
  CASHOUT_ENABLED?: string;
  /** CBTC bet escrow: when "1", a CBTC prediction bet moves the real CBTC
   *  stake on-chain (user→operator via the Token Standard) instead of being
   *  Postgres-only. Mirrors ASYNC_BET_ESCROW for the CC path. */
  CBTC_BET_ESCROW?: string;

  /* ──── CETH (Canton ETH — onrails, on the shared DA "utilities" Token
   *  Standard registry, same platform as CBTC, different issuer) ──── */
  /** Enable CETH ops. Default off until config + participant DAR are in place. */
  CETH_ENABLED?: string;
  /** Token Standard registry — MainNet https://api.utilities.digitalasset.com
   *  (SAME base URL as CBTC; the registry hosts multiple issuers). */
  CETH_REGISTRY_URL?: string;
  /** cETH issuer/admin party (NOT our validator). MainNet:
   *  rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a */
  CETH_ADMIN_PARTY?: string;
  /** Instrument id — the literal string "cETH". */
  CETH_INSTRUMENT_ID?: string;
  /** Auth for the transfer-factory endpoint. Registry METADATA is public
   *  (no auth), but the transfer-factory POST may need an OIDC token like
   *  CBTC's. TBD during the transfer build — reuse CBTC_KEYCLOAK_* if onrails
   *  shares DA utilities auth, else set these. */
  CETH_KEYCLOAK_HOST?: string;
  CETH_KEYCLOAK_REALM?: string;
  CETH_KEYCLOAK_CLIENT_ID?: string;
  CETH_KEYCLOAK_CLIENT_SECRET?: string;
  CETH_KEYCLOAK_AUDIENCE?: string;
  CETH_KEYCLOAK_PATH_PREFIX?: string;

  /* ── tUSD (TradeFast USD stablecoin) — Token Standard, same DA-utilities
   *  registry as cETH/CBTC, issuer tradefast-wallet3-1. ──── */
  TUSD_ENABLED?: string;
  /** MainNet https://api.utilities.digitalasset.com (shared registry). */
  TUSD_REGISTRY_URL?: string;
  /** tUSD issuer/admin party: tradefast-wallet3-1::1220674b… */
  TUSD_ADMIN_PARTY?: string;
  /** Instrument id — the literal string "tf-usdt". */
  TUSD_INSTRUMENT_ID?: string;
  TUSD_KEYCLOAK_PROVIDER?: string;
  TUSD_KEYCLOAK_HOST?: string;
  TUSD_KEYCLOAK_REALM?: string;
  TUSD_KEYCLOAK_CLIENT_ID?: string;
  TUSD_KEYCLOAK_CLIENT_SECRET?: string;
  TUSD_KEYCLOAK_AUDIENCE?: string;
  TUSD_KEYCLOAK_PATH_PREFIX?: string;
  TUSD_BET_ESCROW?: string;
  TUSD_HOLDING_TEMPLATE_PACKAGE_ID?: string;
  TUSD_HOLDING_INTERFACE_PACKAGE_ID?: string;
  /* ── HECTO — Token Standard, same DA-utilities registry, issuer
   *  Hecto-Finance-1. Instrument "HECTO", decimals 10. ──── */
  HECTO_ENABLED?: string;
  HECTO_REGISTRY_URL?: string;
  HECTO_ADMIN_PARTY?: string;
  HECTO_INSTRUMENT_ID?: string;
  HECTO_KEYCLOAK_PROVIDER?: string;
  HECTO_KEYCLOAK_HOST?: string;
  HECTO_KEYCLOAK_REALM?: string;
  HECTO_KEYCLOAK_CLIENT_ID?: string;
  HECTO_KEYCLOAK_CLIENT_SECRET?: string;
  HECTO_KEYCLOAK_AUDIENCE?: string;
  HECTO_KEYCLOAK_PATH_PREFIX?: string;
  HECTO_BET_ESCROW?: string;
  HECTO_HOLDING_TEMPLATE_PACKAGE_ID?: string;
  HECTO_HOLDING_INTERFACE_PACKAGE_ID?: string;
  /** HECTO to USD rate (no market feed). Default 0.00279361. Served by
   *  /api/prices/hecto so the app can show a dollar value. Tunable live. */
  HECTO_USD_RATE?: string;
  CETH_KEYCLOAK_PROVIDER?: string;
  /** Holding template/interface package ids (server-side TemplateFilter to
   *  dodge the 200-element ACS cap), same role as the CBTC_HOLDING_* ids. */
  CETH_HOLDING_TEMPLATE_PACKAGE_ID?: string;
  CETH_HOLDING_INTERFACE_PACKAGE_ID?: string;
  /** CETH bet escrow — move the real cETH stake on-chain per bet. */
  CETH_BET_ESCROW?: string;
  /** Cash-out spread in bps taken on top of the market's house edge.
   *  cashout = stake × (1 − houseEdge) × (1 − spread). Default 500 (5%). */
  CASHOUT_SPREAD_BPS?: string;
  /** No cash-out within this many seconds of the market's closesAt (stops
   *  last-minute arbitrage of near-certain outcomes). Default 300 (5 min). */
  CASHOUT_CUTOFF_SECONDS?: string;
  /** Kill switch for the 5-min reconciliation sweep. "0"/"false" = skip. */
  RECONCILE_SWEEP_ENABLED?: string;
  /** Enable credit-only mirror catchup — fills Postgres from on-chain diff
   *  every 5 min. Never debits. Safe alongside inbound-mirror. "1" = live. */
  INBOUND_CATCHUP_ENABLED?: string;

  /* ──────────────────────────────────────────────────────────────
   *  Event Discovery Engine (auto market generation — June 2026)
   *
   *  A cron-driven funnel that ingests trending topics across domains
   *  (sports, finance, crypto, weather, politics, news, …), scores them,
   *  and turns the best into resolvable prediction-market candidates.
   *  See src/discovery/*. Everything is additive + heavily gated so it
   *  ships dark and is flipped on per-environment.
   * ────────────────────────────────────────────────────────────── */
  /** Master switch — when truthy ("1"/"true"/"yes"/"on"), the 5-min
   *  cron runs a discovery tick. Off by default so nothing fires until
   *  sources/keys are confirmed. The per-tick work is also gated by the
   *  live discovery_config.enabled flag (admin-toggleable). */
  DISCOVERY_ENABLED?: string;
  /** Prediction-market kill switch. When "0", bet placement + challenge
   *  creation return 503 (temporary pause). Anything else = enabled. */
  PREDICTION_ENABLED?: string;
  /** Per-bet stake caps by currency (0 = no cap). CC default 50. */
  PREDICTION_MAX_BET_CC?: string;
  PREDICTION_MAX_BET_CBTC_SAT?: string;
  PREDICTION_MAX_BET_CETH_UNITS?: string;
  PREDICTION_MAX_BET_TUSD?: string;
  /** Synthetic bot betting on the crypto up/down rounds. "1" = bots place
   *  parimutuel bets (CC + CBTC) to seed pools + the live our-side %. */
  PREDICTION_BOT_BETS_ENABLED?: string;
  /** Max bot bets fired per 1-min tick (bursty draw up to this). Default 1 —
   *  keep low, each is an on-chain PlaceBet when USE_ONCHAIN_MARKETS=1. */
  PREDICTION_BOT_BETS_PER_TICK?: string;
  /** Mint each crypto up/down round as a CC + CBTC group so a CBTC pool exists
   *  alongside CC (CBTC bots + real users bet into it). "1" = on. */
  PREDICTION_CBTC_ENABLED?: string;
  /** Polymarket-style CLOB engine. When "1", markets trade as YES/NO shares
   *  on an order book (src/clob/*) instead of the parimutuel pools. Off by
   *  default until the CLOB is verified end-to-end. */
  CLOB_MARKETS_ENABLED?: string;
  /** Operator market-maker (src/clob/mm.ts): an onboarded user, funded with CC,
   *  that posts resting two-sided quotes so books aren't empty. MM inert unless
   *  this + a positive depth are set. */
  CLOB_MM_USER_ID?: string;
  /** MM quote spread in bps (default 400 = 4%). */
  CLOB_MM_SPREAD_BPS?: string;
  /** MM depth per quote, in shares/smallest-CC-units (default 0 = MM off). */
  CLOB_MM_DEPTH?: string;
  /** Max markets the MM quotes per tick (default 20). */
  CLOB_MM_MAX_MARKETS?: string;
  /** Trade (positions) kill switch. When "0", opening new positions returns
   *  503; closing stays allowed so users can still exit. */
  TRADE_ENABLED?: string;
  /** Polymarket MIRROR (src/polymarket/*) — the custodial-hedge model, distinct
   *  from the older POLYMARKET_ENABLED importer below. When "1", the read-only
   *  mirror market catalog + live-price endpoints are exposed. Phase 1 is
   *  display-only: no wallet, no orders, no capital. Off by default. */
  POLYMARKET_MIRROR_ENABLED?: string;
  /** Curated allowlist of Polymarket conditionIds to mirror (comma-separated).
   *  Empty = show top markets by liquidity. Lets us hand-pick "selected bets". */
  POLYMARKET_FEATURED_CONDITIONS?: string;
  /** PM MIRROR betting (src/polymarket/orchestrate.ts). "1" lets users PLACE
   *  Up/Down bets in CC/CBTC (Postgres debit + position record). Off by default;
   *  requires POLYMARKET_MIRROR_ENABLED too. */
  PM_BET_ENABLED?: string;
  /** When "1", the background settle path does the REAL on-chain legs — CC/CBTC
   *  escrow user→prediction party + PmBet create/settle on v2 + exec hedge. When
   *  off (default), bets are Postgres-mirror + dry-run only (no chain, no capital).
   *  Flip this ONLY once the VPS exec service + USDC float + legal are live. */
  PM_BET_LIVE?: string;
  /** Package id of the Slay.PmMirror DAR uploaded to validator-2 (the on-chain
   *  PmBet custody contract). Required when PM_BET_LIVE=1. */
  PM_MIRROR_PACKAGE_ID?: string;
  /** UN-HEDGED MODE. "1" = the house takes the other side itself: no Polymarket
   *  hedge is placed, the fill is locked from the live Polymarket odds at bet
   *  time, and winners are paid from the treasury (SLAY_PREDICTION_PARTY). This
   *  is the model — it needs no exec VPS and isn't affected by the Polymarket
   *  geo-block. When "0", the old hedge path runs (needs the exec service).
   *  Independent of PM_BET_LIVE, which still gates whether escrow/payout are
   *  real on-chain (1) or Postgres-only simulation (0). */
  PM_UNHEDGED?: string; // default "1"
  /** Onboard new users onto their OWN KMS-keyed `slay-money::` party rather
   *  than a Splice-custodial one. Default ON — self-custody is the model, and a
   *  custodially-onboarded user is invisible to looksExternalParty(), so their
   *  balance reads from the pg shadow and their sends can't be KMS-signed.
   *  Set "0" only as an escape hatch if external signing is down. */
  SELF_CUSTODY_ONBOARDING?: string;
  /** "1" = refuse real-user PM bets (bots-only monitoring window). */
  PM_BOTS_ONLY?: string;
  /** STAGED ROLLOUT — restrict betting to specific app builds while the master
   *  switches are on. Comma-separated `platform@version` or
   *  `platform@version+build` entries, matched against the client's
   *  `x-slay-app` header (e.g. "ios@1.0.0" or "ios@1.0.0+22").
   *
   *  Empty/unset = every client (current behaviour). When SET, a client that
   *  sends no header is REFUSED — that is the point: old builds predate the
   *  header and must not be let in. Android is on its own version line
   *  (1.0.1), so "ios@1.0.0" cleanly isolates the iOS line. */
  PM_BET_ALLOWED_APPS?: string;
  /** Comma-separated emails that may always bet, regardless of
   *  PM_BET_ALLOWED_APPS. For App Store review accounts and our own testing —
   *  it needs no app change, so it works on builds already in the wild. Still
   *  requires the master PM_BET_ENABLED / POLYMARKET_MIRROR_ENABLED. */
  PM_BET_ALLOWLIST?: string;
  /** Exposure caps (USD), enforced at placement for REAL users only — bots
   *  never create real exposure. A cap ≤ 0 disables that check.
   *   · USER_ROUND  — max a single user can stake on one window.
   *   · ROUND_EXPO  — max house NET exposure on one window (Σ potential net
   *                   winnings; backing longshots costs more here).
   *   · OPEN_EXPO   — max house net exposure across ALL open windows; the
   *                   treasury-solvency guard. Keep it well under the funded
   *                   treasury balance so a bad run can't overdraw it. */
  PM_MAX_USER_ROUND_USD?: string; // default 50
  PM_MAX_ROUND_EXPOSURE_USD?: string; // default 500
  PM_MAX_OPEN_EXPOSURE_USD?: string; // default 2000
  /** USD stake bounds per bet (validated only when the FX rates below are set). */
  PM_MIN_STAKE_USD?: string; // default 1
  PM_MAX_STAKE_USD?: string; // default 100
  /** Max cents the live book may have moved between the price the user tapped
   *  and the price we fill at. Beyond it the bet is REFUSED and the user
   *  re-confirms, rather than being silently filled at a price they never saw.
   *  0 disables the check (don't — that's the bug this shipped to fix). */
  PM_MAX_SLIPPAGE_CENTS?: string; // default 3
  /** Minimum price (in cents) a REAL user may back. Below it the payout
   *  multiplier runs away — 10c pays ~9.8x, 2c pays ~49x — and in the
   *  un-hedged model the treasury funds all of it. Bots are exempt (they
   *  settle in simulation). 0 disables the floor. */
  PM_MIN_ODDS_CENTS?: string; // default 10
  /** Early close ("cash out"), the mirror of Polymarket's sell. Off unless
   *  "1". Value is marked to market off the live book:
   *      stake × (livePrice / entryPrice) × (1 − SPREAD_BPS)
   *  CUTOFF_SEC refuses a close in the last seconds of a window, where the
   *  book is thin and the outcome is nearly known. */
  PM_CASHOUT_ENABLED?: string;
  PM_CASHOUT_SPREAD_BPS?: string; // default 300 (3%)
  PM_CASHOUT_CUTOFF_SEC?: string; // default 20
  /** Placeholder FX until the Phase-3 oracle: USD per 1 CC / 1 CBTC. 0/unset →
   *  usdEquiv recorded as 0 and stake bounds skipped (dry-run scaffolding). */
  PM_CC_USD?: string;
  PM_CBTC_USD?: string;
  /** LetsExchange swap on/off ramp (src/letsexchange/*). Bearer API key. */
  LETSEXCHANGE_API_KEY?: string;
  /** Override the API base (default https://api.letsexchange.io/api). */
  LETSEXCHANGE_BASE_URL?: string;
  /** When "1", the swap deposit endpoints are live. Off by default. */
  LETSEXCHANGE_ENABLED?: string;
  /** When "1", CC→asset WITHDRAW swaps are live. Separate + OFF by default:
   *  a withdraw sends real CC to LetsExchange's address with a memo, and until
   *  a controlled test confirms they read the on-chain `description` as that
   *  memo, enabling this risks lost funds. */
  LETSEXCHANGE_WITHDRAW_ENABLED?: string;
  /** LetsExchange affiliate id. REQUIRED to earn the partner revenue share —
   *  their docs: "To receive an affiliate fee from a transaction, the API query
   *  must include the following parameter: affiliate_id." Without it every swap
   *  earns Slay nothing. Get the exact value from the LetsExchange partner
   *  account; do NOT guess (a wrong id pays someone else). */
  LETSEXCHANGE_AFFILIATE_ID?: string;
  /* ── OneSwap — NATIVE Canton swaps (src/oneswap/*) ────────────────
   * Atomic DvP DEX on Canton: CC ↔ CBTC ↔ HECTO, on-ledger. Distinct
   * from LETSEXCHANGE_* above, which ramps to assets on OTHER chains.
   * Both mention "bitcoin"; that one means BTC on Bitcoin, this one
   * means CBTC on Canton. Neither replaces the other. */
  /** Integrator SDK key, `sk_live_` + 48 hex. Sent as `x-sdk-key`.
   *  SERVER-SIDE ONLY — it is not per-user and must never be shipped to
   *  the extension or a browser. */
  ONESWAP_API_KEY?: string;
  /** "devnet" targets devnet.api.oneswap.cc; anything else is mainnet. */
  ONESWAP_ENV?: string;
  /** Escape hatch for a non-standard base URL. Normally leave unset —
   *  ONESWAP_ENV resolves the right one. */
  ONESWAP_BASE_URL?: string;
  /** When "1", the native swap endpoints are live. Off by default. */
  ONESWAP_ENABLED?: string;
  /** When "1", CBTC/HECTO may be the swap INPUT. Separate + OFF by
   *  default: CC leaves via a one-step transfer preapproval, but token-
   *  standard assets leave via a TWO-PHASE TransferInstruction that the
   *  RECEIVER must accept. Whether OneSwap's per-swap deposit parties
   *  auto-accept one is unverified, and a transfer nobody accepts is
   *  funds parked in a pending contract. CC→token needs no such test
   *  and works with this off. */
  ONESWAP_TOKEN_INPUT_ENABLED?: string;
  /** Refuse swaps whose price impact exceeds this percentage. Default 10.
   *  Not a nicety: the CC/CBTC pool held ~$2.4k at integration time, where
   *  5,000 CC costs 16% and 20,000 CC costs 43%. This is the only check
   *  that a direct API caller cannot skip. */
  ONESWAP_MAX_PRICE_IMPACT_PCT?: string;
  /** Slippage tolerance in bps used to derive minOut. Default 200, matching
   *  OneSwap's own default — but always sent explicitly, because on pools
   *  this thin the default is a choice rather than an obvious answer. */
  ONESWAP_SLIPPAGE_BPS?: string;
  /** Slay markup in bps applied on top of the 0.2% base partner share, for
   *  display only — the real fee split (0.5% total: 0.2% LetsExchange, 0.3%
   *  Slay) is configured on the LetsExchange partner account. Default 100. */
  LETSEXCHANGE_MARKUP_BPS?: string;
  /** Slay-rewards points-earning kill switch. When "0", daily check-in +
   *  task claims return 503 and the app disables the tap-to-earn UI. */
  REWARDS_EARNING_ENABLED?: string;
  // Reward-task verification credentials (all optional; a verifier fails safe
  // until its credential is set). See slay-rewards/verifiers.ts.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_GROUP_CHAT_ID?: string;
  /** Public invite link to the community group (t.me/…). If unset, the bot
   *  fetches it via getChat.invite_link (needs the bot to be a group admin). */
  TELEGRAM_GROUP_LINK?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SLAY_X_USER_ID?: string;
  X_OAUTH_CLIENT_ID?: string;
  X_OAUTH_CLIENT_SECRET?: string;
  LINKEDIN_OAUTH_CLIENT_ID?: string;
  LINKEDIN_OAUTH_CLIENT_SECRET?: string;
  /** Hourly crypto up/down oracle markets. When "1", the 1-min cron opens
   *  a fresh BTC/ETH round each hour (strike = Pyth spot at the top of the
   *  hour) and resolves the previous one against the Pyth spot at close.
   *  Off by default. */
  HOURLY_MARKETS_ENABLED?: string;
  /** Polymarket mirror. When "1", the cron imports active Polymarket markets
   *  (politics/sports/culture/…) and auto-resolves them from Polymarket's
   *  settlement. Off by default. */
  POLYMARKET_ENABLED?: string;
  /** When "1", the importer actually publishes (mints markets). When unset,
   *  it runs DRY-RUN — fetch + map + log only, no markets created. Keep off
   *  until you've eyeballed the candidate quality. */
  POLYMARKET_PUBLISH_ENABLED?: string;
  /** Max markets to import per cron tick (default 8). */
  POLYMARKET_MAX_IMPORT?: string;
  /** Cricket markets via The Odds API. When "1", the cron imports upcoming
   *  cricket fixtures as "who wins" markets. Off by default. */
  CRICKET_ENABLED?: string;
  /** When "1" the cricket importer publishes; unset = dry-run (log only). */
  CRICKET_PUBLISH_ENABLED?: string;
  /** the-odds-api.com API key (free tier). Required for cricket import. */
  ODDS_API_KEY?: string;
  /** Max cricket markets per import (default 8). */
  CRICKET_MAX_IMPORT?: string;
  /** Hours between live cricket API pulls (quota throttle, default 6). */
  CRICKET_REFRESH_HOURS?: string;
  /** cricapi.com API key — enables cricket auto-resolution (winner from the
   *  official result). Without it, cricket markets resolve manually. */
  CRICAPI_KEY?: string;
  /** How many waitlisted users are onboarded each week. Drives the lounge's
   *  onboarding-gate progress ("Top N this week"). Default 250. */
  WAITLIST_BATCH_SIZE?: string;
  /** Multi-sport markets via The Odds API (football, basketball, NFL, MMA…).
   *  When "1" the cron imports upcoming fixtures as "who wins" markets.
   *  Shares ODDS_API_KEY with the cricket importer. Off by default. */
  SPORTS_ENABLED?: string;
  /** When "1" the sports importer publishes; unset = dry-run (log only). */
  SPORTS_PUBLISH_ENABLED?: string;
  /** Comma-separated Odds API sport GROUPS to carry, e.g.
   *  "Soccer,Basketball,Mixed Martial Arts". Defaults to soccer, basketball,
   *  American football and MMA. Cricket is excluded — it has its own
   *  importer with its own throttle and resolution path. */
  SPORTS_GROUPS?: string;
  /** Max sports markets created per import run (default 12). */
  SPORTS_MAX_IMPORT?: string;
  /** Max sport keys walked per run. EVERY key costs one API request, so this
   *  is the main quota lever (default 6). */
  SPORTS_MAX_LEAGUES?: string;
  /** Hours between live sports API pulls (quota throttle, default 6). */
  SPORTS_REFRESH_HOURS?: string;
  /** Set "0" to stop syncing live scorelines while leaving sports markets
   *  running — the kill switch to pull if the Odds API quota gets tight. */
  SPORTS_LIVE_SCORES?: string;
  /** Max sport keys the score sync fetches per run (default 4). One request
   *  per key, covering every in-play fixture in that sport. */
  SPORTS_SCORES_MAX_KEYS?: string;
  /** Minimum seconds between score pulls for the same sport (default 120),
   *  so a 1-minute cron doesn't become a 1-minute poll. */
  SPORTS_SCORES_REFRESH_SECONDS?: string;
  /** Anthropic API key for the LLM market generator. When ABSENT the
   *  engine still runs but only TEMPLATE generation (crypto thresholds,
   *  structured fixtures) is available — LLM phrasing of news/politics
   *  markets is skipped. Backend-only secret; never expose to clients. */
  ANTHROPIC_API_KEY?: string;
  /** Model id for generation. Defaults to a fast, cheap Claude model
   *  ("claude-haiku-4-5") since generation is high-volume + low-stakes
   *  (a strict validator + moderation queue catches mistakes). */
  ANTHROPIC_MODEL?: string;

  /* ── Optional discovery DATA-SOURCE keys ──────────────────────────
   *  All optional. The engine runs on free, no-key sources (RSS +
   *  GDELT) without any of these. Provide a key to unlock its adapter
   *  (adapters are wired per-key as they're enabled). Unset = that
   *  source is simply skipped. Backend-only secrets — never client-side.
   *
   *  Two registries (the reference's discovery-vs-resolution split):
   *    • DISCOVERY (broad, noisy)  — find what's rising early.
   *    • RESOLUTION (authoritative) — decide payouts. Marked [RESOLVE].
   * ───────────────────────────────────────────────────────────────── */

  // News / breaking-events (discovery breadth)
  NEWSAPI_KEY?: string;            // newsapi.org — broad headline coverage
  GNEWS_API_KEY?: string;          // gnews.io — alt news aggregator
  BING_NEWS_KEY?: string;          // Azure Bing News Search

  // Sports — schedules (discovery) + official results [RESOLVE]
  SPORTRADAR_API_KEY?: string;     // tier-1 authoritative [RESOLVE]
  API_FOOTBALL_KEY?: string;       // api-football.com — cheap fixtures/scores
  THESPORTSDB_KEY?: string;        // thesportsdb.com — free/cheap fallback

  // Finance / markets — prices [RESOLVE] + news
  POLYGON_API_KEY?: string;        // polygon.io — equities/crypto [RESOLVE]
  FINNHUB_API_KEY?: string;        // finnhub.io — stocks/news
  ALPHAVANTAGE_API_KEY?: string;   // alphavantage.co — markets
  COINGECKO_API_KEY?: string;      // CoinGecko Pro (free tier needs no key)

  // Weather — observed records [RESOLVE] + forecasts
  OPENWEATHER_API_KEY?: string;    // openweathermap.org
  TOMORROW_API_KEY?: string;       // tomorrow.io

  // Entertainment — release calendars / charts
  TMDB_API_KEY?: string;           // themoviedb.org — film/TV calendars
  YOUTUBE_API_KEY?: string;        // YouTube Data API — trending signal

  // Social signal (early + noisy, never used for resolution)
  X_BEARER_TOKEN?: string;         // X/Twitter API v2 bearer token
  REDDIT_CLIENT_ID?: string;       // Reddit OAuth (authenticated, higher limits)
  REDDIT_CLIENT_SECRET?: string;

  // Web crawling / scraping — sources with no API (managed crawlers handle
  // JS rendering + proxies + rate limits so we don't crawl from a Worker).
  FIRECRAWL_API_KEY?: string;      // firecrawl.dev
  SCRAPINGBEE_API_KEY?: string;    // scrapingbee.com
};
