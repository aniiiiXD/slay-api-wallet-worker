/**
 * Extension client — data source B.
 *
 * Everything here talks to `window.slay`, the CIP-0103 provider the Slay Money
 * browser extension injects. Nothing here touches the Worker, and nothing here
 * is ever uploaded: connection grants live in the extension's own storage, on
 * this device. That is the point of keeping this file separate from api.ts.
 *
 * Injection is racy. The provider is installed by a content script, which may
 * run after this module is evaluated, so `window.slay` being undefined at
 * import time proves nothing. We therefore wait for the `slay#initialized`
 * event (the EIP-1193 style announcement the extension fires) up to a short
 * timeout before concluding the extension is absent.
 */


/* ──────────── Provider surface ──────────── */

export interface RequestPayload {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

export interface SlayProvider {
  request<T = unknown>(args: RequestPayload): Promise<T>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

declare global {
  interface Window {
    slay?: SlayProvider;
  }
}

/** Error codes carried over from EIP-1193, as the extension uses them. */
export const PROVIDER_ERRORS = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
} as const;

/** The `read` / `ledger` / `write` vocabulary from the extension's SCOPE. */
export const SCOPE = {
  READ: "read",
  LEDGER: "ledger",
  WRITE: "write",
} as const;

export type Scope = (typeof SCOPE)[keyof typeof SCOPE];

/** What each scope actually permits, phrased for the person reading it. */
export const SCOPE_COPY: Record<string, { label: string; detail: string }> = {
  [SCOPE.READ]: { label: "Identity", detail: "Can see your party id and handle." },
  [SCOPE.LEDGER]: {
    label: "Ledger read",
    detail: "Can query the contracts your party can see.",
  },
  [SCOPE.WRITE]: {
    label: "Signing",
    detail: "Asks every time — never granted permanently.",
  },
};

/* ──────────── Method shapes ──────────── */

export interface Account {
  partyId: string;
  handle?: string;
  displayName?: string;
}

export interface Network {
  name: string;
  synchronizerId: string;
  dsoParty?: string;
}

export interface ConnectResult {
  isConnected: boolean;
  reason?: string;
  isNetworkConnected?: boolean;
  networkReason?: string;
  /** Async variant — where the user finishes approval. */
  userUrl?: string;
}

/** Vendor method: `slay_listConnections`. */
export interface Connection {
  origin: string;
  scopes: string[];
  /** Epoch milliseconds. */
  grantedAt: number;
}

/* ──────────── Errors ──────────── */

/** The extension is not installed, or has not injected into this page. */
export class ExtensionUnavailableError extends Error {
  constructor() {
    super("The Slay Money extension is not available on this page.");
    this.name = "ExtensionUnavailableError";
  }
}

/** The provider answered with a CIP-0103 error envelope. */
export class ProviderError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.data = data;
  }
  /** 4100 — this origin is not on the extension's vendor-method allow-list. */
  get isUnauthorized(): boolean {
    return this.code === PROVIDER_ERRORS.UNAUTHORIZED;
  }
}

function toProviderError(err: unknown): Error {
  if (err instanceof ProviderError || err instanceof ExtensionUnavailableError) return err;
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "number") {
    const e = err as { code: number; message?: string; data?: unknown };
    return new ProviderError(e.code, e.message ?? "Provider error", e.data);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/* ──────────── Detection ──────────── */

const READY_EVENT = "slay#initialized";
const DETECT_TIMEOUT_MS = 1200;

let detection: Promise<SlayProvider | null> | null = null;

/**
 * Resolve the provider, waiting briefly for a late injection.
 * Memoised: a negative result is cached too, so pages don't each pay the
 * timeout. Call `resetDetection()` after the user installs the extension.
 */
export function getProvider(): Promise<SlayProvider | null> {
  if (detection) return detection;

  detection = new Promise<SlayProvider | null>((resolve) => {
    if (window.slay) {
      resolve(window.slay);
      return;
    }
    let settled = false;
    const done = (p: SlayProvider | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener(READY_EVENT, onReady);
      window.clearTimeout(timer);
      resolve(p);
    };
    const onReady = () => done(window.slay ?? null);
    const timer = window.setTimeout(() => done(window.slay ?? null), DETECT_TIMEOUT_MS);
    window.addEventListener(READY_EVENT, onReady, { once: true });
  });

  return detection;
}

/** Forget a cached detection result — e.g. the user just installed it. */
export function resetDetection(): void {
  detection = null;
}

export async function isExtensionAvailable(): Promise<boolean> {
  return (await getProvider()) !== null;
}

/**
 * How long to wait for the extension before giving up on a call.
 *
 * The extension's own timeout is 60s, which is right for a call a human is
 * approving but far too long here. Worse, the content script silently DROPS
 * any method it does not recognise — no reply, no error — so an extension
 * older than the method being called leaves the page spinning for a full
 * minute with no explanation. That is a normal state during development, and
 * it looks identical to a hang.
 */
const CALL_TIMEOUT_MS = 8000;

async function call<T>(method: string, params?: RequestPayload["params"]): Promise<T> {
  const provider = await getProvider();
  if (!provider) throw new ExtensionUnavailableError();

  try {
    return await Promise.race([
      provider.request<T>(params === undefined ? { method } : { method, params }),
      new Promise<never>((_, reject) =>
        window.setTimeout(
          () =>
            reject(
              new Error(
                `The extension didn't respond to "${method}". ` +
                  `If it was updated recently, reload it at chrome://extensions ` +
                  `and refresh this page — an older build silently ignores methods it doesn't know.`
              )
            ),
          CALL_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    throw toProviderError(err);
  }
}

/* ──────────── CIP-0103 methods ──────────── */

export const slay = {
  connect: () => call<ConnectResult>("connect"),
  listAccounts: () => call<Account[]>("listAccounts"),
  getActiveNetwork: () => call<Network>("getActiveNetwork"),

  /* ───── Vendor methods ─────
   *
   * Not part of CIP-0103. The extension exposes these only to allow-listed
   * origins (localhost:5173 in dev, the deployed dashboard origin in prod) —
   * an arbitrary dApp calling `slay_listConnections` would be enumerating
   * every other site the user has connected, so the gate is the whole design.
   * A non-allow-listed origin gets 4100 UNAUTHORIZED.
   */

  listConnections: async (): Promise<Connection[]> => {
    return call<Connection[]>("slay_listConnections");
  },

  revokeConnection: async (origin: string): Promise<{ revoked: boolean }> => {
    return call<{ revoked: boolean }>("slay_revokeConnection", { origin });
  },
};

/**
 * Turn a provider failure into one sentence a person can act on.
 * Kept here so every caller words the same failure the same way.
 */
export function describeProviderError(err: unknown): string {
  if (err instanceof ExtensionUnavailableError) return err.message;
  if (err instanceof ProviderError) {
    if (err.isUnauthorized) {
      return `This page (${window.location.origin}) is not on the extension's allow-list for connection management. Only origins the extension trusts may list or revoke connections — in development that is http://localhost:5173.`;
    }
    if (err.code === PROVIDER_ERRORS.UNSUPPORTED_METHOD) {
      return "This version of the Slay Money extension does not support connection management. Update the extension and reload.";
    }
    if (err.code === PROVIDER_ERRORS.USER_REJECTED) return "Request dismissed in the extension.";
    if (err.code === PROVIDER_ERRORS.DISCONNECTED) {
      return "The extension is not reachable right now. Reload the page and try again.";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
