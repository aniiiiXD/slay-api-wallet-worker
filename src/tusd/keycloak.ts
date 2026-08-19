import type { Env } from "../env";
import { getM2mToken, invalidateM2mToken, type OidcConfig } from "../registry-auth";

export class TusdAuthError extends Error {}

function cfg(env: Env): OidcConfig {
  return {
    host: env.TUSD_KEYCLOAK_HOST,
    realm: env.TUSD_KEYCLOAK_REALM,
    clientId: env.TUSD_KEYCLOAK_CLIENT_ID,
    clientSecret: env.TUSD_KEYCLOAK_CLIENT_SECRET,
    audience: env.TUSD_KEYCLOAK_AUDIENCE,
    provider: env.TUSD_KEYCLOAK_PROVIDER ?? "keycloak",
    pathPrefix: env.TUSD_KEYCLOAK_PATH_PREFIX ?? "",
  };
}

export async function getTusdKeycloakToken(env: Env): Promise<string> {
  return getM2mToken(env, cfg(env), { requireCreds: false });
}

export async function invalidateKeycloakToken(env: Env): Promise<void> {
  return invalidateM2mToken(env, cfg(env));
}
