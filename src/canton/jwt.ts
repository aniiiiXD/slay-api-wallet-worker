/**
 * HS256-signed JWT for the Canton 3.x JSON Ledger API (v2) and the
 * Splice Validator API.
 *
 * Canton 3.x dropped the v1-style `https://daml.com/ledger-api` namespaced
 * claim envelope. Tokens are now flat: top-level `sub`, `aud`, `scope`,
 * plus the standard `exp` / `iat`. The participant resolves the bearer's
 * Canton user via `sub`, and that user's pre-configured actAs/readAs
 * rights apply to every submission — so we DON'T put parties in the
 * token any more. They flow as fields on the Commands envelope instead.
 *
 * Splice's disable-auth overlay uses HS256 with secret `unsafe` and
 * audience `https://canton.network.global` (configurable per deployment).
 * Both env vars are populated in .dev.vars; prod uses real OIDC.
 */
import type { Env } from "../env";

function base64url(bytes: Uint8Array | string): string {
  const buf =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Mint a Ledger API v2 bearer token.
 *
 * @param env  Runtime env (provides secret + audience + the user id)
 * @param subOverride  Optional Canton user id to put in `sub`. Defaults to
 *                     env.LEDGER_USER_ID which is the operator service user.
 *
 * The Splice participant honours short tokens (no `nbf`, no `iss` needed
 * in unsafe mode). Tokens are short-lived (5 min) because we mint per
 * call — there's no cache to invalidate.
 */
export async function signLedgerJWT(
  env: Env,
  subOverride?: string
): Promise<string> {
  const secret = env.LEDGER_JWT_SECRET || "unsafe";
  const audience = env.LEDGER_JWT_AUDIENCE || "https://canton.network.global";
  const sub = subOverride || env.LEDGER_USER_ID || "slay-money-api";

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub,
    aud: audience,
    scope: "daml_ledger_api",
    iat: now,
    exp: now + 300, // 5 minutes
  };

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  return `${data}.${base64url(new Uint8Array(sig))}`;
}

/**
 * Admin-scoped token for participant management ops (createUser,
 * grantUserRights, uploadDar). Same shape as signLedgerJWT but with
 * an `admin` scope addition.
 */
export async function signAdminJWT(env: Env): Promise<string> {
  const secret = env.LEDGER_JWT_SECRET || "unsafe";
  const audience = env.LEDGER_JWT_AUDIENCE || "https://canton.network.global";
  const sub = env.LEDGER_USER_ID || "slay-money-api";

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub,
    aud: audience,
    // The admin scope grants access to user-management + package upload
    // RPCs on top of regular submission. Participant config decides
    // whether to honour it; in unsafe mode it always does.
    scope: "daml_ledger_api admin",
    iat: now,
    exp: now + 300,
  };

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  return `${data}.${base64url(new Uint8Array(sig))}`;
}
