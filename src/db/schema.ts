import {
  pgTable,
  text,
  timestamp,
  bigint,
  integer,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  numeric,
  doublePrecision,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/*  Better Auth tables — names and columns must match Better Auth's    */
/*  Drizzle adapter expectations. Don't rename these without updating  */
/*  the adapter mapping in src/auth.ts.                                */
/* ------------------------------------------------------------------ */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Marks users created by the synthetic volume seeder (synthetic/seed.ts).
  // The volume cron only picks senders + receivers from this pool so it
  // doesn't touch real customer balances. Also lets metrics filter
  // synthetic users out of MAU / signup counts cleanly.
  isSynthetic: boolean("is_synthetic").notNull().default(false),
  // Hard ban — blocks the account from all authenticated API access. Set for
  // accounts caught abusing the platform (e.g. the holdings-reconcile exploit).
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/*  Slay Money domain tables                                           */
/*                                                                     */
/*  Money is stored as bigint in micro-units (1 CC = 1_000_000 micro-  */
/*  CC), the same precision USDC uses on chain. This keeps everything  */
/*  integer math — no floating-point drift in payouts.                 */
/* ------------------------------------------------------------------ */

export const handles = pgTable(
  "handles",
  {
    handle: text("handle").primaryKey(), // "@maya"
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex("handles_user_id_idx").on(t.userId),
  })
);

export const wallets = pgTable("wallets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  balance: bigint("balance", { mode: "number" }).notNull().default(0),
  locked: bigint("locked", { mode: "number" }).notNull().default(0),
  // Non-withdrawable CC (micro): promotional credit (welcome bonus) that can be
  // BET with but never cashed out. Withdrawable = max(0, balance - nonWithdrawable).
  // Incremented when a signup bonus is granted; enforced in submitWithdrawal.
  nonWithdrawable: bigint("non_withdrawable", { mode: "number" }).notNull().default(0),
  // Deposit-mirror watermark (micro): the on-chain CC balance we've already
  // accounted for. On-chain Amulet holdings only ever RISE from a real external
  // deposit (bets/wins/losses/top-ups/in-app sends never add Amulets to a
  // user's own party in the omnibus model), so crediting any increase above
  // this watermark is a safe, bettor-proof way to mirror deposits. NULL = never
  // baselined yet (first touch baselines without crediting existing on-chain,
  // except a non-bettor's current pending gap). See canton/watermark-credit.ts.
  onChainWatermark: bigint("on_chain_watermark", { mode: "number" }),
  // CBTC additions (Phase A of the BitSafe integration).
  // Units: satoshi (8 decimal places). 100_000_000 sat = 1 BTC = 1 CBTC.
  // Same custodial model as CC: operator holds a treasury; user balance
  // is the Postgres truth, mirrored to chain on send/receive.
  balanceCbtc: bigint("balance_cbtc", { mode: "number" }).notNull().default(0),
  lockedCbtc: bigint("locked_cbtc", { mode: "number" }).notNull().default(0),
  // cETH (onrails, decimals=10). Smallest unit = 10^-10 cETH, same convention
  // as the CBTC *Raw fields.
  balanceCeth: bigint("balance_ceth", { mode: "number" }).notNull().default(0),
  lockedCeth: bigint("locked_ceth", { mode: "number" }).notNull().default(0),
  // tUSD (TradeFast USD stablecoin, decimals=10). Same smallest-unit convention.
  balanceTusd: bigint("balance_tusd", { mode: "number" }).notNull().default(0),
  lockedTusd: bigint("locked_tusd", { mode: "number" }).notNull().default(0),
  // HECTO (Hecto-Finance token, decimals=10). Same smallest-unit convention.
  balanceHecto: bigint("balance_hecto", { mode: "number" }).notNull().default(0),
  lockedHecto: bigint("locked_hecto", { mode: "number" }).notNull().default(0),
  // smUSD (Slay's own Brale-issued USD stablecoin, decimals=10). Custodial via
  // Brale API; per-user balance omnibus in Postgres like the other tokens.
  balanceSmusd: bigint("balance_smusd", { mode: "number" }).notNull().default(0),
  lockedSmusd: bigint("locked_smusd", { mode: "number" }).notNull().default(0),
  cantonAddress: text("canton_address").unique(),
  // Set when we've emailed the user that they're onboarded off the waitlist
  // (dedup guard for the notify-onboarded endpoint).
  onboardingEmailSentAt: timestamp("onboarding_email_sent_at"),
  // TransferPreapproval cid for receiving external CC sends. When set,
  // external Splice wallets discover this via scan-proxy and route their
  // sends through TransferPreapproval_Send (direct settlement), so the CC
  // lands as an Amulet on chain instantly with no two-phase Accept needed.
  // Created at user signup (or admin backfill). Renewed by the 5-min cron
  // when within 7 days of expiry. NULL = no preapproval yet (legacy users
  // pre-dating this column, or signup race with chain failure).
  transferPreapprovalCid: text("transfer_preapproval_cid"),
  transferPreapprovalExpiresAt: timestamp("transfer_preapproval_expires_at", {
    withTimezone: true,
  }),
  // Mark parties for which preapproval setup will NEVER succeed (e.g.
  // party hosted on a different participant → UNKNOWN_SUBMITTERS forever).
  // Excluded from the 5-min backfill query so we don't burn traffic on
  // guaranteed-fail submissions every tick.
  preapprovalSkipped: boolean("preapproval_skipped").notNull().default(false),
  preapprovalSkipReason: text("preapproval_skip_reason"),
  // Per-user memo code printed on the Deposit screen ("SLAY-AB12CD34").
  // Senders include this in the description field of their on-chain transfer
  // to the treasury so the deposit poller can attribute the incoming CC to
  // this user. Generated lazily the first time a user views their deposit
  // info (see deposits/service.ts).
  depositCode: text("deposit_code").unique(),
  // KYC fields collected during onboarding. Nullable so AuthGate can route
  // based on which is still missing. firstName/lastName are kept separate
  // (not a single 'name' field) because every KYC provider we'd plug in
  // (Persona/Sumsub/Onfido) wants them split.
  firstName: text("first_name"),
  lastName: text("last_name"),
  // ISO 3166-1 alpha-2 ("US", "IN", "GB"). Display name is looked up on the
  // client via lib/countries.ts so we don't have to denormalise here.
  country: text("country"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const txTypeEnum = pgEnum("tx_type", [
  "topup",
  "withdraw",
  "send",
  "receive",
  "bet_lock",
  "bet_refund",
  "bet_win",
  "house_fee",
  "fee_refund",
  // Real on-chain deposit/withdrawal pair. Distinct from 'topup'/'withdraw'
  // which were used for synthetic V1 credits and reverse-out flows. These
  // ones always carry a refType='deposit'|'withdrawal' linking back to a row
  // in deposits/withdrawals tables for full audit trail.
  "deposit_onchain",
  "withdraw_onchain",
]);

export const txStatusEnum = pgEnum("tx_status", ["pending", "confirmed", "failed"]);

/* ──────────────────────────────────────────────────────────────────
 *  Multi-currency support (CBTC integration — June 2026)
 *
 *  Transactions, bets and markets gained a `currency` column so the
 *  CBTC stack can sit alongside CC without forking every table.
 *
 *  Amount semantics depend on currency:
 *    CC   → amount stored as micro-CC   (1 CC   = 1_000_000)
 *    CBTC → amount stored as satoshi    (1 CBTC = 100_000_000)
 *
 *  Both use BIGINT, distinct precisions, no mixing. Existing rows
 *  default to 'CC' so nothing in the CC stack moves.
 * ────────────────────────────────────────────────────────────── */
export const currencyEnum = pgEnum("currency", ["CC", "CBTC", "CETH", "TUSD", "HECTO"]);

export const transactions = pgTable("transactions", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id").notNull().references(() => wallets.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: txTypeEnum("type").notNull(),
  // Defaults to CC for back-compat with every existing row. Read
  // alongside `amount` to interpret the unit: CC → micro-CC, CBTC → sat.
  currency: currencyEnum("currency").notNull().default("CC"),
  // Signed: positive = inbound to this wallet, negative = outbound.
  amount: bigint("amount", { mode: "number" }).notNull(),
  status: txStatusEnum("status").notNull().default("confirmed"),
  // Optional links to other entities (other user, market, bet).
  refType: text("ref_type"),
  refId: text("ref_id"),
  /* The Canton update id of the chain transaction this row mirrors — the
   * join key into `canton_tx_fees` (network fees burnt on chain).
   *
   * Deliberately NOT `ref_id`: that column is overloaded across bet.id /
   * positionId / withdrawal.id / updateId / "updateId:cid" / "pending-*" /
   * "watermark-*:uuid", so a join through it is a guess. This one has a
   * single meaning.
   *
   * NULL means one of two things, and they are NOT the same:
   *   • created_at >= NETWORK_FEE_CAPTURE_START (src/fees/network-fees.ts)
   *     → the row had no chain leg. FREE.
   *   • created_at <  NETWORK_FEE_CAPTURE_START
   *     → predates capture. UNKNOWN — must never be rendered as free.
   * The fee amount itself is never stored here: one chain transaction fans
   * out to as many as three rows sharing a ref_id (send + receive +
   * house_fee), so a per-row fee column triple-counts on SUM(). */
  chainUpdateId: text("chain_update_id"),
  counterpartyHandle: text("counterparty_handle"),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /* Time-windowed history reads — GET /wallet/transactions?since=<ISO>.
   *
   * Both access paths on this table are "this user's rows, newest first":
   * the legacy limit read and the windowed read the KPI dashboard needs.
   * Without this the windowed read is a filtered scan plus a sort, which
   * is survivable at today's volumes and stops being so exactly when an
   * account gets busy enough for the window to matter. */
  userCreatedIdx: index("transactions_user_created_idx").on(t.userId, t.createdAt),
  /* The free-vs-paid join: transactions → canton_tx_fees.update_id. */
  chainUpdateIdx: index("transactions_chain_update_id_idx").on(t.chainUpdateId),
}));

/* ------------------------------------------------------------------ */
/*  Markets (parimutuel, single-question, multi-option)                */
/* ------------------------------------------------------------------ */

export const marketStatusEnum = pgEnum("market_status", [
  "open",
  "closed",
  "resolved",
  "cancelled",
]);

export const markets = pgTable("markets", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  emoji: text("emoji"),
  // [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] — or N options.
  //
  // `seedCents` is the OPENING line, written by importers that have an
  // external price to start from (sports/import.ts normalises the bookmaker's
  // h2h odds into it). It exists because a market with no bets yet has an
  // empty pool, and a pool share of 0 would otherwise render as 1¢ on every
  // outcome — i.e. a ~99× multiplier on a coin flip. Read it ONLY as the
  // fallback before the first bet; once there is volume the pool is the
  // truth. jsonb, so adding the key needs no migration.
  options: jsonb("options")
    .$type<Array<{ id: string; label: string; seedCents?: number }>>()
    .notNull(),
  // A market is denominated in ONE currency for its whole life. All bets
  // on the market are in this currency; payouts settle in it too.
  // Defaults to CC so every existing market stays CC-denominated.
  currency: currencyEnum("currency").notNull().default("CC"),
  // Multi-asset markets: siblings that pose the SAME question in different
  // currencies share a group_id. The app collapses a group into one card
  // with a CC/CBTC/cETH toggle; each toggle bets on that currency's sibling.
  // Null = standalone single-currency market (every legacy market).
  groupId: text("group_id"),
  status: marketStatusEnum("status").notNull().default("open"),
  winningOptionId: text("winning_option_id"),
  // House fee in basis points. 1000 = 10%, 200 = 2%, etc.
  feeBps: integer("fee_bps").notNull().default(200),
  // When betting closes (no new bets after this).
  closesAt: timestamp("closes_at", { withTimezone: true }),
  // When the underlying outcome is expected to be known.
  resolvesAt: timestamp("resolves_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Current chain contract id when on-chain markets are enabled. Updates
  // on every choice exercise (Daml contracts are immutable; each exercise
  // forks a new contract). Null for Postgres-only markets.
  chainContractId: text("chain_contract_id"),
  creatorUserId: text("creator_user_id").references(() => users.id, { onDelete: "set null" }),
  visibility: text("visibility").notNull().default("public"),
});

export const marketInvites = pgTable(
  "market_invites",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
    inviterUserId: text("inviter_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    inviteeUserId: text("invitee_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    marketInviteeIdx: uniqueIndex("market_invites_market_invitee_idx").on(t.marketId, t.inviteeUserId),
    inviteeIdx: index("market_invites_invitee_idx").on(t.inviteeUserId),
  })
);

export const betStatusEnum = pgEnum("bet_status", ["placed", "won", "lost", "refunded", "cashed_out"]);

export const bets = pgTable("bets", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  optionId: text("option_id").notNull(),
  // Always equals the parent market's currency. Stored here too so the
  // bet row is self-sufficient for activity-feed lookups without joining
  // markets. Default CC for the existing rows.
  currency: currencyEnum("currency").notNull().default("CC"),
  amount: bigint("amount", { mode: "number" }).notNull(),
  status: betStatusEnum("status").notNull().default("placed"),
  // Set on resolution. For losers this stays null/0.
  payout: bigint("payout", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  // Daml Bet contract id when on-chain markets are enabled. Updates if
  // the contract is re-created on Settle/Refund. Null = Postgres-only.
  chainContractId: text("chain_contract_id"),
  // ── Async on-chain escrow (ASYNC_BET_ESCROW) ──────────────────────
  // The stake is locked in Postgres synchronously, then moved on-chain
  // (user → operator) in the background. escrowTxId = the on-chain
  // updateId of that transfer; NULL = escrow not yet settled (the
  // reconcile cron retries these). Together with chainContractId it
  // tracks the two background legs (PlaceBet + escrow).
  escrowTxId: text("escrow_tx_id"),
  // Early cash-out (CASHOUT_ENABLED): when the user exits before
  // resolution. cashoutAmount = CC returned; cashedOutAt = when;
  // cashoutTxId = on-chain updateId of the operator→user return transfer
  // (NULL = chain leg pending → the reconcile cron retries it).
  cashoutAmount: bigint("cashout_amount", { mode: "number" }),
  cashedOutAt: timestamp("cashed_out_at", { withTimezone: true }),
  cashoutTxId: text("cashout_tx_id"),
  payoutTxId: text("payout_tx_id"),
});

/* ------------------------------------------------------------------ */
/*  CLOB — Polymarket-style order book (supersedes parimutuel betting)  */
/*                                                                      */
/*  Outcome SHARES trade on a limit order book. 1 share redeems for 1   */
/*  collateral unit if its outcome wins, else 0; YES+NO = 1 complete    */
/*  set. Shares are denominated in the market currency's smallest unit  */
/*  (so a share and a collateral unit share the same scale). The book + */
/*  matcher run off-chain (Postgres); each fill settles collateral      */
/*  on-chain (reusing the escrow/watermark infra). Price is in bps of   */
/*  one collateral unit: 1..9999 (= 0.01¢..99.99¢ implied probability). */
/* ------------------------------------------------------------------ */

export const clobOrderSideEnum = pgEnum("clob_order_side", ["buy", "sell"]);
export const clobOrderStatusEnum = pgEnum("clob_order_status", [
  "open",
  "partial",
  "filled",
  "cancelled",
]);
export const clobFillKindEnum = pgEnum("clob_fill_kind", ["match", "mint", "merge"]);

/** Resting + historical orders. One book per (marketId, currency, outcomeId). */
export const marketOrders = pgTable(
  "market_orders",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
    currency: currencyEnum("currency").notNull().default("CC"),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    outcomeId: text("outcome_id").notNull(),
    side: clobOrderSideEnum("side").notNull(),
    // Limit price in bps of 1 collateral unit (1..9999).
    priceBps: integer("price_bps").notNull(),
    // Size + filled, in shares (== collateral smallest units).
    size: bigint("size", { mode: "number" }).notNull(),
    filled: bigint("filled", { mode: "number" }).notNull().default(0),
    status: clobOrderStatusEnum("status").notNull().default("open"),
    // Operator market-maker orders (mm.ts) are flagged so they can be refreshed.
    isMaker: boolean("is_maker").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bookIdx: index("market_orders_book_idx").on(t.marketId, t.currency, t.outcomeId, t.status),
    userIdx: index("market_orders_user_idx").on(t.userId, t.status),
  })
);

/** Executed fills (append-only). Powers price history + on-chain settlement. */
export const marketFills = pgTable(
  "market_fills",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
    currency: currencyEnum("currency").notNull().default("CC"),
    outcomeId: text("outcome_id").notNull(),
    makerOrderId: text("maker_order_id"),
    takerOrderId: text("taker_order_id"),
    makerUserId: text("maker_user_id"),
    takerUserId: text("taker_user_id"),
    // priceBps = the taker's fill price (the trade "print" used for the chart).
    // makerPriceBps differs from it on mint/merge (taker = FULL - maker).
    priceBps: integer("price_bps").notNull(),
    makerPriceBps: integer("maker_price_bps").notNull(),
    takerSide: clobOrderSideEnum("taker_side").notNull(),
    shares: bigint("shares", { mode: "number" }).notNull(),
    kind: clobFillKindEnum("kind").notNull().default("match"),
    // Per-side on-chain collateral settlement updateId. "pending"/NULL until
    // settled; the reconcile cron retries. Mirrors bets.escrowTxId.
    makerTxId: text("maker_tx_id"),
    takerTxId: text("taker_tx_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    marketIdx: index("market_fills_market_idx").on(t.marketId, t.currency, t.outcomeId, t.createdAt),
  })
);

/** A user's tradeable share holdings per outcome — the sellable "position". */
export const marketShares = pgTable(
  "market_shares",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    outcomeId: text("outcome_id").notNull(),
    currency: currencyEnum("currency").notNull().default("CC"),
    shares: bigint("shares", { mode: "number" }).notNull().default(0),
    // Shares reserved by the user's open SELL orders (can't be double-sold).
    lockedShares: bigint("locked_shares", { mode: "number" }).notNull().default(0),
    // Net collateral spent acquiring current shares (for avg cost / P&L).
    costBasis: bigint("cost_basis", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    holdingIdx: uniqueIndex("market_shares_holding_idx").on(t.userId, t.marketId, t.outcomeId),
    marketUserIdx: index("market_shares_market_idx").on(t.marketId, t.userId),
  })
);

/** Last trade price per outcome over time → the price chart. */
export const marketPricePoints = pgTable(
  "market_price_points",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
    outcomeId: text("outcome_id").notNull(),
    currency: currencyEnum("currency").notNull().default("CC"),
    priceBps: integer("price_bps").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seriesIdx: index("market_price_points_series_idx").on(t.marketId, t.outcomeId, t.ts),
  })
);

export type MarketOrderRow = typeof marketOrders.$inferSelect;
export type MarketFillRow = typeof marketFills.$inferSelect;
export type MarketShareRow = typeof marketShares.$inferSelect;

export const markerMeter = pgTable("marker_meter", {
  id: text("id").primaryKey(),
  markersFiled: bigint("markers_filed", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/*  Rewards program                                                    */
/*                                                                     */
/*  Three things live here:                                            */
/*    1. signupBonusClaims — one row per user, set when they tap claim */
/*    2. milestoneClaims    — one row per (user, level) pair           */
/*    3. referrals          — referrer→referred edges                  */
/*    4. referralCodes      — user-owned shareable codes               */
/*                                                                     */
/*  Milestone *config* (level → reward, requirements) is NOT in the    */
/*  DB — it lives in src/rewards/config.ts so it's diff-tracked and    */
/*  can't drift from the client.                                       */
/* ------------------------------------------------------------------ */

export const signupBonusClaims = pgTable("signup_bonus_claims", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  amount: bigint("amount", { mode: "number" }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // On-chain settlement marker. NULL when the operator → user transfer
  // hasn't landed yet (or failed); a Splice update id when it has. The
  // reward-retry cron polls this column to find pending credits and
  // retries them through the Worker's warm AmuletRules cache.
  cantonContractId: text("canton_contract_id"),
  /** When the on-chain leg last failed. Null = either pending or settled. */
  chainAttemptedAt: timestamp("chain_attempted_at", { withTimezone: true }),
  /** Free-text error from the most recent failed attempt. */
  chainError: text("chain_error"),
  /**
   * Total number of on-chain submit attempts (in-request + cron retries).
   * Once it crosses a threshold the retry cron stops trying — a stuck row
   * means something genuinely broken (wrong party id, persistent DSO
   * stalemate, etc.) and continuing to fire transfers risks double-spend
   * if a past attempt actually landed on chain. Cleared on success.
   */
  chainAttempts: integer("chain_attempts").notNull().default(0),
});

export const milestoneClaims = pgTable(
  "milestone_claims",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    // On-chain settlement marker. NULL = chain leg pending or failed.
    // Set to the Splice update id when the operator → user transfer
    // lands. The reward-retry cron uses this column to find pending
    // credits and retries them through the Worker's warm cache.
    cantonContractId: text("canton_contract_id"),
    /** Timestamp of the last failed on-chain attempt. */
    chainAttemptedAt: timestamp("chain_attempted_at", { withTimezone: true }),
    /** Last error from the on-chain leg. Null when settled. */
    chainError: text("chain_error"),
    /** Number of on-chain submit attempts. Capped by the retry cron. */
    chainAttempts: integer("chain_attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One claim per (user, level). Guarantees idempotency at the DB layer
    // — a double-tap of the Claim button can't credit twice.
    userLevelIdx: uniqueIndex("milestone_claims_user_level_idx").on(
      t.userId,
      t.level
    ),
  })
);

export const referralCodes = pgTable("referral_codes", {
  code: text("code").primaryKey(),       // "SLAY-AYUSH-7K2"
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const referrals = pgTable(
  "referrals",
  {
    id: text("id").primaryKey(),
    referrerUserId: text("referrer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The user who signed up using the code. Unique because a user can only
    // be referred by one other user — first code applied wins.
    referredUserId: text("referred_user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    referrerIdx: uniqueIndex("referrals_referrer_referred_idx").on(
      t.referrerUserId,
      t.referredUserId
    ),
  })
);

/* ------------------------------------------------------------------ */
/*  Fee refunds                                                        */
/*                                                                     */
/*  We charge a chain fee on outbound ops (send/trade/bet/p2p) but     */
/*  refund it within 5 min via cron. To do that cleanly we log the     */
/*  *intended refund* the moment we charge the fee, and the cron        */
/*  worker picks up rows where settledAt IS NULL.                       */
/*                                                                     */
/*  Tying refunds to a `sourceTxId` lets users see "fee refund for tx  */
/*  X" in their history.                                                */
/* ------------------------------------------------------------------ */

export const feeRefundStatusEnum = pgEnum("fee_refund_status", [
  "pending",
  "settled",
  "skipped",
]);

export const feeRefunds = pgTable("fee_refunds", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // The tx the fee was charged on. Refund row is created in the same code
  // path that creates this source tx.
  sourceTxId: text("source_tx_id").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  status: feeRefundStatusEnum("status").notNull().default("pending"),
  // The credit-side tx written when the cron settles. Null until then.
  refundTxId: text("refund_tx_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

/* ------------------------------------------------------------------ */
/*  P2P marketplace — escrow orders + chat                             */
/* ------------------------------------------------------------------ */

export const p2pSideEnum = pgEnum("p2p_side", ["buy", "sell"]);
export const p2pCurrencyEnum = pgEnum("p2p_currency", [
  "USDC",
  "USDT",
  "BTC",
  "LOCAL",
]);
export const p2pStatusEnum = pgEnum("p2p_status", [
  "open",
  "matched",
  "payment_sent",
  "completed",
  "cancelled",
  "disputed",
]);

export const p2pOrders = pgTable("p2p_orders", {
  id: text("id").primaryKey(),
  posterUserId: text("poster_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  side: p2pSideEnum("side").notNull(),
  // Stored in micro-CC for consistency with wallets/transactions tables.
  amount: bigint("amount", { mode: "number" }).notNull(),
  // Price stored as a string to avoid floating-point drift on user-entered
  // values. Apps render it as a number; backend treats as opaque.
  pricePerCc: text("price_per_cc").notNull(),
  currency: p2pCurrencyEnum("currency").notNull(),
  localCurrencyCode: text("local_currency_code"),
  paymentMethods: jsonb("payment_methods")
    .$type<string[]>()
    .notNull()
    .default([]),
  minAmount: bigint("min_amount", { mode: "number" }),
  maxAmount: bigint("max_amount", { mode: "number" }),
  counterpartyUserId: text("counterparty_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  status: p2pStatusEnum("status").notNull().default("open"),
  // The Daml escrow contract holding the seller's CC. Set when matched.
  cantonEscrowContractId: text("canton_escrow_contract_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  matchedAt: timestamp("matched_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const p2pMessages = pgTable("p2p_messages", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => p2pOrders.id, { onDelete: "cascade" }),
  fromUserId: text("from_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/*  On-chain deposits & withdrawals (Custodial Hybrid model)           */
/*                                                                      */
/*  We hold all user CC custodially on a single treasury party (the     */
/*  validator's operator party). Users deposit by sending CC to the     */
/*  treasury with a memo code; we attribute and credit Postgres.        */
/*  Withdrawals deduct Postgres balance and queue a transfer out.       */
/*                                                                      */
/*  Off-chain operations (bets, internal sends) move Postgres rows      */
/*  only. The chain leg is just for the user-facing edges of the        */
/*  custodial system.                                                   */
/* ------------------------------------------------------------------ */

/**
 * Single-row cursor for the deposit poller cron. Holds the last
 * transaction id we successfully processed from the treasury's tx feed
 * so the next poll skips already-credited rows.
 *
 * The poller writes one row on first run (id = "singleton") and just
 * updates it on subsequent runs. Easier than KV/Durable Object for
 * something this small.
 */
export const depositCursor = pgTable("deposit_cursor", {
  id: text("id").primaryKey(), // always "singleton"
  // Last transaction_id we successfully processed. The Splice listTransactions
  // feed returns rows in reverse-chrono; we walk back until we hit this id,
  // then write the newest id we saw.
  lastTxId: text("last_tx_id"),
  // For visibility / debugging — when did we last run, and how many rows
  // did we attribute on the last pass.
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastAttributed: integer("last_attributed"),
  lastUnclaimed: integer("last_unclaimed"),
});

/**
 * Incoming transfers that the poller couldn't attribute (no matching
 * memo code, malformed memo, or the user was deleted between deposit
 * and our next poll). Surfaced in the admin CLI for manual reconciliation
 * via `deposits claim <id> --user @handle`.
 *
 * We never auto-credit these because doing so could double-pay if the
 * user later sends a corrected transfer with the right memo.
 */
export const unclaimedDeposits = pgTable("unclaimed_deposits", {
  id: text("id").primaryKey(),
  // Unique on the on-chain tx so a re-run of the poller can't insert
  // duplicate unclaimed rows for the same transfer.
  transactionId: text("transaction_id").notNull().unique(),
  fromParty: text("from_party").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(), // micro-CC
  memo: text("memo"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  // Null until an admin reconciles via the CLI. When set, the deposit has
  // been credited to this user and a corresponding deposit_onchain tx exists.
  claimedByUserId: text("claimed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  // User submitted, balance debited, waiting for the processor cron to pick
  // it up. Safe to retry — no chain interaction yet.
  "pending",
  // Processor handed off to Splice — we have a transaction_id back. Treated
  // as terminal-success for now (Splice auto-accept + same-validator => fast).
  // Cross-validator transfers will need a separate 'awaiting_recipient' state.
  "submitted",
  // Confirmed on chain (currently set the same time as 'submitted' since we
  // don't have explicit chain confirmation in the V1 splice client).
  "confirmed",
  // Splice call failed. balance has been refunded; `error` holds the
  // reason. Admin can retry via CLI.
  "failed",
]);

export const withdrawals = pgTable("withdrawals", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Destination party ID on Canton (their external wallet, partner exchange,
  // etc.). Validated for party-id shape at the route layer.
  toParty: text("to_party").notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(), // micro-CC
  status: withdrawalStatusEnum("status").notNull().default("pending"),
  // Splice-side transaction id, set once the transfer call returns.
  transactionId: text("transaction_id"),
  // Set on failure. Free-form so we can include enough context to debug.
  error: text("error"),
  // Memo to include in the on-chain transfer description, optional user note.
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
});

/* ------------------------------------------------------------------ */
/*  Event mirror cursor                                                */
/*                                                                      */
/*  Single-row state for the chain → Postgres event subscriber. Holds  */
/*  the last participant offset we processed; the mirror cron resumes  */
/*  from here on each run.                                              */
/* ------------------------------------------------------------------ */

/* ──────────────────────────────────────────────────────────────────
 *  Price cache
 *
 *  Persistent last-known-good USD prices for CC, CBTC, and any future
 *  asset we display dollar values for. Survives Worker isolate restarts
 *  so we never show the misleading "$1 = 1 CC" floor again.
 *
 *  Read order: memory cache → this table → live fetch.
 *  Write: on every successful live fetch, upsert here.
 *
 *  Single-row-per-asset; key is the asset symbol lowercased.
 * ────────────────────────────────────────────────────────────── */
export const priceCache = pgTable("price_cache", {
  // "cc", "cbtc", "btc" — lowercase asset symbol.
  key: text("key").primaryKey(),
  // USD price stored as a decimal-as-text so we never lose precision.
  // CBTC at $100k+ fits in JS Number, but BIGINT mode bigserials handle
  // any future asset (e.g. shitcoins at $0.0000001) without rounding.
  usd: text("usd").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const eventMirrorCursor = pgTable("event_mirror_cursor", {
  id: text("id").primaryKey(), // always "slay-events"
  lastOffset: text("last_offset"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastProcessed: integer("last_processed"),
});

/* ────────── CBTC accept ledger ────────── *
 *  One row per TransferInstruction we've accepted on chain. Doubles as *
 *  (a) the idempotency anchor for the accept cron — if a row exists   *
 *  for a given TI cid, we skip re-accepting; (b) audit trail for     *
 *  operator-side receipts that don't fit the transactions table       *
 *  (which has notNull walletId/userId).                                *
 *                                                                      *
 *  For user-side receipts, the wallet credit + transactions row are    *
 *  ALSO written (see cbtc/accept-cron.ts:creditAccepted). This table   *
 *  is the canonical "did we already process this?" check; the         *
 *  transactions row is the user-facing audit row.                     *
 * ──────────────────────────────────────────────────────────────── */
/* ------------------------------------------------------------------ *
 *  Synthetic volume cron — live-adjustable config.                    *
 *                                                                      *
 *  Singleton row (id=1 always). Volume-cron reads this on every tick   *
 *  so the admin dashboard can adjust peak hours / per-tick rates       *
 *  without redeploying the worker. Constants in volume-cron.ts now     *
 *  serve as DEFAULTS only — the DB row overrides if present.          *
 * ------------------------------------------------------------------ */
export const syntheticConfig = pgTable("synthetic_config", {
  id: integer("id").primaryKey().default(1),
  // Comma-separated IST hours [0-23] that count as peak (CSV simpler than
  // PG array for drizzle round-trip + JSON UI form binding).
  peakHoursIst: text("peak_hours_ist").notNull().default("9,10,11,16,17,18,19,20"),
  peakPerTickMin: integer("peak_per_tick_min").notNull().default(2),
  peakPerTickMax: integer("peak_per_tick_max").notNull().default(6),
  offPeakPerTickMin: integer("off_peak_per_tick_min").notNull().default(0),
  offPeakPerTickMax: integer("off_peak_per_tick_max").notNull().default(4),
  // Min amount in raw smallest-unit (10^-decimals CBTC). Default 10_000
  // = 0.000001 CBTC at decimals=10.
  minAmountRaw: bigint("min_amount_raw", { mode: "number" }).notNull().default(10000),
  // Max fraction of sender's balance per single transfer (0-1).
  // 0.4 means each transfer is at most 40% of sender balance — leaves
  // the sender eligible for the next tick.
  maxAmountPct: numeric("max_amount_pct", { precision: 13, scale: 12 })
    .notNull()
    .default("0.400000000000"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ *
 *  CBTC holding cid cache — workaround for the 200-element cap on the *
 *  participant's /v2/state/active-contracts. Canton 3.5.1 silently    *
 *  ignores TemplateFilter AND InterfaceFilter, so we can't narrow the *
 *  result server-side. Operator party crosses 200 contracts easily    *
 *  (ValidatorRights per managed user, TransferPreapprovals, …).       *
 *                                                                      *
 *  Workaround: cache ONE active CBTC Holding cid per party. On every   *
 *  successful transferCbtc we parse the new "change" Holding cid for  *
 *  the sender from the transaction result and overwrite the row. The  *
 *  initial seed is operator work (POST /api/admin/cbtc/seed-holding-  *
 *  cid) — find one cid via BitSafe wallet UI or chain explorer.       *
 *                                                                      *
 *  Per-party PK so multiple senders can cache independently. The      *
 *  amount column is informational — useful for ops to confirm the      *
 *  cached cid still represents enough balance for a planned transfer. *
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 *  Splice CC amulet cid cache — workaround for Canton 3.5.1's 200-     *
 *  element cap on /v2/state/active-contracts.                          *
 *                                                                      *
 *  Operator party owns 600+ contracts (1 WalletAppInstall + 1          *
 *  ValidatorRight per user, plus Slay Bets/Markets/TradePositions      *
 *  it's signatory on). A wildcard active-contracts query 413s with     *
 *  JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED.                      *
 *                                                                      *
 *  Workaround: cache the single live operator Amulet cid here. Updated *
 *  on every successful transferAmulet (the senderChange Amulet event). *
 *  findOperatorAmulet checks this cache first; the participant query   *
 *  for operator party never runs.                                      *
 *                                                                      *
 *  Same pattern as cbtc_holding_cache for CBTC Holdings.               *
 * ------------------------------------------------------------------ */
export const ccAmuletCache = pgTable("cc_amulet_cache", {
  partyId: text("party_id").primaryKey(),
  amuletCid: text("amulet_cid").notNull(),
  /** Approximate CC amount the amulet held when last cached. Used by
   *  findOperatorAmulet's "≥ minAmountCc" check to short-circuit without
   *  asking the chain. Updated on every successful transfer. */
  amountCc: numeric("amount_cc", { precision: 28, scale: 10 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ *
 *  Canton NETWORK fees — CC burnt on chain by the Splice protocol.     *
 *                                                                      *
 *  ONE ROW PER CHAIN TRANSACTION, keyed by the update id. Not a column *
 *  on `transactions`: a single on-chain transfer fans out to as many   *
 *  as three transactions rows sharing one ref_id (send + receive +     *
 *  house_fee — wallet/service.ts), so a per-row fee column returns 3x  *
 *  the true burn from any SUM(). Total burn is summed over chain       *
 *  transactions here; the per-row "was this paid?" label is a JOIN     *
 *  (transactions.chain_update_id → update_id), never a stored value.   *
 *                                                                      *
 *  What burnt_cc means: the sum of the fee fields on the exercise      *
 *  result's `summary`, per the Splice docs. THE FIELD SET DIFFERS BY   *
 *  TRANSACTION TYPE, which is why `choice` is stored alongside:        *
 *    AmuletRules_Transfer      holdingFees + outputFees + senderChangeFee
 *    AmuletRules_BuyMemberTraffic                                      *
 *                              holdingFees + senderChangeFee + amuletPaid
 *    CNS entry purchase        amuletPaid                              *
 *    Transfer pre-approval     amuletPaid + outputFee                  *
 *  holdingFees are only charged when the coin was held across a mining *
 *  round, so the fee VARIES per transaction and cannot be derived from *
 *  a rate — it has to be read off the actual result. Hence this table. *
 *                                                                      *
 *  Unit is decimal CC at 10 dp, NOT the house micro-CC bigint. Splice  *
 *  Decimals carry 10 fractional digits; micro-CC truncates at 6, so a  *
 *  holdingFee of 0.0000019026 would store as 0 — which under the       *
 *  product definition reads as "free", the exact distinction this      *
 *  table exists to measure. Same call as cc_amulet_cache.amount_cc.    *
 *  Keep the value a STRING from the wire to the column; never round-   *
 *  trip through a JS number except for display.                        *
 *                                                                      *
 *  Absence of a row is NOT zero. No row = never captured (UNKNOWN);    *
 *  burnt_cc = 0 = captured, burned nothing (FREE). Writers upsert with *
 *  ON CONFLICT (update_id) DO NOTHING — a chain tx burns what it burns,*
 *  once. See src/fees/network-fees.ts for the writer and for           *
 *  NETWORK_FEE_CAPTURE_START, the instant before which every row is    *
 *  UNKNOWN rather than free.                                           *
 * ------------------------------------------------------------------ */
export const cantonTxFees = pgTable(
  "canton_tx_fees",
  {
    /** Canton update id (matches ^1220[0-9a-f]{60,} — the same id
     *  lighthouseUrlFor() deep-links on). One chain tx, one row. */
    updateId: text("update_id").primaryKey(),
    /** The Daml choice whose formula produced burnt_cc:
     *  'AmuletRules_Transfer', 'TransferPreapproval_Send',
     *  'AmuletRules_BuyMemberTraffic',
     *  'AmuletRules_CreateTransferPreapproval', CNS collect choices. */
    choice: text("choice").notNull(),
    /** THE NUMBER. Decimal CC exactly as the chain reported it, summed by
     *  the type-specific formula above. NOT NULL — a row only exists when
     *  a real summary was read. */
    burntCc: numeric("burnt_cc", { precision: 28, scale: 10 }).notNull(),
    /** Raw `summary` off the exercise result (or the raw result when the
     *  summary node wasn't where we expected). Kept so a wrong field set
     *  for a type can be recomputed without re-walking history. */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    /** Chain context — all nullable, not every source supplies them. */
    round: bigint("round", { mode: "number" }),
    /** USD/CC at chain time when the summary carried it. Stored so USD
     *  conversion happens at chain time, not at read time. */
    amuletPrice: numeric("amulet_price", { precision: 28, scale: 10 }),
    senderParty: text("sender_party"),
    receiverParty: text("receiver_party"),
    /** Chain record time. Live capture has no tree effectiveAt to read
     *  (ledger.ts's exercise() surfaces only updateId), so it stamps the
     *  observation instant — within seconds of chain time. A history walk
     *  writes the real one. */
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    /** Optional attribution for burns with NO transactions row at all
     *  (merges, sweeps, CLOB fills, preapproval setup, escrow legs).
     *  Mirrors transactions.ref_type / ref_id. */
    refType: text("ref_type"),
    refId: text("ref_id"),
    /** 'live' = read off the submit response at transfer time.
     *  'walk' = read by a history walk / backfill. */
    source: text("source").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    effectiveIdx: index("canton_tx_fees_effective_idx").on(t.effectiveAt),
    choiceIdx: index("canton_tx_fees_choice_idx").on(t.choice),
    refIdx: index("canton_tx_fees_ref_idx").on(t.refType, t.refId),
  })
);
export type CantonTxFeeRow = typeof cantonTxFees.$inferSelect;

export const cbtcHoldingCache = pgTable("cbtc_holding_cache", {
  partyId: text("party_id").primaryKey(),
  holdingCid: text("holding_cid").notNull(),
  amountRaw: bigint("amount_raw", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const cbtcAccepted = pgTable("cbtc_accepted", {
  // TransferInstruction contract id.
  tiCid: text("ti_cid").primaryKey(),
  // Receiver party (operator or user). NOT the user id — the chain
  // identity. We resolve userId at credit time.
  receiverParty: text("receiver_party").notNull(),
  // Sender party (BitSafe treasury / another user / another wallet).
  // Nullable because we don't always have it from the TI payload.
  senderParty: text("sender_party"),
  // sat amount credited.
  amountSat: bigint("amount_sat", { mode: "number" }).notNull(),
  // Chain update id from the Accept exercise — the proof of settlement.
  updateId: text("update_id").notNull(),
  // If this maps to a Slay user, link the userId for fast joins;
  // operator-side receipts leave this null.
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// cETH mirror of cbtcHoldingCache — same 200-element ACS cap workaround,
// keyed per sender party, one cached Holding cid + raw amount per party.
export const cethHoldingCache = pgTable("ceth_holding_cache", {
  partyId: text("party_id").primaryKey(),
  holdingCid: text("holding_cid").notNull(),
  amountRaw: bigint("amount_raw", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// cETH mirror of cbtcAccepted — per-asset idempotency ledger for the
// TransferInstruction accept cron. Separate table from cbtc_accepted so
// the two assets' accept histories never collide.
export const cethAccepted = pgTable("ceth_accepted", {
  tiCid: text("ti_cid").primaryKey(),
  receiverParty: text("receiver_party").notNull(),
  senderParty: text("sender_party"),
  amountSat: bigint("amount_sat", { mode: "number" }).notNull(),
  updateId: text("update_id").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// tUSD mirror of ceth_holding_cache / ceth_accepted — separate tables so the
// three token-standard assets' caches + accept histories never collide.
export const tusdHoldingCache = pgTable("tusd_holding_cache", {
  partyId: text("party_id").primaryKey(),
  holdingCid: text("holding_cid").notNull(),
  amountRaw: bigint("amount_raw", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tusdAccepted = pgTable("tusd_accepted", {
  tiCid: text("ti_cid").primaryKey(),
  receiverParty: text("receiver_party").notNull(),
  senderParty: text("sender_party"),
  amountSat: bigint("amount_sat", { mode: "number" }).notNull(),
  updateId: text("update_id").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const hectoHoldingCache = pgTable("hecto_holding_cache", {
  partyId: text("party_id").primaryKey(),
  holdingCid: text("holding_cid").notNull(),
  amountRaw: bigint("amount_raw", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const hectoAccepted = pgTable("hecto_accepted", {
  tiCid: text("ti_cid").primaryKey(),
  receiverParty: text("receiver_party").notNull(),
  senderParty: text("sender_party"),
  amountSat: bigint("amount_sat", { mode: "number" }).notNull(),
  updateId: text("update_id").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/*  Type exports for service layer                                     */
/* ------------------------------------------------------------------ */
export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Market = typeof markets.$inferSelect;
export type Bet = typeof bets.$inferSelect;
export type SignupBonusClaim = typeof signupBonusClaims.$inferSelect;
export type MilestoneClaim = typeof milestoneClaims.$inferSelect;
export type ReferralCode = typeof referralCodes.$inferSelect;
export type Referral = typeof referrals.$inferSelect;
export type FeeRefund = typeof feeRefunds.$inferSelect;
export type P2POrderRow = typeof p2pOrders.$inferSelect;
export type P2PMessageRow = typeof p2pMessages.$inferSelect;
export type UnclaimedDeposit = typeof unclaimedDeposits.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;

/* ------------------------------------------------------------------ */
/*  Trade positions (Chainlink/Pyth-driven directional bets).          */
/*                                                                      */
/*  V1 spec — no leverage, no margin, no liquidation:                  */
/*    - User opens a Long/Short with N CC at the live oracle price P    */
/*    - P&L on close = N * (P_close - P_open) / P_open  for Long        */
/*                   = N * (P_open - P_close) / P_open  for Short       */
/*    - Stake N comes out of wallet.balance and into wallet.locked at   */
/*      open. On close: lock released, balance credited (stake + pnl).  */
/*                                                                      */
/*  Prices stored as fixed-precision numerics so we avoid float drift   */
/*  when comparing entry vs exit. pnl is in micro-CC (bigint) so all    */
/*  wallet math stays in integer-land.                                  */
/* ------------------------------------------------------------------ */
export const positions = pgTable("positions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // 'btc' | 'xau' | 'oil' — matches AssetId in prices/service.ts. Free-form
  // text so adding a new feed later doesn't require a schema migration.
  assetId: text("asset_id").notNull(),
  side: text("side").notNull(), // 'long' | 'short'
  // USD spot price at open / close, stored with 8 decimals to mirror
  // Chainlink precision.
  entryPriceUsd: numeric("entry_price_usd", { precision: 20, scale: 8 }).notNull(),
  exitPriceUsd: numeric("exit_price_usd", { precision: 20, scale: 8 }),
  // Stake in micro-CC. Locked at open, released on close.
  amount: bigint("amount", { mode: "number" }).notNull(),
  // 'open' | 'closed'. Liquidation/expiration would add more later.
  status: text("status").notNull().default("open"),
  // Realized P&L in micro-CC, set on close. Can be negative.
  pnl: bigint("pnl", { mode: "number" }),
  openedAt: timestamp("opened_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
  // Daml TradePosition contract id when USE_ONCHAIN_TRADE is enabled.
  // Updates on each choice exercise (Open creates it; Close archives it).
  chainContractId: text("chain_contract_id"),
});

export type PositionRow = typeof positions.$inferSelect;

/* ------------------------------------------------------------------ */
/*  Polymarket MIRROR positions — one row per user Up/Down bet that we  */
/*  hedge on Polymarket with our own USD liquidity. Off-chain mirror of  */
/*  the on-chain Slay.PmMirror:PmBet contract (on validator-2). Mirrors  */
/*  the async-bet escrow model: instant Postgres debit/lock, background   */
/*  on-chain escrow (escrowTxId 'pending' sentinel), background hedge.    */
/* ------------------------------------------------------------------ */
export const pmSideEnum = pgEnum("pm_side", ["up", "down"]);
export const pmBetStatusEnum = pgEnum("pm_bet_status", [
  "pending", // stake locked, hedge in flight
  "open", // hedge filled, position live
  "won",
  "lost",
  "void", // hedge never filled → refunded
  "refunded", // PM voided the window → refunded
  "cashed_out", // closed early by the user, before the window resolved
]);

export const pmPositions = pgTable("pm_positions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  walletId: text("wallet_id").references(() => wallets.id, { onDelete: "set null" }),
  asset: text("asset").notNull(), // 'btc' | 'eth' | 'sol' | 'xrp'
  duration: text("duration").notNull(), // '5m' | '15m'
  side: pmSideEnum("side").notNull(),
  // Only CC / CBTC are stakeable for now (StakeCurrency in PmMirror.daml).
  currency: currencyEnum("currency").notNull(),
  // Stake in the asset's smallest unit: micro-CC (1e6) for CC, raw (1e8) for CBTC.
  stakeRaw: bigint("stake_raw", { mode: "number" }).notNull(),
  // USD value hedged on PM at bet time (0 until the FX oracle is wired — Phase 3).
  usdEquiv: numeric("usd_equiv", { precision: 20, scale: 6 }).notNull().default("0"),
  // Polymarket window identity.
  marketSlug: text("market_slug").notNull(),
  conditionId: text("condition_id").notNull(),
  pmTokenId: text("pm_token_id").notNull(),
  windowEndMs: bigint("window_end_ms", { mode: "number" }).notNull(),
  entryOddsCents: integer("entry_odds_cents"), // implied prob at bet time, 0..100
  // Hedge fill (set on ConfirmHedge / exec /open).
  pmFillCents: integer("pm_fill_cents"),
  pmShares: numeric("pm_shares", { precision: 20, scale: 6 }),
  status: pmBetStatusEnum("status").notNull().default("pending"),
  payoutRaw: bigint("payout_raw", { mode: "number" }),
  // On-chain legs (mirror async-bet: 'pending' sentinel → awaiting escrow;
  // 'dryrun-*' → recorded while PM_BET_LIVE is off).
  escrowTxId: text("escrow_tx_id"),
  chainBetCid: text("chain_bet_cid"), // Slay.PmMirror:PmBet cid on v2
  settleTxId: text("settle_tx_id"),
  // Early close ("cash out"), the mirror of Polymarket's sell. The position is
  // marked to market off the live book: cashoutOddsCents is the price the
  // user's side was trading at when they closed, cashoutRaw is what they got
  // back in the staked asset, cashoutTxId the operator→user on-chain leg.
  cashoutRaw: bigint("cashout_raw", { mode: "number" }),
  cashoutOddsCents: integer("cashout_odds_cents"),
  cashedOutAt: timestamp("cashed_out_at", { withTimezone: true }),
  cashoutTxId: text("cashout_tx_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

export type PmPositionRow = typeof pmPositions.$inferSelect;

/* ------------------------------------------------------------------ */
/*  Card waitlist — "Notify me at launch" CTA on the Card tab.         */
/*                                                                      */
/*  One row per email. We use email (not userId) as the PK so a user   */
/*  who deletes and re-creates their account doesn't get a "you're     */
/*  already on the list" false positive. The userId column is just     */
/*  for analytics — who clicked, and from which signed-in session.     */
/* ------------------------------------------------------------------ */
export const cardWaitlist = pgTable("card_waitlist", {
  email: text("email").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CardWaitlistRow = typeof cardWaitlist.$inferSelect;

/* ------------------------------------------------------------------ */
/*  Parlays — house-banked, fixed-odds accumulator bets.               */
/*                                                                     */
/*  A parlay stacks N legs (each an option on a live market). Odds are  */
/*  SNAPSHOTTED at placement (basis points, ×10000) so the payout is    */
/*  deterministic and independent of later pool movement — unlike the   */
/*  parimutuel single-bet path. Stake is locked at placement; the       */
/*  parlay pays stake×combined ONLY if every leg wins, else the stake   */
/*  is forfeited. Legs settle as their markets resolve; the parlay      */
/*  finalises when the last leg lands (won) or the first leg loses.     */
/* ------------------------------------------------------------------ */
export const parlayStatusEnum = pgEnum("parlay_status", [
  "pending",
  "won",
  "lost",
  "cancelled",
]);
export const parlayLegStatusEnum = pgEnum("parlay_leg_status", [
  "pending",
  "won",
  "lost",
]);

export const parlays = pgTable("parlays", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  walletId: text("wallet_id").notNull().references(() => wallets.id, { onDelete: "cascade" }),
  // micro-CC (1 CC = 1_000_000).
  stake: bigint("stake", { mode: "number" }).notNull(),
  // Combined multiplier × 10000 (e.g. 8.4× = 84000).
  combinedMultBps: integer("combined_mult_bps").notNull(),
  potentialPayout: bigint("potential_payout", { mode: "number" }).notNull(),
  legCount: integer("leg_count").notNull(),
  status: parlayStatusEnum("status").notNull().default("pending"),
  payout: bigint("payout", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

export const parlayLegs = pgTable("parlay_legs", {
  id: text("id").primaryKey(),
  parlayId: text("parlay_id").notNull().references(() => parlays.id, { onDelete: "cascade" }),
  marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  optionId: text("option_id").notNull(),
  optionLabel: text("option_label").notNull(),
  marketQuestion: text("market_question").notNull(),
  // Snapshotted leg odds × 10000.
  oddsBps: integer("odds_bps").notNull(),
  status: parlayLegStatusEnum("status").notNull().default("pending"),
});

export type ParlayRow = typeof parlays.$inferSelect;
export type ParlayLegRow = typeof parlayLegs.$inferSelect;

/* ------------------------------------------------------------------ *
 *  Hourly oracle up/down rounds.                                      *
 *                                                                     *
 *  Each row backs one parimutuel market that asks "will {ASSET} be    *
 *  above ${strike} at {resolvesAt}?" where strike = the Pyth spot     *
 *  price captured when the round opened. The market itself is an      *
 *  ordinary `markets` row (options up/down) so betting + payout reuse *
 *  the existing parimutuel path; this table only carries the extra    *
 *  data the auto-resolver needs (asset, strike, close time).          *
 * ------------------------------------------------------------------ */
export const oracleRounds = pgTable("oracle_rounds", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  asset: text("asset").notNull(),                     // "btc" | "eth" | "sol"
  // Bet duration bucket: "5m" | "15m" | "60m". Lets a 5-min and a 15-min round
  // for the same asset share a close time without colliding.
  timeframe: text("timeframe").notNull().default("60m"),
  strikeUsd: numeric("strike_usd", { precision: 18, scale: 6 }).notNull(),
  opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
  resolvesAt: timestamp("resolves_at", { withTimezone: true }).notNull(),
  // open | resolved
  status: text("status").notNull().default("open"),
  settlePriceUsd: numeric("settle_price_usd", { precision: 18, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // At most one open round per asset per timeframe per close time — the create
  // step relies on this to stay idempotent across overlapping cron ticks.
  assetCloseIdx: uniqueIndex("oracle_rounds_asset_tf_close_uq").on(t.asset, t.timeframe, t.resolvesAt),
}));

export type OracleRoundRow = typeof oracleRounds.$inferSelect;

/* ══════════════════════════════════════════════════════════════════ *
 *  EVENT DISCOVERY ENGINE (Polymarket-class auto market generation)    *
 *                                                                      *
 *  Three additive tables that power the discovery funnel:              *
 *     raw items → documents → trending clusters → market candidates    *
 *                → (moderation / auto-publish) → existing `markets`     *
 *                                                                      *
 *  Nothing here touches the existing markets/bets stack. Generated     *
 *  candidates, once approved (or auto-published for safe template      *
 *  markets), are INSERTED into `markets` so the whole existing         *
 *  betting + parimutuel resolution + UI path is reused unchanged.      *
 *                                                                      *
 *  Source registry lives in code (src/discovery/sources.ts), mirroring *
 *  how price sources are code-defined — adding a source is a config +  *
 *  small class change, not a schema migration.                          *
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Normalized ingested items. One row per distinct article/post the
 * discovery ingest sees. `contentHash` collapses near-duplicates (the
 * same story from many outlets) at the ingest edge while the per-source
 * rows are preserved so the trend layer can count distinct-source
 * breadth. Rows age out — a cron prunes anything older than the trend
 * window so this table stays small (it is a rolling signal buffer, not
 * an archive).
 */
export const discoveryDocuments = pgTable("discovery_documents", {
  id: text("id").primaryKey(),
  // Code-registry source id (e.g. "rss.reuters.world"). Not a FK.
  sourceKey: text("source_key").notNull(),
  // sports | finance | crypto | weather | politics | news | tech | entertainment
  domain: text("domain").notNull(),
  // Source credibility weight w_s ∈ (0,1] captured at ingest time.
  sourceWeight: numeric("source_weight", { precision: 3, scale: 2 })
    .notNull()
    .default("0.50"),
  title: text("title").notNull(),
  url: text("url"),
  // SimHash-ish content fingerprint over the normalized title for dedup.
  contentHash: text("content_hash").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ingestedAt: timestamp("ingested_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ({
  hashIdx: uniqueIndex("discovery_documents_hash_source_uq").on(
    t.contentHash,
    t.sourceKey
  ),
}));

export type DiscoveryDocument = typeof discoveryDocuments.$inferSelect;

/**
 * Generated market candidates awaiting moderation or auto-publish. This
 * is the moderation queue. `status` walks:
 *   pending → approved → published   (or → rejected)
 * Template-generated candidates with a clean machine-readable resolution
 * source can skip straight to published when config.autoPublishTemplates
 * is on. `dedupeKey` is a normalized (entities|date|outcomeType) string
 * used to reject structural duplicates even when worded differently.
 */
export const marketCandidates = pgTable("market_candidates", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  emoji: text("emoji"),
  // [{ id, label }, …] — same shape as markets.options.
  options: jsonb("options").$type<Array<{ id: string; label: string }>>().notNull(),
  // Machine-precise resolution criteria text + the named source.
  resolutionRule: text("resolution_rule").notNull(),
  resolutionSource: text("resolution_source").notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  resolvesAt: timestamp("resolves_at", { withTimezone: true }),
  // Ranking + safety signals, all roughly [0,1] / [0,100].
  trendScore: numeric("trend_score", { precision: 6, scale: 4 }).notNull().default("0"),
  engagementScore: numeric("engagement_score", { precision: 5, scale: 2 })
    .notNull()
    .default("0"),
  // Resolvability confidence from the validator (0..1). High = safe.
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0"),
  // 'template' (deterministic, safe) | 'llm' (flexible, needs review).
  generator: text("generator").notNull().default("template"),
  // Structural-dedup key (entities + date + outcome type).
  dedupeKey: text("dedupe_key").notNull(),
  // pending | approved | rejected | published
  status: text("status").notNull().default("pending"),
  rejectionReason: text("rejection_reason"),
  // Set when this candidate is published into the live `markets` table.
  publishedMarketId: text("published_market_id"),
  // Raw evidence: the source docs/urls used to generate + (later) resolve.
  evidence: jsonb("evidence").$type<{ sources: Array<{ title: string; url: string | null; sourceKey: string }> }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (t) => ({
  dedupeIdx: uniqueIndex("market_candidates_dedupe_uq").on(t.dedupeKey),
}));

export type MarketCandidate = typeof marketCandidates.$inferSelect;

/**
 * Live-adjustable discovery config (singleton, id=1). Same pattern as
 * synthetic_config — read on every cron tick, mutated from the admin
 * surface, no redeploy needed. Defaults make the engine conservative:
 * generation queues for moderation, only template markets auto-publish.
 */
export const discoveryConfig = pgTable("discovery_config", {
  id: integer("id").primaryKey().default(1),
  // Master switch (also gated by env DISCOVERY_ENABLED).
  enabled: boolean("enabled").notNull().default(true),
  // CSV of enabled domains. Empty = all known domains.
  domains: text("domains").notNull().default(""),
  // Auto-publish template-generated markets (clean resolution source).
  // LLM markets ALWAYS go to the moderation queue regardless.
  autoPublishTemplates: boolean("auto_publish_templates").notNull().default(true),
  // Auto-publish LLM markets too (only flip on once approval rate is high).
  autoPublishLlm: boolean("auto_publish_llm").notNull().default(false),
  // Min trend score [0..1] for a cluster to reach the generator.
  minTrendScore: numeric("min_trend_score", { precision: 4, scale: 3 })
    .notNull()
    .default("0.150"),
  // z-score burst threshold (mention anomaly).
  zThreshold: numeric("z_threshold", { precision: 4, scale: 2 }).notNull().default("2.00"),
  // Cap on candidates generated per tick (bounds LLM cost + subrequests).
  maxCandidatesPerTick: integer("max_candidates_per_tick").notNull().default(4),
  // Cap on total auto-published live discovery markets at any time.
  maxLiveMarkets: integer("max_live_markets").notNull().default(40),
  // House fee (bps) stamped on generated markets.
  defaultFeeBps: integer("default_fee_bps").notNull().default(200),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DiscoveryConfigRow = typeof discoveryConfig.$inferSelect;

/* ------------------------------------------------------------------ */
/*  Slay Reward Program (points system for party-less users)           */
/*                                                                     */
/*  Users WITHOUT a Canton party (wallets.cantonAddress IS NULL) —     */
/*  i.e. every new signup going forward, plus legacy email-only        */
/*  accounts — live entirely in this points-only rewards system. No    */
/*  chain, no CC: just Slay Points, weekly Slay Drops tiers, and a     */
/*  lifetime Slay Jar. Fully decoupled from the on-chain rewards       */
/*  tables above (signupBonusClaims / milestoneClaims / referrals).    */
/* ------------------------------------------------------------------ */

export const slayTierEnum = pgEnum("slay_tier", ["silver", "gold", "platinum", "diamond"]);

export const slayActivityTypeEnum = pgEnum("slay_activity_type", [
  "signup",
  "referral_bonus", // flat bonus for referring / being referred
  "referral_share", // 20% share of a referee's earnings, credited to referrer
  "daily_checkin",
  "profile_x",
  "profile_linkedin",
  "social_twitter",
  "social_telegram",
  "social_review",
  "social_extension",
  "social_post",
  "bet",
  "wallet_txn",
  "topup",
]);

/** One row per party-less user — their running points + streak + tier state. */
export const slayRewardProfiles = pgTable("slay_reward_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // Lifetime points — never decreases. This IS the Slay Jar total.
  totalPoints: doublePrecision("total_points").notNull().default(0),
  // Points earned in the current weekly window. Reset to 0 on rollover
  // (the lifetime total already retains them, so the Jar keeps them).
  weeklyPoints: doublePrecision("weekly_points").notNull().default(0),
  // Start of the current weekly window. Rolls forward in WEEK_MS steps.
  weekAnchor: timestamp("week_anchor", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Daily check-in streak. currentStreak resets to 1 when a day is missed.
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  lastCheckInAt: timestamp("last_check_in_at", { withTimezone: true }),
  // Cached Slay Drops (weekly) tier — recomputed on every award/rollover.
  tier: slayTierEnum("tier").notNull().default("silver"),
  // This user's own referral code (shareable). Generated at profile create.
  referralCode: text("referral_code").notNull().unique(),
  // The user who referred them (nullable; set at most once, first code wins).
  referredByUserId: text("referred_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SlayRewardProfileRow = typeof slayRewardProfiles.$inferSelect;

/** Append-only ledger of every point-earning event. Powers the activity feed. */
export const slayRewardActivities = pgTable("slay_reward_activities", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: slayActivityTypeEnum("type").notNull(),
  points: doublePrecision("points").notNull(),
  // Free-form context (e.g. { streak: 5 } for check-ins, { code, referee }
  // for referral events). Nullable.
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One-time task completions (profile verifications + social tasks). The
 * (userId, taskKey) unique index makes claims idempotent at the DB layer —
 * a double-tap of a Claim button can't credit points twice.
 */
export const slayRewardTasks = pgTable(
  "slay_reward_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    points: doublePrecision("points").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userTaskIdx: uniqueIndex("slay_tasks_user_key_idx").on(t.userId, t.taskKey),
  })
);

export type SlayRewardTaskRow = typeof slayRewardTasks.$inferSelect;

/**
 * Verified external-account links backing reward-task verification. A row here
 * is PROOF the user completed a social/profile action (linked X, joined the
 * Telegram group, installed the extension, …). The verifiers in
 * slay-rewards/verifiers.ts read this table so a task can only be claimed once
 * its link exists — no more tap-to-earn. `meta` holds provider-specific detail
 * (e.g. follow-checked-at, tokens are NOT stored here).
 */
export const slayAccountLinks = pgTable(
  "slay_account_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // "x" | "linkedin" | "telegram" | "extension"
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    externalHandle: text("external_handle"),
    meta: jsonb("meta"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userProviderIdx: uniqueIndex("slay_account_links_user_provider_idx").on(t.userId, t.provider),
  })
);

export type SlayAccountLinkRow = typeof slayAccountLinks.$inferSelect;

/**
 * Bypass onboarding coupons. A coupon lets a waitlist (party-less) user skip
 * the party-creation freeze and get onboarded on redemption. Owned here in
 * Postgres; the website admin dashboard is a thin CRUD layer over this.
 */
export const slayCoupons = pgTable("slay_coupons", {
  code: text("code").primaryKey(), // uppercase, human-shareable
  label: text("label"), // optional note (campaign name, recipient, …)
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  // Optional: redeemer is credited as referred by this user (referral chain).
  referredByUserId: text("referred_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  revoked: boolean("revoked").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: text("created_by"), // admin label, free-form
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SlayCouponRow = typeof slayCoupons.$inferSelect;

/** One row per successful coupon redemption. (couponCode, userId) unique. */
export const slayCouponRedemptions = pgTable(
  "slay_coupon_redemptions",
  {
    id: text("id").primaryKey(),
    couponCode: text("coupon_code")
      .notNull()
      .references(() => slayCoupons.code, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    couponUserIdx: uniqueIndex("slay_coupon_redemption_idx").on(
      t.couponCode,
      t.userId
    ),
  })
);

export type SlayCouponRedemptionRow = typeof slayCouponRedemptions.$inferSelect;

/* ──────────────────────────────────────────────────────────────────
 *  Slay Rewards — weekly cycle tables (PRD §4.3, §8)
 * ────────────────────────────────────────────────────────────────── */

/** Per-user weekly-points snapshot at cycle close, before reset. Powers Drops
 *  ranking + reporting. (userId, weekId) unique. */
export const slayWeeklySnapshots = pgTable(
  "slay_weekly_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    weekId: text("week_id").notNull(), // ISO date of the week-start Sunday (UTC)
    weeklyPoints: doublePrecision("weekly_points").notNull(),
    rank: integer("rank"),
    tier: slayTierEnum("tier"),
    onboarded: boolean("onboarded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userWeekIdx: uniqueIndex("slay_weekly_snapshot_idx").on(t.userId, t.weekId) })
);
export type SlayWeeklySnapshotRow = typeof slayWeeklySnapshots.$inferSelect;

/** One Drops payout per user per week. (userId, weekId) unique → idempotent
 *  cycle re-runs never double-pay. */
export const slayDropPayouts = pgTable(
  "slay_drop_payouts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    weekId: text("week_id").notNull(),
    tier: slayTierEnum("tier").notNull(),
    currency: text("currency").notNull().default("CC"),
    amountMicro: bigint("amount_micro", { mode: "number" }).notNull(),
    feesBackMicro: bigint("fees_back_micro", { mode: "number" }).notNull().default(0),
    rakeBackMicro: bigint("rake_back_micro", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("pending"), // pending|paid|failed
    txId: text("tx_id"),
    /** When the user played the crate-open reveal. Presentation only: it never
     *  gates money — redeeming settles `pending` rows regardless of whether the
     *  crate was opened. Null means "not yet revealed in the app". */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userWeekIdx: uniqueIndex("slay_drop_payout_idx").on(t.userId, t.weekId) })
);
export type SlayDropPayoutRow = typeof slayDropPayouts.$inferSelect;

/** ConfigService (PRD §7.2): every tunable as a versioned key→JSON value. The
 *  rewards engine reads via getConfig(key) with a hard-coded fallback. */
export const slayConfig = pgTable("slay_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type SlayConfigRow = typeof slayConfig.$inferSelect;

/** Immutable audit log (PRD §7): who did what, before → after, when. */
export const slayAuditLog = pgTable("slay_audit_log", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity"),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type SlayAuditLogRow = typeof slayAuditLog.$inferSelect;

/* ──────────────────────────────────────────────────────────────────
 *  LetsExchange swaps (on/off ramp)
 *
 *  One row per swap order created via the LetsExchange API. Phase 1 =
 *  deposit direction only: user brings any asset, LetsExchange converts
 *  and delivers CC to the user's own Canton party, where the existing
 *  watermark deposit crediter picks it up. `leTxId` is LetsExchange's
 *  transaction id; `status` mirrors their lifecycle (wait → success).
 * ────────────────────────────────────────────────────────────────── */
/** `native` is a OneSwap on-ledger swap (CC ↔ CBTC ↔ HECTO). It is neither a
 *  deposit nor a withdraw: nothing enters or leaves Canton, so the directional
 *  framing the LetsExchange ramp needs doesn't apply. */
export const swapDirectionEnum = pgEnum("swap_direction", [
  "deposit",
  "withdraw",
  "native",
]);

export const swaps = pgTable(
  "swaps",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    direction: swapDirectionEnum("direction").notNull(),
    /** Which swap backend owns this row. Two protocols share this table
     *  because the columns genuinely line up; this is what keeps them from
     *  being confused for each other in a query. */
    provider: text("provider").notNull().default("letsexchange"),
    /** OneSwap settles against exactly one pool ('rt-...'). NULL for
     *  LetsExchange, which has no such concept. */
    poolId: text("pool_id"),
    /** The provider's own id for the order. LetsExchange transaction_id, or
     *  OneSwap's 'esc_...' swap id — one unique index covers both. */
    leTxId: text("le_tx_id").notNull(),
    coinFrom: text("coin_from").notNull(),
    networkFrom: text("network_from").notNull(),
    coinTo: text("coin_to").notNull(),
    networkTo: text("network_to").notNull(),
    // Decimal strings — assets vary in precision and LetsExchange returns strings.
    depositAmount: text("deposit_amount").notNull(),
    expectedAmount: text("expected_amount").notNull(),
    rate: text("rate"),
    // Where the user sends the FROM asset (LetsExchange deposit address) + memo.
    depositAddress: text("deposit_address").notNull(),
    depositExtraId: text("deposit_extra_id"),
    // Where the OUT asset is delivered (for deposits: the user's CC party).
    withdrawalAddress: text("withdrawal_address").notNull(),
    isFloat: boolean("is_float").notNull().default(true),
    status: text("status").notNull().default("wait"),
    // Set once the delivered CC is mirrored into the user's Postgres balance.
    creditedTxId: text("credited_tx_id"),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("swaps_user_idx").on(t.userId),
    byLeTx: uniqueIndex("swaps_le_tx_idx").on(t.leTxId),
    byProvider: index("swaps_provider_idx").on(t.userId, t.provider),
  })
);

export type SwapRow = typeof swaps.$inferSelect;
/*  Agent API — programmatic wallet access                             */
/*                                                                     */
/*  An "agent" is a credential a program uses to operate a wallet under */
/*  restrictions the owner sets. The defining rule, enforced in the     */
/*  service layer and reflected here: an agent cannot exist without     */
/*  restrictions. There is no default and no unrestricted state.        */
/*                                                                     */
/*  Keys are stored hashed. `keyHash` is SHA-256 of the full secret;    */
/*  `keyPrefix` is the leading public segment, stored clear so a key    */
/*  seen in a log can be identified without being usable.               */
/* ------------------------------------------------------------------ */

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),

    /** SHA-256 of the secret. A dump of this table yields no usable keys. */
    keyHash: text("key_hash").notNull().unique(),
    /** e.g. "sk_live_9x2m" — safe to display and to log. */
    keyPrefix: text("key_prefix").notNull(),

    /** ["balance:read","tx:read","tx:write"] — never empty. */
    capabilities: jsonb("capabilities").$type<string[]>().notNull(),

    /**
     * Spend caps, as DECIMAL STRINGS in CC. Required whenever `tx:write`
     * is present. Stored as numeric so the database does the comparison
     * exactly — a float would silently mis-handle values past ~15 digits,
     * and this is money.
     */
    perTxCc: numeric("per_tx_cc", { precision: 30, scale: 10 }),
    perDayCc: numeric("per_day_cc", { precision: 30, scale: 10 }),
    perMonthCc: numeric("per_month_cc", { precision: 30, scale: 10 }),

    /** null = any recipient. */
    allowedRecipients: jsonb("allowed_recipients").$type<string[] | null>(),
    allowedIps: jsonb("allowed_ips").$type<string[] | null>(),
    requireApprovalAboveCc: numeric("require_approval_above_cc", {
      precision: 30,
      scale: 10,
    }),

    expiresAt: timestamp("expires_at", { withTimezone: true }),
    frozen: boolean("frozen").notNull().default(false),

    /**
     * Rotation grace. When set and in the future, this key still
     * authenticates even though a successor exists — so rotating is not an
     * outage. Past it, the key is dead.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),

    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedIp: text("last_used_ip"),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byUser: index("agents_user_idx").on(t.userId),
    byHash: uniqueIndex("agents_key_hash_idx").on(t.keyHash),
  })
);

/**
 * Rolling spend counters, one row per agent per UTC day.
 *
 * Separate from `agents` so the cap check can be a single conditional UPDATE.
 * Two agent requests hitting the same daily cap concurrently must not both
 * pass: read-then-write across two statements is a race whose failure mode is
 * silent overspend — nothing errors, the number is simply wrong afterwards.
 * The service layer relies on the row lock this table provides.
 */
export const agentSpend = pgTable(
  "agent_spend",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** UTC date, "YYYY-MM-DD". Day boundaries are UTC, not local. */
    day: text("day").notNull(),
    spentCc: numeric("spent_cc", { precision: 30, scale: 10 })
      .notNull()
      .default("0"),
  },
  (t) => ({
    pk: uniqueIndex("agent_spend_pk").on(t.agentId, t.day),
  })
);

/** Every request an agent made. The debugging surface and the audit trail. */
export const agentRequests = pgTable(
  "agent_requests",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    ip: text("ip"),
    errorCode: text("error_code"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAgent: index("agent_requests_agent_idx").on(t.agentId, t.at),
  })
);

/**
 * Management actions by humans. Append-only — nothing in the API updates or
 * deletes a row here, because a log someone can tidy up is not evidence.
 */
export const agentAudit = pgTable(
  "agent_audit",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    detail: text("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("agent_audit_user_idx").on(t.userId, t.at),
  })
);

export const tradingStateEnum = pgEnum("trading_state", [
  "none",
  "pending",
  "approved",
  "rejected",
  "suspended",
]);

/**
 * Whether an account may move money programmatically.
 *
 * Checked on EVERY request rather than stamped onto a key at creation, so
 * suspending an account disables every one of its agents instantly and
 * simultaneously — no key hunting, no propagation delay.
 */
export const tradingApprovals = pgTable("trading_approvals", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  state: tradingStateEnum("state").notNull().default("none"),
  useCase: text("use_case"),
  expectedMonthlyVolumeCc: numeric("expected_monthly_volume_cc", {
    precision: 30,
    scale: 10,
  }),
  reason: text("reason"),
  /** Account ceiling. An agent's cap may be lower, never higher. */
  ceilingPerTxCc: numeric("ceiling_per_tx_cc", { precision: 30, scale: 10 }),
  ceilingPerDayCc: numeric("ceiling_per_day_cc", { precision: 30, scale: 10 }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const memberRoleEnum = pgEnum("member_role", [
  "owner",
  "admin",
  "operator",
  "viewer",
]);

export const memberStatusEnum = pgEnum("member_status", [
  "invited",
  "active",
  "suspended",
]);

/** Humans an owner has granted scoped access to their account. */
export const accountMembers = pgTable(
  "account_members",
  {
    id: text("id").primaryKey(),
    /** The account being shared — the owner's user id. */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** Set once the invitee signs in and is matched by email. */
    memberUserId: text("member_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    role: memberRoleEnum("role").notNull().default("viewer"),
    status: memberStatusEnum("status").notNull().default("invited"),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => ({
    byOwner: index("account_members_owner_idx").on(t.ownerUserId),
    uniqueEmail: uniqueIndex("account_members_owner_email_idx").on(
      t.ownerUserId,
      t.email
    ),
  })
);

/* ------------------------------------------------------------------ *
 *  sports_fixtures — the bridge between a Slay market and the upstream
 *  sports event it mirrors.
 *
 *  Markets deliberately know nothing about where they came from. But a
 *  sports market has to be re-joined to The Odds API to answer "what's the
 *  score right now", and that lookup is keyed by SPORT KEY + EVENT ID —
 *  neither of which a market row carries. This table holds that mapping and
 *  doubles as the score cache, so the fixture feed never calls the upstream
 *  API on a user request (the free tier is ~500 requests/month; a per-request
 *  fetch would exhaust it in minutes).
 *
 *  Rows are written by sports/import.ts when a fixture is published, and
 *  refreshed by the scores cron. One row per market.
 * ------------------------------------------------------------------ */
export const sportsFixtures = pgTable(
  "sports_fixtures",
  {
    marketId: text("market_id")
      .primaryKey()
      .references(() => markets.id, { onDelete: "cascade" }),
    /** The Odds API event id. Also the `odds:<id>` dedupe key's payload. */
    eventId: text("event_id").notNull(),
    /** The Odds API sport key, e.g. "soccer_epl" — needed for /scores. */
    sportKey: text("sport_key").notNull(),
    /** Broad group ("Soccer") and competition title ("Premier League"). */
    sportGroup: text("sport_group").notNull(),
    leagueTitle: text("league_title"),
    homeTeam: text("home_team"),
    awayTeam: text("away_team"),
    commenceTime: timestamp("commence_time", { withTimezone: true }),
    /* --- score cache, refreshed by the cron --- */
    /** Team name → score as reported. Cricket returns strings ("186/5"). */
    scores: jsonb("scores").$type<Record<string, string>>(),
    /** True once the upstream marks the event finished. */
    completed: boolean("completed").notNull().default(false),
    /** Upstream's own last-update stamp, when it gives one. */
    scoresUpdatedAt: timestamp("scores_updated_at", { withTimezone: true }),
    /** When WE last wrote this row's scores — drives the refresh throttle. */
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The scores cron walks distinct sport keys for events still in flight.
    bySportKey: index("sports_fixtures_sport_key_idx").on(t.sportKey),
    byCommence: index("sports_fixtures_commence_idx").on(t.commenceTime),
    // One market per upstream event, so a re-import can never fork a fixture.
    uniqueEvent: uniqueIndex("sports_fixtures_event_uq").on(t.eventId),
  })
);

/** Special campaigns — the promos surfaced behind Home's trophy button.
 *  Authored by the team, read by everyone; there is no per-user state here,
 *  so a campaign is just a row with a window and a reward line. */
export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    /** Who's running it — "Slay", "Slay × LetsExchange", a partner name. */
    partner: text("partner").notNull().default("Slay"),
    description: text("description").notNull(),
    /** The reward as it should read: "3×", "+250", "+100". Free text because
     *  campaigns aren't all points — some are multipliers, some are bonuses. */
    reward: text("reward").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Hidden without deleting, so a campaign can be pulled and reinstated. */
    /** Some campaigns apply to everyone who qualifies; others are opt-in.
     *  When false the app shows "Applied automatically" instead of Join. */
    requiresJoin: boolean("requires_join").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byActive: index("campaigns_active_idx").on(t.active, t.endsAt) })
);
export type CampaignRow = typeof campaigns.$inferSelect;

/** Proof submissions for tasks that a verifier can't settle on its own — the
 *  "post about Slay and tag us" kind, where a human decides. People post
 *  repeatedly, so this is a list per user per task, not a single done flag.
 *  Points are awarded on approval, not on submission. */
export const slaySubmissions = pgTable(
  "slay_submissions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Matches a SlayTaskKey — which task this is proof for. */
    taskKey: text("task_key").notNull(),
    url: text("url").notNull(),
    /** review → approved | rejected. Only approved pays. */
    status: text("status").notNull().default("review"),
    /** Shown to the user when a submission is turned down. */
    reviewerNote: text("reviewer_note"),
    pointsAwarded: doublePrecision("points_awarded").notNull().default(0),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserTask: index("slay_submissions_user_task_idx").on(t.userId, t.taskKey),
    // The review queue reads exactly this: status='review' ordered oldest
    // first. Without it that's a seq scan over every submission ever made.
    byQueue: index("slay_submissions_queue_idx").on(t.status, t.createdAt),
  })
);
export type SlaySubmissionRow = typeof slaySubmissions.$inferSelect;

/** Settled crypto rounds, kept so the round detail can show the previous
 *  windows alongside the live one. Written by the reconcile sweep, which sees
 *  every ended window — not by bet settlement, because a round nobody bet on
 *  still has to appear in the strip. */
export const pmRoundHistory = pgTable(
  "pm_round_history",
  {
    /** Polymarket's condition id — one row per window, so re-runs upsert. */
    conditionId: text("condition_id").primaryKey(),
    asset: text("asset").notNull(),
    duration: text("duration").notNull(),
    slug: text("slug"),
    startEpoch: bigint("start_epoch", { mode: "number" }),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    /** "up" | "down". Only written once Polymarket resolves unambiguously. */
    winner: text("winner").notNull(),
    /** Up-side implied probability in cents at the last read before close. */
    upCloseCents: integer("up_close_cents"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The strip asks for "the last N rounds of this asset+duration".
    byWindow: index("pm_round_history_window_idx").on(t.asset, t.duration, t.endMs),
  })
);
export type PmRoundHistoryRow = typeof pmRoundHistory.$inferSelect;

/** Who has opted into which campaign. Separate from `campaigns` because a
 *  campaign is one row read by everyone, while joining is per user — and some
 *  campaigns need no join at all (they apply to everyone automatically). */
export const campaignJoins = pgTable(
  "campaign_joins",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One join per user per campaign — re-tapping Join must be a no-op.
    uniqueJoin: uniqueIndex("campaign_joins_uq").on(t.campaignId, t.userId),
    byUser: index("campaign_joins_user_idx").on(t.userId),
  })
);
export type CampaignJoinRow = typeof campaignJoins.$inferSelect;

/* ------------------------------------------------------------------ *
 *  Wallet provider configuration
 *
 *  Per-partner fee and token settings for the wallet provider API. One row
 *  per account; absence means "use the global defaults", so an account that
 *  has never opened the screen behaves exactly as it did before this table
 *  existed. That is deliberate — a config table that changes behaviour by
 *  existing is a migration hazard.
 *
 *  ADDITIVE ONLY. New table, no column renamed or dropped, so the wallet
 *  provider Worker can be running a build from weeks ago and is completely
 *  unaffected until it ships code that reads this. That is the expand step
 *  of expand/contract, and the reason this is safe to deploy first.
 * ------------------------------------------------------------------ */
export const walletProviderConfig = pgTable("wallet_provider_config", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  /**
   * How the PARTNER'S OWN take is calculated. Slay's base fee is charged
   * regardless and is not represented here — a partner configures what they
   * add, never what Slay collects. `none` means they add nothing.
   */
  feeMode: text("fee_mode").$type<"none" | "flat" | "bps">().default("none").notNull(),

  /** Flat partner take per send, decimal CC. Used when feeMode = 'flat'. */
  feeFlatCc: numeric("fee_flat_cc", { precision: 30, scale: 10 }),

  /** Partner take in basis points (1 bp = 0.01%). Used when feeMode = 'bps'. */
  feeBps: integer("fee_bps"),

  /**
   * Ceiling on the partner's take per send, decimal CC.
   *
   * Only meaningful for `bps`, and the reason it exists is that a percentage
   * of a large transfer is a large number. Without a cap, a 250bp partner
   * takes 25 CC out of a 1000 CC send, which is not what anyone typed into
   * the box when they thought "2.5%".
   */
  feeMaxCc: numeric("fee_max_cc", { precision: 30, scale: 10 }),

  /**
   * Canton party that receives the partner's take. Null disables the partner
   * fee no matter what feeMode says — charging a fee with nowhere to send it
   * would silently shrink the transfer, which is precisely the bug this
   * codebase already has once.
   */
  feeRecipientParty: text("fee_recipient_party"),

  /** Partner override for the free daily send allowance. Null = global default. */
  freeTxnsPerDay: integer("free_txns_per_day"),

  /**
   * Assets this partner's wallets may hold and move, e.g. ["cc","cbtc"].
   *
   * Null means every supported asset — NOT none. A partner who has never
   * configured tokens keeps working, which is the same reasoning as the row
   * being optional. An empty array is a real setting meaning "nothing", and
   * is distinguishable from null on purpose.
   */
  enabledTokens: jsonb("enabled_tokens").$type<string[] | null>(),

  /* withTimezone, like all 35 other tables here. It was the one declaration
   * without it, and a bare `timestamp` in Postgres discards the offset — so
   * two Workers in different regions would disagree about when a row was
   * written. Free to fix while the table does not exist yet; a migration
   * once it does. */
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type WalletProviderConfigRow = typeof walletProviderConfig.$inferSelect;
