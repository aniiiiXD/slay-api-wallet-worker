/**
 * Sections, grouped by what they control, with the data source shown in the
 * nav rather than buried in a README.
 *
 * The source label is a property of the product, not an implementation detail.
 * "On-device" means that data physically cannot be seen by Slay's servers, and
 * anyone deciding whether to trust this page deserves to know that without
 * reading documentation.
 *
 * The agent sections (Agents / Trading / Logs / Members) were removed 2026-08
 * because every endpoint behind them 404'd and the pages ran entirely on
 * fixtures — a dashboard whose majority surface is demo data teaches people to
 * distrust the parts that are real. The note left here said: if the agent API
 * ever ships, build its UI against the real endpoints.
 *
 * It has shipped. `Keys` below is that rebuild, and it was checked first:
 * GET/POST /api/agents, /api/agents/freeze-all and /api/trading/status all
 * answer 401 in production, not 404 — live and auth-gated. No fixtures; when
 * the Worker has nothing to say, the screen says so.
 */

export type Route = "overview" | "activity" | "connections" | "keys" | "integrate";

export type Source = "Worker" | "On-device";

export type Group = "Money" | "Access" | "Build";

export const ROUTES: ReadonlyArray<{
  id: Route;
  label: string;
  source: Source;
  group: Group;
}> = [
  { id: "overview", label: "Overview", source: "Worker", group: "Money" },
  { id: "activity", label: "Activity", source: "Worker", group: "Money" },

  { id: "connections", label: "Connections", source: "On-device", group: "Access" },

  // For businesses integrating their app with Slay over CIP-103: network
  // economics, the CIP-0047 earnings model, and (once source_origin
  // attribution ships) their app's own rollup. Worker-sourced — the page
  // itself labels which tiles are live vs waiting on /api/stats.
  // Agent API keys: issue, restrict, freeze, rotate, revoke. Worker-sourced
  // and session-authenticated — a key can never reach this screen's endpoints,
  // which is what stops a leaked key from minting its own successor.
  { id: "keys", label: "API keys", source: "Worker", group: "Build" },

  { id: "integrate", label: "Integrate", source: "Worker", group: "Build" },
];

export const GROUPS: readonly Group[] = ["Money", "Build", "Access"];

export function routeFromHash(hash: string): Route {
  const id = hash.replace(/^#\/?/, "");
  return ROUTES.some((r) => r.id === id) ? (id as Route) : "overview";
}
