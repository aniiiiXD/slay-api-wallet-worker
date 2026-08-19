/**
 * Reliability primitives for the Worker: single-flight (request coalescing) and
 * a circuit breaker for external dependencies. State is per-isolate (Workers
 * reuse isolates across requests, so this coalesces/short-circuits effectively
 * without needing shared storage). Pattern adapted from swapso-backend.
 *
 * Use:
 *  - singleFlight(key, fn): concurrent identical expensive calls share one run.
 *  - getBreaker(name).exec(fn): fast-fail an upstream that's failing, so we stop
 *    hammering it (this is what prevents Auth0-M2M-quota burn + scan/ledger
 *    retry-storms during an outage). READS should serve stale on CircuitOpenError;
 *    WRITES/transfers must fail loud — never silently drop a money move.
 */

/* ------------------------------- single-flight ------------------------------- */

const inFlight = new Map<string, Promise<unknown>>();

/** Only the first caller runs `fn`; concurrent callers for `key` share it. */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn()
    .then((r) => {
      inFlight.delete(key);
      return r;
    })
    .catch((e) => {
      inFlight.delete(key);
      throw e;
    });
  inFlight.set(key, p);
  return p;
}

/* ------------------------------ circuit breaker ------------------------------ */

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitOptions {
  failureThreshold?: number; // failures within windowMs before opening
  windowMs?: number;
  cooldownMs?: number; // how long to stay OPEN before a probe
  timeoutMs?: number; // per-call timeout
}

export class CircuitOpenError extends Error {
  constructor(public service: string) {
    super(`Circuit "${service}" is OPEN — fast-failing`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures: number[] = [];
  private openedAt = 0;
  private failureThreshold: number;
  private windowMs: number;
  private cooldownMs: number;
  private timeoutMs: number;

  constructor(private name: string, opts: CircuitOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
  }

  getState() {
    return { name: this.name, state: this.state, failures: this.recentFailures() };
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "HALF_OPEN";
      } else {
        throw new CircuitOpenError(this.name);
      }
    }
    try {
      const r = await this.withTimeout(fn());
      if (this.state === "HALF_OPEN") {
        this.state = "CLOSED";
        this.failures = [];
      }
      return r;
    } catch (e) {
      this.failures.push(Date.now());
      if (this.state === "HALF_OPEN") {
        this.state = "OPEN";
        this.openedAt = Date.now();
      } else if (this.recentFailures() >= this.failureThreshold) {
        this.state = "OPEN";
        this.openedAt = Date.now();
        console.warn(`[circuit:${this.name}] OPEN (${this.recentFailures()}/${this.failureThreshold} failures)`);
      }
      throw e;
    }
  }

  private recentFailures(): number {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[circuit:${this.name}] timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }
}

const breakers = new Map<string, CircuitBreaker>();

/** Shared breaker per dependency name (so all callers trip the same circuit). */
export function getBreaker(name: string, opts?: CircuitOptions): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = new CircuitBreaker(name, opts);
    breakers.set(name, b);
  }
  return b;
}

export function breakerStates() {
  return [...breakers.values()].map((b) => b.getState());
}
