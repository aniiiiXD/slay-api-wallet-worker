import type { Env } from "../env";
import { getM2mToken, invalidateM2mToken, type OidcConfig } from "../registry-auth";

export class CbtcAuthError extends Error {}

function cfg(env: Env): OidcConfig {
  return {
    host: env.CBTC_KEYCLOAK_HOST,
    realm: env.CBTC_KEYCLOAK_REALM,
    clientId: env.CBTC_KEYCLOAK_CLIENT_ID,
    clientSecret: env.CBTC_KEYCLOAK_CLIENT_SECRET,
    audience: env.CBTC_KEYCLOAK_AUDIENCE,
    provider: env.CBTC_KEYCLOAK_PROVIDER ?? "keycloak",
    pathPrefix: env.CBTC_KEYCLOAK_PATH_PREFIX ?? "",
  };
}

export async function getCbtcKeycloakToken(env: Env): Promise<string> {
  return getM2mToken(env, cfg(env), { requireCreds: true });
}

export async function invalidateKeycloakToken(env: Env): Promise<void> {
  return invalidateM2mToken(env, cfg(env));
}
