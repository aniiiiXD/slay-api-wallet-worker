import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Local-development escape hatch.
 *
 * The app talks to Postgres through Neon's HTTP driver, which addresses Neon's
 * endpoint rather than Postgres directly — so it cannot reach a plain local
 * server. Running a local Neon HTTP proxy in front of an ordinary Postgres
 * closes that gap without changing a single query or import.
 *
 * This only engages for a localhost/localtest DATABASE_URL, so production is
 * untouched by construction: a Neon connection string never matches, and there
 * is no flag anyone can set incorrectly.
 *
 *   docker run -d --name slay-pg \
 *     -e POSTGRES_USER=slay -e POSTGRES_PASSWORD=… -e POSTGRES_DB=slay \
 *     -p 5435:5432 postgres:17-alpine
 *
 *   docker run -d --name slay-neon-proxy --network slay-net \
 *     -e PG_CONNECTION_STRING=postgres://slay:…@slay-pg:5432/slay \
 *     -p 4444:4444 ghcr.io/timowilhelm/local-neon-http-proxy:main
 *
 *   DATABASE_URL=postgres://slay:…@db.localtest.me:4444/slay
 *
 * `db.localtest.me` rather than `localhost`: the driver derives an endpoint id
 * from the hostname's first label, and a bare `localhost` has no label to read.
 */
function configureForLocal(databaseUrl: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return;
  }

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".localtest.me");

  if (!isLocal) return;

  // Plain HTTP and an unencrypted socket: the proxy terminates on this machine
  // and there is no certificate to verify. Reachable only through the isLocal
  // branch above, so it can never apply to a real Neon host.
  neonConfig.fetchEndpoint = (h, port) =>
    `http://${h}:${port === 443 ? 4444 : port}/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.wsProxy = (h, port) => `${h}:${port === 443 ? 4444 : port}/v2`;
  neonConfig.poolQueryViaFetch = true;
}

/**
 * Create a Drizzle client bound to the active request's DATABASE_URL.
 * On Cloudflare Workers env vars come per-request via Hono's c.env, so we
 * construct the client per request. Neon's HTTP driver is fast for that.
 */
export function createDb(databaseUrl: string) {
  configureForLocal(databaseUrl);
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

export type DB = ReturnType<typeof createDb>;
export { schema };
