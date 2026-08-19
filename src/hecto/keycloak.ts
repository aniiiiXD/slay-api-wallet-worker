import type { Env } from "../env";
import { getM2mToken, invalidateM2mToken, type OidcConfig } from "../registry-auth";

export class HectoAuthError extends Error {}

function cfg(env: Env): OidcConfig {
  return {
    host: env.HECTO_KEYCLOAK_HOST,
    realm: env.HECTO_KEYCLOAK_REALM,
    clientId: env.HECTO_KEYCLOAK_CLIENT_ID,
    clientSecret: env.HECTO_KEYCLOAK_CLIENT_SECRET,
    audience: env.HECTO_KEYCLOAK_AUDIENCE,
    provider: env.HECTO_KEYCLOAK_PROVIDER ?? "keycloak",
    pathPrefix: env.HECTO_KEYCLOAK_PATH_PREFIX ?? "",
  };
}

export async function getHectoKeycloakToken(env: Env): Promise<string> {
  return getM2mToken(env, cfg(env), { requireCreds: false });
}

export async function invalidateKeycloakToken(env: Env): Promise<void> {
  return invalidateM2mToken(env, cfg(env));
}
