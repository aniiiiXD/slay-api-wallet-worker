import type { Env } from "../env";
import { getM2mToken, invalidateM2mToken, type OidcConfig } from "../registry-auth";

export class CethAuthError extends Error {}

function cfg(env: Env): OidcConfig {
  return {
    host: env.CETH_KEYCLOAK_HOST,
    realm: env.CETH_KEYCLOAK_REALM,
    clientId: env.CETH_KEYCLOAK_CLIENT_ID,
    clientSecret: env.CETH_KEYCLOAK_CLIENT_SECRET,
    audience: env.CETH_KEYCLOAK_AUDIENCE,
    provider: env.CETH_KEYCLOAK_PROVIDER ?? "keycloak",
    pathPrefix: env.CETH_KEYCLOAK_PATH_PREFIX ?? "",
  };
}

export async function getCethKeycloakToken(env: Env): Promise<string> {
  return getM2mToken(env, cfg(env), { requireCreds: false });
}

export async function invalidateKeycloakToken(env: Env): Promise<void> {
  return invalidateM2mToken(env, cfg(env));
}
