/* ------------------------------------------------------------------ *
 *  oracle-markets/oracle.ts — spot prices for the hourly up/down feature.
 *
 *  Deliberately independent of prices/service.ts's FEEDS list: that list
 *  is the *trade* market's tradeable-asset registry (each id maps to a
 *  DAML asset template). We don't want to bolt ETH onto that AssetId — it
 *  would surface an untradeable ETH tile. Here we just need a raw USD spot
 *  for BTC/ETH from the same Pyth Hermes source, nothing more.
 * ------------------------------------------------------------------ */

export type OracleAsset = "btc" | "eth" | "sol";

type Feed = { asset: OracleAsset; label: string; symbol: string; emoji: string; pythId: string };

export const ORACLE_FEEDS: Feed[] = [
  {
    asset: "btc",
    label: "Bitcoin",
    symbol: "BTC/USD",
    emoji: "₿",
    pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  },
  {
    asset: "eth",
    label: "Ethereum",
    symbol: "ETH/USD",
    emoji: "Ξ",
    pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  },
  {
    asset: "sol",
    label: "Solana",
    symbol: "SOL/USD",
    emoji: "◎",
    pythId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },
];

const HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";

type HermesResponse = {
  parsed?: Array<{
    id: string;
    price: { price: string; expo: number; publish_time: number };
  }>;
};

/**
 * Current USD spot for the given assets, keyed by asset. Missing/failed
 * feeds are simply absent from the map — callers must handle a miss (we
 * never fabricate a price that decides payouts).
 */
export async function fetchOracleSpots(
  assets: OracleAsset[]
): Promise<Map<OracleAsset, number>> {
  const feeds = ORACLE_FEEDS.filter((f) => assets.includes(f.asset));
  const out = new Map<OracleAsset, number>();
  if (feeds.length === 0) return out;

  const qs = feeds.map((f) => `ids[]=${f.pythId}`).join("&");
  try {
    const res = await fetch(`${HERMES_URL}?${qs}&parsed=true`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[oracle] Hermes HTTP ${res.status}`);
      return out;
    }
    const data = (await res.json()) as HermesResponse;
    for (const entry of data.parsed ?? []) {
      // Hermes returns ids without the 0x prefix, lowercase.
      const feed = feeds.find(
        (f) => f.pythId.replace(/^0x/, "").toLowerCase() === entry.id.toLowerCase()
      );
      if (!feed) continue;
      const raw = Number(entry.price.price);
      if (!Number.isFinite(raw)) continue;
      const price = raw * 10 ** entry.price.expo;
      if (price > 0) out.set(feed.asset, price);
    }
  } catch (err) {
    console.error("[oracle] fetch threw:", err instanceof Error ? err.message : String(err));
  }
  return out;
}

export function feedFor(asset: OracleAsset): Feed | undefined {
  return ORACLE_FEEDS.find((f) => f.asset === asset);
}
