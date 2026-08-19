/**
 * Worker client — data source A.
 *
 * Ported from slay-money-ext/src/api.ts, adapted for a web page. Same Worker,
 * same account system, same Better Auth email-OTP flow as the extension and
 * the mobile app.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A LINE-FOR-LINE PORT
 *
 * The extension sets a `Cookie` header by hand: it reads `set-cookie` off the
 * response (which its host_permissions make visible) and replays the value on
 * the next request. A WEB PAGE CANNOT DO THAT. `Cookie` is a forbidden header
 * name — the Fetch spec makes the browser drop any attempt to set it, and
 * `set-cookie` is likewise unreadable from `res.headers.get`. So this client
 * relies on exactly two things:
 *
 *   1. `credentials: "include"` — lets the browser send and store the Worker's
 *      own session cookie, provided the Worker replies with
 *      Access-Control-Allow-Credentials and an explicit Allow-Origin for this
 *      dashboard's origin (a wildcard will not do with credentials).
 *   2. `Authorization: Bearer <token>` — the token from the OTP verify
 *      response, kept in localStorage. This is what carries a session that the
 *      cookie has not (or cannot) establish, e.g. under third-party-cookie
 *      blocking, which is the common case for a cross-site Worker.
 *
 * Practically: the bearer token is the load-bearing credential here, and the
 * cookie is a bonus when the browser allows it.
 * ─────────────────────────────────────────────────────────────────────────
 */


/**
 * Backend base URL.
 *
 * Overridable so the dashboard can point at a local `wrangler dev` without
 * editing source: set VITE_API_URL in dashboard/.env.local. Defaults to
 * production, because that is the right default for anyone who has not
 * deliberately set up a local Worker.
 */
export const API_URL =
  (import.meta.env?.VITE_API_URL as string | undefined) ??
  "https://slay-money-api.slay-money-api.workers.dev";

const TOKEN_KEY = "slay.dashboard.bearer";

/* ──────────── Token storage ──────────── */

export const session = {
  get(): string | null {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return null; // Safari private mode / storage disabled
    }
  },
  set(token: string): void {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* non-fatal: the cookie may still carry the session this tab */
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to do */
    }
  },
};

/* ──────────── Error taxonomy ────────────
 *
 * Three failure modes, three types. The UI branches on these rather than
 * printing one catch-all string, because "sign in again", "you're offline"
 * and "the Worker rejected that" need different actions from the user.
 */

/** The Worker answered, but not with success. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
  /** 401/403 — no usable session. Distinct from "the request failed". */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** The request never reached the Worker (offline, DNS, CORS, TLS). */
export class NetworkError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("Could not reach the Slay Money API.");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/* ──────────── Transport ──────────── */

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const bearer = session.get();
  if (bearer) h["Authorization"] = `Bearer ${bearer}`;
  // No `Cookie` header — see the note at the top of this file. The browser
  // attaches its own cookies because of `credentials: "include"` below.
  return h;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
      credentials: "include",
    });
  } catch (cause) {
    // fetch only rejects for transport-level failures — a 500 resolves.
    throw new NetworkError(cause);
  }

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) msg = body.error;
      else if (body.message) msg = body.message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(
      path,
      // A bodyless POST omits `body` entirely rather than passing undefined —
      // `exactOptionalPropertyTypes` treats those as different things.
      body === undefined
        ? { method: "POST" }
        : { method: "POST", body: JSON.stringify(body) }
    ),
};

/* ──────────── Types — same shapes the extension codes against ──────────── */

export type Wallet = {
  balanceCc: number;
  lockedCc: number;
  openPositionsCount: number;
  cantonAddress: string | null;
  handle: string | null;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
};

export type Transaction = {
  id: string;
  type: string;
  amountCc: number;
  status: "pending" | "confirmed" | "failed";
  counterpartyHandle: string | null;
  memo: string | null;
  refType: string | null;
  refId: string | null;
  /** Lighthouse explorer deep link — present only when refId is a real
   *  Canton update id. The Worker computes this; null for internal rows. */
  lighthouseUrl?: string | null;
  createdAt: string;
};

export type CcPrice = {
  usd: number;
  asOf: string;
  stale: boolean;
};

/* ──────────── Routes ──────────── */

export const wallet = {
  me: () => api.get<Wallet>("/api/wallet"),
  transactions: (limit = 12) =>
    api.get<Transaction[]>(`/api/wallet/transactions?limit=${limit}`),
};

export const ccPrice = () => api.get<CcPrice>("/api/prices/cc");

/* CC price history — the Overview chart. Same CoinGecko series the spot
 * price uses ("canton-network"), served by GET /prices/cc/history. */

export type HistoryWindow = "24h" | "7d";

export type PriceHistory = {
  id: string;
  window: HistoryWindow;
  asOf: string;
  stale: boolean;
  /** Oldest → newest. t = epoch ms, p = USD. */
  points: Array<{ t: number; p: number }>;
};

export const ccHistory = (window: HistoryWindow) =>
  api.get<PriceHistory>(`/api/prices/cc/history?window=${window}`);

/* Network economics — GET /api/stats. One endpoint, read by every tile on
 * Overview and Integrate, so no two boxes can quote different numbers.
 * Each field carries provenance: "scan" = live chain state via the
 * validator's scan-proxy; "fallback" = a stamped constant served when
 * scan is unreachable (always the case in local dev). */

export type NetworkStats = {
  asOf: string;
  sources: {
    round: "scan" | "fallback";
    markerValue: "scan" | "fallback";
    trafficPrice: "scan" | "fallback";
  };
  round: number | null;
  governancePriceUsd: number | null;
  markerValueUsd: number;
  trafficUsdPerKb: number;
  fallbackAsOf: string;
};

export const networkStats = () => api.get<NetworkStats>("/api/stats");

/* ──────────── Wallet KPIs — GET /api/kpis?since= ────────────
 *
 * The server-side rollup of the window Overview reports on, and the fix for
 * the truncation KPIS.md flags: today the page derives its 30-day figures
 * from `GET /api/wallet/transactions?limit=200` and filters client-side,
 * which silently understates every total for an account busier than 200
 * rows. This endpoint counts over the whole window in the database, so
 * nothing is capped — including the per-day buckets.
 *
 * NOT DEPLOYED. In production this 404s today, exactly as
 * /api/integrations/stats below does, and the type is the contract the
 * Worker is being built against rather than a description of something
 * that answers. Two rules follow from that, and both are load-bearing:
 *
 *   1. Every consumer degrades — `kpis(since).catch(() => null)` and then
 *      the client-side computation. Overview must keep working unchanged
 *      while this 404s.
 *   2. Every consumer guards each numeric read. A field that arrives with
 *      a different name than declared here would otherwise print `NaN`
 *      into a money tile, which is worse than printing nothing.
 *
 * The endpoint does not exist in production yet, so a 404 is the expected
 * answer today and every consumer falls back to computing over the
 * transaction list.
 */

/**
 * One day of the window.
 *
 * Present for EVERY day in range, including days with no activity. A gap
 * is a fact about the account; dropping empty days makes a quiet week look
 * busy, which is the same reason `bucketByDay` keeps them client-side.
 */
export type KpiDay = {
  /** Calendar day, `YYYY-MM-DD`. */
  day: string;
  count: number;
  /** Turnover — Σ|amount| for the day, NOT in − out. */
  volumeCc: number;
  inCc: number;
  /** Outbound magnitude, reported positive. */
  outCc: number;
};

export type Kpis = {
  /** Echo of the requested window start, ISO. */
  since: string;
  /** When the rollup was computed, ISO. */
  asOf: string;

  txCount: number;
  inCc: number;
  /** Outbound magnitude, reported positive. */
  outCc: number;
  /** inCc − outCc. */
  netCc: number;
  /** Σ|amount| across the window — turnover, not net. */
  volumeCc: number;

  /** Oldest → newest, one entry per day in the window. */
  days: KpiDay[];

  /* Fee classification. free + paid + unknown === txCount. */
  freeCount: number;
  paidCount: number;
  /**
   * NO FEE RECORD EXISTS for these rows — they predate fee capture, or
   * they fell in a backfill gap.
   *
   * `unknown` is NOT `free`. Scoring an uncaptured row as free is the
   * precise correctness bug the Worker's NETWORK_FEES_PLAN calls out, and
   * folding it into either count here would reproduce it in the UI. Any
   * tile quoting `freeCount` or `paidCount` has to say when this is
   * non-zero, and `totalFeesCc` is then a floor rather than a total.
   */
  unknownCount: number;
  /** CC burned as network fees across the classified rows. */
  totalFeesCc: number;

  /** Provenance, same shape of claim as NetworkStats.sources above. */
  sources: {
    /** "ledger" — counted over the full window; "capped" — server-limited. */
    transactions: "ledger" | "capped";
    /**
     * captured — every row in the window carries a fee record;
     * partial   — some rows are `unknown`;
     * none      — fee capture is not running yet.
     */
    fees: "captured" | "partial" | "none";
    /**
     * ISO instant fee capture began. Rows older than it can only ever be
     * `unknown`. Null when capture has not started.
     */
    feeCaptureStart: string | null;
  };
};

/** @param since ISO 8601 instant the window starts at. */
export const kpis = (since: string) =>
  api.get<Kpis>(`/api/kpis?since=${encodeURIComponent(since)}`);

/* ──────────── Integrator stats ────────────
 *
 * The contract for per-app rollups. The Worker endpoint does NOT exist yet —
 * it needs the `source_origin` attribution migration first — so in real mode
 * this 404s and the Integrate page says so honestly. The type is the spec the
 * migration builds toward, written down where its consumer lives.
 *
 * Canton mechanics behind the numbers (CIP-0047):
 *   - Each real transfer an integrator's app initiates can file a
 *     FeaturedAppActivityMarker worth a governance-set USD amount,
 *     split between beneficiaries by weight. Their share mints to
 *     THEIR party — Slay never custodies it.
 *   - Each transfer consumes synchronizer traffic the validator buys by
 *     burning CC at a governance USD/KB price. That is the cost side.
 */

export type IntegratorStats = {
  origin: string;
  /** ISO date the rollup starts at. */
  since: string;
  txCount: number;
  distinctUsers: number;
  volume: { cc: number; cbtc: number; ceth: number };
  /** Synchronizer bytes this origin's transactions consumed. */
  trafficKb: number;
  /** trafficKb × the round's USD/KB traffic price. */
  trafficBurnUsd: number;
  /** CIP-0047 markers filed with this integrator as beneficiary. */
  markersFiled: number;
  /** Their beneficiary weight on those markers (0..1). */
  markerWeight: number;
  /** CC actually minted to their party from those markers. */
  rewardsCc: number;
  rewardsUsd: number;
  feesUsd: number;
  /** rewardsUsd − trafficBurnUsd − feesUsd. */
  plUsd: number;
  /** Marker USD filed ÷ real burn generated — the fair-use ratio. */
  complianceRatio: number;
};

/* ──────────── Agent keys ────────────
 *
 * Shapes copied from the Worker's `publicAgent()` in src/agents/service.ts,
 * not guessed. Two things about them drive the whole screen:
 *
 *   · `secret` exists ONLY on the create and rotate responses. It is hashed
 *     server-side on the way in and no endpoint returns it again, which is
 *     why the UI has to show it once and say so.
 *   · Every amount is a decimal STRING. CC has six decimal places; parsing
 *     one to a float to render it is how a limit silently becomes a
 *     different limit.
 */

export const CAPABILITIES = ["balance:read", "tx:read", "tx:write"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type AgentRestrictions = {
  capabilities: Capability[];
  limits: {
    perTransactionCc: string | null;
    perDayCc: string | null;
    perMonthCc: string | null;
  };
  allowedRecipients: string[] | null;
  allowedIps: string[] | null;
  expiresAt: string | null;
  requireApprovalAboveCc: string | null;
};

export type Agent = {
  id: string;
  name: string;
  /** Stored in clear so a key can be identified in logs without revealing it. */
  prefix: string;
  restrictions: AgentRestrictions;
  frozen: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
};

/** Only ever returned by create and rotate. Never fetchable. */
export type AgentWithSecret = Agent & { secret: string; oldExpiresAt?: string };

export type NewAgent = {
  name: string;
  restrictions: {
    capabilities: Capability[];
    limits?: { perTransactionCc?: string; perDayCc?: string };
    allowedRecipients?: string[] | null;
    allowedIps?: string[] | null;
  };
};

export type AgentRequest = {
  id: string;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  createdAt: string;
};

/**
 * Whether the ACCOUNT may move money programmatically — separate from any
 * key, and re-checked by the Worker on every write. A key with `tx:write` on
 * an unapproved account still gets 403, so the screen has to surface this or
 * the failure looks like a broken key.
 */
export type TradingStatus = {
  state: "none" | "pending" | "approved" | "suspended" | "rejected";
  appliedAt: string | null;
  decidedAt: string | null;
  reason?: string | null;
  limits?: { perTransactionCc: string | null; perDayCc: string | null };
};

export const agents = {
  list: () => api.get<Agent[]>("/api/keys"),
  create: (body: NewAgent) => api.post<AgentWithSecret>("/api/keys", body),
  revoke: (id: string) => api.del<void>(`/api/keys/${encodeURIComponent(id)}`),
  freeze: (id: string, frozen: boolean) =>
    api.post<Agent>(`/api/keys/${encodeURIComponent(id)}/freeze`, { frozen }),
  rotate: (id: string, graceSeconds = 3600) =>
    api.post<AgentWithSecret>(
      `/api/keys/${encodeURIComponent(id)}/rotate`,
      { graceSeconds }
    ),
  freezeAll: () => api.post<{ frozen: number }>("/api/keys/freeze-all"),
  requests: (id: string, limit = 100) =>
    api.get<AgentRequest[]>(
      `/api/keys/${encodeURIComponent(id)}/requests?limit=${limit}`
    ),
};

export const trading = {
  status: () => api.get<TradingStatus>("/api/trading/status"),
  apply: (useCase: string, expectedMonthlyVolumeCc: string) =>
    api.post<TradingStatus>("/api/trading/apply", {
      useCase,
      expectedMonthlyVolumeCc,
    }),
};

export const integrations = {
  stats: (origin: string) =>
    api.get<IntegratorStats>(
      `/api/integrations/stats?origin=${encodeURIComponent(origin)}`
    ),
};

/* ──────────── Better Auth email-OTP ──────────── */

export const auth = {
  sendCode: (email: string) =>
    api.post<{ success?: boolean }>("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    }),

  verifyCode: async (email: string, otp: string) => {
    const r = await api.post<{
      token?: string;
      user?: { id: string; email: string };
    }>("/api/auth/sign-in/email-otp", { email, otp });
    if (r.token) session.set(r.token);
    return r;
  },

  signOut: async () => {
    try {
      await api.post("/api/auth/sign-out");
    } catch {
      // A failed sign-out call must never strand the user signed in locally.
    }
    session.clear();
  },
};
