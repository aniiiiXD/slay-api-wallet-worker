import type { Env } from "../env";

export async function discoverOperatorHoldingsViaLedger(
  env: Env,
  party: string,
  instrumentId: string,
  decimals: number,
  minAmountSat: number,
  maxCids = 50
): Promise<string[]> {
  const ledgerHost = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!ledgerHost || !token) return [];
  const factor = 10 ** decimals;

  const endRes = await fetch(`${ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!endRes.ok) return [];
  const end = Number(((await endRes.json()) as { offset?: string }).offset);
  if (!Number.isFinite(end)) return [];

  const WINDOW = 1000;
  const MAX_WINDOWS = 100;
  const created = new Map<string, number>();
  const archived = new Set<string>();

  const covering = (): string[] | null => {
    const live = [...created.entries()]
      .filter(([c]) => !archived.has(c))
      .sort((a, b) => b[1] - a[1]);
    const out: string[] = [];
    let sum = 0;
    for (const [c, a] of live) {
      out.push(c);
      sum += a;
      if (sum >= minAmountSat) return out;
      if (out.length >= maxCids) return out;
    }
    return null;
  };

  for (let i = 0; i < MAX_WINDOWS; i++) {
    const winEnd = end - i * WINDOW;
    const winBegin = Math.max(0, winEnd - WINDOW);
    if (winEnd <= 0) break;

    const r = await fetch(`${ledgerHost}/v2/updates/flats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      body: JSON.stringify({
        beginExclusive: String(winBegin),
        endInclusive: String(winEnd),
        filter: {
          filtersByParty: {
            [party]: {
              cumulative: [
                { WildcardFilter: { value: { includeCreatedEventBlob: false } } },
              ],
            },
          },
        },
        verbose: true,
      }),
    });
    if (!r.ok) continue;

    const body = (await r.json()) as Array<{
      update?: { Transaction?: { value?: { events?: any[] } } };
    }>;
    for (const rec of body) {
      const evs = rec.update?.Transaction?.value?.events ?? [];
      for (const ev of evs) {
        const c = ev.CreatedEvent?.value ?? ev.CreatedEvent;
        const a = ev.ArchivedEvent?.value ?? ev.ArchivedEvent;
        if (c) {
          const arg = c.createArgument ?? {};
          const tpl: string = c.templateId ?? "";
          const iid = arg.instrument?.id ?? arg.instrumentId?.id;
          if (
            arg.owner === party &&
            iid === instrumentId &&
            arg.lock == null &&
            tpl.includes("Holding")
          ) {
            const amt = Math.round(Number(arg.amount ?? "0") * factor);
            if (Number.isFinite(amt) && amt > 0) created.set(c.contractId, amt);
          }
        }
        if (a?.contractId) archived.add(a.contractId);
      }
    }

    const cov = covering();
    if (cov) return cov;
  }

  const live = [...created.entries()]
    .filter(([c]) => !archived.has(c))
    .sort((a, b) => b[1] - a[1]);
  return live.slice(0, maxCids).map(([c]) => c);
}
