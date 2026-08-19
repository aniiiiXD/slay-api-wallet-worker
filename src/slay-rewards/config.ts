/**
 * Slay Reward Program config — the points-only rewards system for users who
 * DON'T have a Canton party (new signups + legacy email-only accounts).
 *
 * This is a completely separate system from src/rewards/* (the on-chain CC
 * milestone/signup-bonus system for party-holding users). Nothing here ever
 * touches the chain — it's pure Postgres points.
 *
 * Must stay in sync with slay-money-app/lib/slay-rewards.ts. If you change a
 * point value or task key here, change it there too.
 *
 * Source of truth: the "Slay Reward Program" spec spreadsheet. Only the
 * activities a party-less user can actually perform are wired up (no Bets /
 * Wallet Txns / Top-up — those need a working on-chain wallet).
 */

/* ------------------------------------------------------------------ *
 *  Point values                                                       *
 * ------------------------------------------------------------------ */

/** Sign-up base award. Referral bumps it to SIGNUP_POINTS_WITH_REFERRAL. */
export const SIGNUP_POINTS_WITHOUT_REFERRAL = 10;
export const SIGNUP_POINTS_WITH_REFERRAL = 25;

/** Referral: the referrer gets this flat bonus when their code is used. */
export const REFERRAL_POINTS = 25;
/** The referee's top-up so a referred sign-up nets 25 total (10 base + 15). */
export const REFERRAL_SIGNUP_TOPUP =
  SIGNUP_POINTS_WITH_REFERRAL - SIGNUP_POINTS_WITHOUT_REFERRAL;
/** Referrer also earns this share of every point their referee earns. */
export const REFERRAL_SHARE_RATE = 0.2; // 20%

/* ------------------------------------------------------------------ *
 *  Bets / Wallet Txns — earned by wallet-holding users. CIP-56 tokens *
 *  (CBTC/cETH) earn 2× the CC rate per the spec.                      *
 * ------------------------------------------------------------------ */
export const BET_POINTS_CC = 1.5;
export const BET_POINTS_CIP56 = 3;
export const WALLET_TXN_POINTS_CC = 0.5;
export const WALLET_TXN_POINTS_CIP56 = 1;

// Anti-farming caps for wallet-txn points (UTC day). A point-farming ring was
// caught circulating CC to a tiny recipient set to mint points + burn traffic
// (see slay_fee_phantom_and_wash_ring). Sends beyond these earn NO points.
//   - Global daily ceiling on point-earning sends per user.
//   - Concentration guard: once a user has sent to any single recipient this
//     many times today, further sends stop earning points (kills A↔B / ring wash).
export const POINTED_SENDS_PER_DAY = 15;
export const POINTED_SENDS_PER_RECIPIENT = 5;

// Max referral bonuses a single referrer can EARN per UTC day. Caps referral
// farming even if a bad email slips past the disposable-domain block. The
// referee still gets their own signup bonus; only the referrer's payout is
// capped. (see slay_fee_phantom_and_wash_ring)
export const REFERRAL_DAILY_CAP = 3;

export function betPointsFor(currency: string): number {
  return currency === "CC" ? BET_POINTS_CC : BET_POINTS_CIP56;
}
export function walletTxnPointsFor(currency: string): number {
  return currency === "CC" ? WALLET_TXN_POINTS_CC : WALLET_TXN_POINTS_CIP56;
}

/* ------------------------------------------------------------------ *
 *  Top-up — points by USD value of a deposit. Highest tier that the   *
 *  deposit meets wins (per-deposit, not cumulative).                  *
 * ------------------------------------------------------------------ */
export const TOPUP_TIERS: { usd: number; points: number }[] = [
  { usd: 100, points: 200 },
  { usd: 25, points: 50 },
  { usd: 5, points: 20 },
];

export function topupPointsForUsd(usd: number): number {
  for (const t of TOPUP_TIERS) {
    if (usd >= t.usd) return t.points;
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 *  One-time tasks (self-attested claims).                             *
 *                                                                     *
 *  Each key is claimed at most once per user (DB unique guard). The   *
 *  `type` maps the task to an activity-log enum value. Verification   *
 *  (did they REALLY follow on X, download the extension, …) is a      *
 *  future step — for now claiming is trust-based, same as the spec's  *
 *  manual model. Keep keys stable; the app references them by string. *
 * ------------------------------------------------------------------ */

export type SlayTaskKey =
  | "profile_x"
  | "profile_linkedin"
  | "social_twitter"
  | "social_telegram"
  | "social_review"
  | "social_extension"
  | "social_post";

export type SlayTaskDef = {
  key: SlayTaskKey;
  /** Activity-log enum this task records under. */
  type:
    | "profile_x"
    | "profile_linkedin"
    | "social_twitter"
    | "social_telegram"
    | "social_review"
    | "social_extension"
    | "social_post";
  points: number;
  label: string;
  group: "profile" | "social";
  /** When false the task shows as "coming soon" and cannot be claimed. Only
   *  tasks whose verifier is proven end-to-end are enabled. */
  enabled: boolean;
};

export const SLAY_TASKS: readonly SlayTaskDef[] = [
  // Profile completion
  { key: "profile_x",        type: "profile_x",        points: 10, label: "Verify your X account",       group: "profile", enabled: false },
  { key: "profile_linkedin", type: "profile_linkedin", points: 10, label: "Verify your LinkedIn",        group: "profile", enabled: false },
  // Social media & community. Only Telegram is live (verifier proven end-to-end);
  // the rest stay disabled until each verifier is wired + confirmed.
  { key: "social_twitter",   type: "social_twitter",   points: 10, label: "Follow Slay on X",            group: "social", enabled: false },
  { key: "social_telegram",  type: "social_telegram",  points: 10, label: "Join the Telegram community", group: "social", enabled: true  },
  { key: "social_review",    type: "social_review",    points: 10, label: "Leave a Play/App Store review", group: "social", enabled: false },
  { key: "social_extension", type: "social_extension", points: 25, label: "Download the Slay extension", group: "social", enabled: false },
  { key: "social_post",      type: "social_post",      points: 10, label: "Post about Slay & tag us",     group: "social", enabled: false },
] as const;

export function taskByKey(key: string): SlayTaskDef | undefined {
  return SLAY_TASKS.find((t) => t.key === key);
}

/* ------------------------------------------------------------------ *
 *  Daily check-in                                                     *
 *                                                                     *
 *  Streak-based: day 1 = 1 pt, day 2 = 2 pts, … day 15 = 15 pts. The  *
 *  streak resets to 1 if a day is missed. Points earned on a check-in *
 *  equal the (new) streak length. Uncapped per the spec ("+1 every    *
 *  day").                                                             *
 * ------------------------------------------------------------------ */
export function checkInPointsForStreak(streak: number): number {
  // Points earned equal the streak day: day 8 pays 8. Uncapped, per the spec
  // above. A stretch of this returning a flat 1 regardless of streak was a
  // deviation from that spec, not a change to it.
  return Math.max(1, Math.floor(streak));
}

/* ------------------------------------------------------------------ *
 *  Slay Drops — weekly tier (resets every week with weekly points).   *
 *  Silver / Gold / Platinum, driven by points earned THIS week.       *
 *                                                                     *
 *  Thresholds are placeholders pending founder sign-off — tune here.  *
 * ------------------------------------------------------------------ */
export type SlayTier = "silver" | "gold" | "platinum" | "diamond";

/**
 * 2026-07-31: "Fees back" was removed as a perk. That emptied Silver, so the
 * whole ladder shifted DOWN one — old Gold is now Silver, old Platinum is now
 * Gold, old Diamond is now Platinum. Diamond is retired (kept in the type and
 * the DB enum for back-compat, but unreachable).
 *
 * Tiers are now EARNED: below the Silver threshold a user has no tier, and
 * the UI shows progress toward Silver. Hence the nullable return.
 */
export const DROP_TIER_THRESHOLDS: { tier: SlayTier; min: number }[] = [
  { tier: "platinum", min: 600 },
  { tier: "gold", min: 300 },
  { tier: "silver", min: 100 },
];

export function tierForWeeklyPoints(weekly: number): SlayTier | null {
  for (const t of DROP_TIER_THRESHOLDS) {
    if (weekly >= t.min) return t.tier;
  }
  return null;
}

/** Points still needed to reach the next tier, for the progress copy. */
export function nextDropTier(
  weekly: number
): { tier: SlayTier; min: number; remaining: number } | null {
  const ascending = [...DROP_TIER_THRESHOLDS].reverse();
  for (const t of ascending) {
    if (weekly < t.min) return { ...t, remaining: t.min - weekly };
  }
  return null;
}

export const DROP_TIER_PERKS: Record<SlayTier, string> = {
  silver: "2% rewards",
  gold: "Rake back + 3% rewards",
  platinum: "Rake back + 10% rewards",
  // Retired 2026-07-31 — unreachable, kept for the DB enum.
  diamond: "Rake back + 10% rewards",
};

/* ------------------------------------------------------------------ *
 *  Slay Jar — lifetime points converge here. Has its own tier ladder. *
 *  "All your weekly points converge into the Slay Jar." Jar total ==  *
 *  lifetime total points (we never subtract). Same shift-down as      *
 *  Drops above.                                                       *
 * ------------------------------------------------------------------ */
/** PRD §2.3/§4.2: weekly Slay Points convert into Jar points at 100:1,
 *  fractional (250 weekly pts → 2.5 Jar). Jar tiers below are in Jar points. */
export const JAR_CONVERSION_RATIO = 100;

export const JAR_TIER_THRESHOLDS: { tier: SlayTier; min: number }[] = [
  { tier: "platinum", min: 5000 },
  { tier: "gold", min: 1500 },
  { tier: "silver", min: 500 },
];

export function jarTierForTotal(total: number): SlayTier | null {
  for (const t of JAR_TIER_THRESHOLDS) {
    if (total >= t.min) return t.tier;
  }
  return null;
}

/** Points still needed to reach the next Jar tier. */
export function nextJarTier(
  total: number
): { tier: SlayTier; min: number; remaining: number } | null {
  const ascending = [...JAR_TIER_THRESHOLDS].reverse();
  for (const t of ascending) {
    if (total < t.min) return { ...t, remaining: t.min - total };
  }
  return null;
}

/** Milliseconds in one weekly window (Slay Points refresh cadence). */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 *  Master switch — when truthy, brand-new signups get NO Canton party *
 *  and NO 50 CC welcome bonus; instead they land in the Slay Reward   *
 *  program. Default ON (party creation disabled) because that's the   *
 *  new product direction. Set to "0"/"false" to restore legacy        *
 *  behaviour (every signup gets a party) for local ledger testing.    *
 * ------------------------------------------------------------------ */
export function isPartyCreationDisabled(env: {
  PARTY_CREATION_DISABLED?: string;
}): boolean {
  const v = (env.PARTY_CREATION_DISABLED ?? "").trim().toLowerCase();
  // Default ON when unset. Only an explicit falsy value re-enables parties.
  if (v === "") return true;
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}
