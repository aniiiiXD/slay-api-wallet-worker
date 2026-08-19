import type { Env } from "./env";
import { getBreaker } from "./lib/reliability";

export class M2mAuthError extends Error {}

export type OidcConfig = {
  host?: string;
  realm?: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  provider?: string;
  pathPrefix?: string;
};

type Entry = { token: string; exp: number };
const l1 = new Map<string, Entry>();

function keyFor(cfg: OidcConfig): string {
  return `m2m:${(cfg.provider ?? "keycloak").toLowerCase()}:${cfg.clientId ?? "none"}`;
}

function tokenUrl(cfg: OidcConfig): string {
  const host = (cfg.host ?? "").replace(/\/$/, "");
  if ((cfg.provider ?? "keycloak").toLowerCase() === "auth0") return `${host}/oauth/token`;
  if (!cfg.realm) throw new M2mAuthError("realm required when provider is keycloak");
  const prefix = cfg.pathPrefix ? `/${cfg.pathPrefix.replace(/^\/|\/$/g, "")}` : "";
  return `${host}${prefix}/realms/${encodeURIComponent(cfg.realm)}/protocol/openid-connect/token`;
}

export async function invalidateM2mToken(env: Env, cfg: OidcConfig): Promise<void> {
  const key = keyFor(cfg);
  l1.delete(key);
  try {
    await env.M2M_TOKEN_CACHE?.delete(key);
  } catch {
    /* best-effort; a re-mint overwrites it anyway */
  }
}

export async function getM2mToken(
  env: Env,
  cfg: OidcConfig,
  opts: { requireCreds: boolean }
): Promise<string> {
  const key = keyFor(cfg);
  const now = Date.now();

  const hit = l1.get(key);
  if (hit && hit.exp > now + 30_000) return hit.token;

  const kv = env.M2M_TOKEN_CACHE;
  if (kv) {
    try {
      const raw = await kv.get(key);
      if (raw) {
        const e = JSON.parse(raw) as Entry;
        if (e.exp > now + 60_000) {
          l1.set(key, e);
          return e.token;
        }
      }
    } catch {
      /* fall through to mint */
    }
  }

  if (!cfg.host || !cfg.clientId || !cfg.clientSecret) {
    if (opts.requireCreds) {
      throw new M2mAuthError("OIDC credentials not set (need host + clientId + clientSecret).");
    }
    return "";
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (cfg.audience) body.append("audience", cfg.audience);

  const url = tokenUrl(cfg);
  // Circuit-break the token mint: if the OIDC provider (e.g. Auth0) is failing
  // or quota-exhausted, stop hammering /oauth/token — repeated mint attempts are
  // exactly what burned the M2M quota before. After a few failures the circuit
  // opens and callers fast-fail for the cooldown instead of spending quota.
  const data = await getBreaker(`m2m-token:${key}`, {
    failureThreshold: 3,
    cooldownMs: 60_000,
    timeoutMs: 10_000,
  }).exec(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new M2mAuthError(`OIDC token endpoint ${res.status} at ${url}: ${text.slice(0, 240)}`);
    }
    const d = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!d.access_token) throw new M2mAuthError("OIDC response missing access_token");
    return { access_token: d.access_token, expires_in: d.expires_in };
  });

  const ttl = data.expires_in ?? 300;
  const entry: Entry = { token: data.access_token, exp: now + ttl * 1000 };
  l1.set(key, entry);
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, ttl - 60) });
    } catch {
      /* best-effort */
    }
  }
  return entry.token;
}
