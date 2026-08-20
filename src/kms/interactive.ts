/* ------------------------------------------------------------------ *
 *  kms/interactive.ts — KMS-signed interactive submission for external
 *  parties. Lets a self-custody (external) party exercise a choice —
 *  specifically accept its own incoming token-standard TransferInstruction
 *  (CBTC/cETH/tUSD/HECTO) during migration — by:
 *      prepare  → get the tx + hash to sign
 *      KMS-sign the hash with the party's key
 *      execute  → submit with the party signature
 *  The operator cannot actAs an external party, so this is the only way
 *  its incoming two-phase transfers settle.
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import { signForUser, type EncryptedKey } from "./keys";
import { synchronizerId } from "../splice/traffic";
import { singleFlight } from "../lib/reliability";

const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const b64ToBytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const looksHex = (s: string) => /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
const hexToBytes = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

async function ledgerFetch<T = any>(env: Env, path: string, body: object): Promise<T> {
  const host = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!host || !token) throw new Error("JSON_API_URL / JSON_LEDGER_ADMIN_TOKEN not set");
  const res = await fetch(`${host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${txt.slice(0, 500)}`);
  return (txt ? JSON.parse(txt) : null) as T;
}

/** Find the new party's incoming (pending) token-standard TransferInstruction cid(s). */
export async function findIncomingTransferInstructions(env: Env, party: string): Promise<string[]> {
  const host = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  const endRes = await fetch(`${host}/v2/state/ledger-end`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const offset = Number(((await endRes.json()) as { offset?: string }).offset);
  const r = await fetch(`${host}/v2/state/active-contracts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ activeAtOffset: offset, verbose: false, filter: { filtersByParty: { [party]: { cumulative: [{ WildcardFilter: { value: { includeCreatedEventBlob: false } } }] } } } }),
  });
  const body = (await r.json()) as any[];
  const cids: string[] = [];
  for (const rec of Array.isArray(body) ? body : []) {
    const ce = rec?.contractEntry?.JsActiveContract?.createdEvent ?? rec?.createdEvent;
    // The utility-registry TransferOffer implements the TransferInstruction
    // interface — accept via the interface choice. Match both names.
    if (ce?.templateId && /(TransferInstruction|TransferOffer)/.test(ce.templateId)) cids.push(ce.contractId);
  }
  return cids;
}

/** Debug: every template the party currently holds (to find the TI's real name). */
export async function listPartyTemplates(env: Env, party: string): Promise<Record<string, number>> {
  const host = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  const endRes = await fetch(`${host}/v2/state/ledger-end`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const offset = Number(((await endRes.json()) as { offset?: string }).offset);
  const r = await fetch(`${host}/v2/state/active-contracts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ activeAtOffset: offset, verbose: false, filter: { filtersByParty: { [party]: { cumulative: [{ WildcardFilter: { value: { includeCreatedEventBlob: false } } }] } } } }),
  });
  const body = (await r.json()) as any[];
  const counts: Record<string, number> = {};
  for (const rec of Array.isArray(body) ? body : []) {
    const ce = rec?.contractEntry?.JsActiveContract?.createdEvent ?? rec?.createdEvent;
    const t = ce?.templateId;
    if (t) { const short = t.split(":").slice(-2).join(":"); counts[short] = (counts[short] || 0) + 1; }
  }
  return counts;
}

export interface ExternalExerciseEvent { kind: "created" | "archived"; templateId: string; contractId: string; payload: any }
export interface ExternalExerciseResult { updateId: string | null; events: ExternalExerciseEvent[]; execute: unknown }

async function ledgerEnd(env: Env): Promise<string> {
  const host = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  const r = await fetch(`${host}/v2/state/ledger-end`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  return String(((await r.json()) as { offset?: string }).offset ?? "0");
}

/**
 * Interactive execute commits synchronously but returns an empty body — so we
 * recover the updateId + events by scanning /v2/updates/flats (visible to the
 * acting party) for the transaction carrying our commandId.
 */
async function findUpdateByCommandId(env: Env, party: string, beginExclusive: string, commandId: string): Promise<{ updateId: string | null; events: ExternalExerciseEvent[] }> {
  const host = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const end = await ledgerEnd(env);
    if (end !== beginExclusive) {
      const r = await fetch(`${host}/v2/updates/flats`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          beginExclusive,
          endInclusive: end,
          filter: { filtersByParty: { [party]: { cumulative: [{ WildcardFilter: { value: { includeCreatedEventBlob: false } } }] } } },
          verbose: true,
        }),
      });
      if (r.ok) {
        const body = (await r.json()) as any[];
        for (const rec of Array.isArray(body) ? body : []) {
          const tx = rec?.update?.Transaction?.value;
          if (!tx || tx.commandId !== commandId) continue;
          const events: ExternalExerciseEvent[] = [];
          for (const ev of tx.events ?? []) {
            const cv = ev?.CreatedEvent?.value ?? ev?.CreatedEvent;
            const av = ev?.ArchivedEvent?.value ?? ev?.ArchivedEvent;
            if (cv?.contractId) events.push({ kind: "created", templateId: cv.templateId, contractId: cv.contractId, payload: cv.createArgument ?? cv.createArguments ?? {} });
            else if (av?.contractId) events.push({ kind: "archived", templateId: av.templateId, contractId: av.contractId, payload: {} });
          }
          return { updateId: tx.updateId ?? null, events };
        }
      }
    }
    await new Promise((res) => setTimeout(res, 400 + attempt * 300));
  }
  return { updateId: null, events: [] };
}

/**
 * prepare → KMS-sign → execute for an external party exercising `commands`.
 * Returns the resulting updateId + created/archived events (recovered from the
 * update stream) so callers can read change cids / fees like the custodial
 * exercise() helper.
 */
export async function externalExercise(
  env: Env,
  key: EncryptedKey,
  party: string,
  commands: object[],
  disclosedContracts: unknown[],
  // Extra LOCAL parties (e.g. the operator) that must co-authorize. The
  // participant auto-signs for them during execute; only `party` (external)
  // is KMS-signed. Enables multi-party choices like Slay.Market PlaceBet.
  extraActAs: string[] = []
): Promise<ExternalExerciseResult> {
  const userId = env.LEDGER_USER_ID ?? "slay-money-api";
  const commandId = `ext-${party.slice(-8)}-${Date.now()}`;
  const beginOffset = await ledgerEnd(env);
  const actAs = [party, ...extraActAs];
  const prepared = await ledgerFetch<any>(env, "/v2/interactive-submission/prepare", {
    userId,
    commandId,
    commands,
    actAs,
    readAs: actAs,
    synchronizerId: synchronizerId(env),
    packageIdSelectionPreference: [],
    disclosedContracts,
    verboseHashing: false,
  });
  const preparedTransaction = prepared.preparedTransaction;
  const hashRaw: string = prepared.preparedTransactionHash;
  const hashBytes = looksHex(hashRaw) ? hexToBytes(hashRaw) : b64ToBytes(hashRaw);
  const sig = await signForUser(env, key, hashBytes);
  // signedBy = the party's key fingerprint (the namespace after "::").
  const fingerprint = party.split("::")[1] || party;
  const execute = await ledgerFetch<any>(env, "/v2/interactive-submission/execute", {
    userId,
    preparedTransaction,
    partySignatures: {
      signatures: [
        {
          party,
          signatures: [
            {
              format: "SIGNATURE_FORMAT_CONCAT",
              signature: toB64(sig),
              signedBy: fingerprint,
              signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
            },
          ],
        },
      ],
    },
    deduplicationPeriod: { Empty: {} },
    submissionId: `sub-${Date.now()}`,
    hashingSchemeVersion: prepared.hashingSchemeVersion,
  });
  const { updateId, events } = await findUpdateByCommandId(env, party, beginOffset, commandId);
  return { updateId, events, execute };
}

/**
 * Place a prediction bet FROM a self-custody external bettor. PlaceBet consumes
 * + recreates the Market (operator co-signs) and creates the Bet (bettor signs),
 * so it's a multi-party interactive submission: bettor KMS-signs, operator
 * (local) auto-signs via extraActAs. Returns the events so the caller can pull
 * the new Market cid + Bet cid.
 */
export async function placeBetExternal(
  env: Env,
  bettorKey: EncryptedKey,
  bettorParty: string,
  marketCid: string,
  arg: unknown,
  disclosed: unknown[] = [],
  // Whether the operator must co-sign. Interactive submission can't auto-sign
  // the local operator, so if PlaceBet's authority is delegated through the
  // Market contract (operator is a signatory of the Market, not a choice
  // controller), pass false → bettor-only KMS signature suffices.
  withOperator = true
): Promise<ExternalExerciseResult> {
  const { MarketTemplate } = await import("../canton/templates");
  const { tidToString, operatorParty } = await import("../canton/ledger");
  const templateId = tidToString(MarketTemplate.templateId(env));
  const extraActAs = withOperator ? [operatorParty(env)] : [];
  return externalExercise(
    env,
    bettorKey,
    bettorParty,
    [{ ExerciseCommand: { templateId, contractId: marketCid, choice: "PlaceBet", choiceArgument: arg } }],
    disclosed,
    extraActAs
  );
}

/**
 * Send CC FROM a self-custody external party via the recipient's
 * TransferPreapproval, KMS-signing the TransferPreapproval_Send. This is the
 * external-sender counterpart of the custodial preapproval send.
 */
export async function sendCcFromExternal(
  env: Env,
  senderKey: EncryptedKey,
  senderParty: string,
  recipientParty: string,
  amountCc: number,
  memo: string
): Promise<unknown> {
  const { fetchTransferPreapproval, transferViaPreapprovalDirect } = await import("../splice/amulet");
  const preapproval = await fetchTransferPreapproval(env, recipientParty);
  if (!preapproval) throw new Error(`recipient ${recipientParty} has no TransferPreapproval`);
  return transferViaPreapprovalDirect(env, senderParty, recipientParty, amountCc, memo, preapproval, senderKey);
}

export type RegistryAsset = "cbtc" | "ceth" | "tusd" | "hecto";

async function assetInstrument(env: Env, asset: RegistryAsset): Promise<{ id: string; decimals: number }> {
  let inst: any;
  switch (asset) {
    case "cbtc": inst = await (await import("../cbtc/registry")).getCbtcInstrument(env); break;
    case "ceth": inst = await (await import("../ceth/registry")).getCethInstrument(env); break;
    case "tusd": inst = await (await import("../tusd/registry")).getTusdInstrument(env); break;
    case "hecto": inst = await (await import("../hecto/registry")).getHectoInstrument(env); break;
  }
  return { id: inst.instrumentId?.id, decimals: inst.decimals ?? 10 };
}

const HOLDING_IFACE = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

/**
 * Ledger-end offset, memoised for a beat. A wallet load reads four token
 * balances (CBTC/cETH/tUSD/HECTO) plus CC, and each was paying its own
 * ledger-end round trip before it could even ask for holdings. The offset is
 * party- and asset-independent, so they can share one.
 *
 * The TTL is deliberately ~1s, not the balance cache's 20s: a send
 * invalidates the balance cache and the next read must see the transfer that
 * just settled. An offset a second old is within the same window the ledger
 * itself is still catching up in; a longer memo could read the chain from
 * before the user's own transfer and show them a balance that already moved.
 */
const LEDGER_END_TTL_MS = 1_000;
let ledgerEndMemo: { offset: number; ts: number } | null = null;

async function ledgerEndOffset(host: string, token: string): Promise<number> {
  const now = Date.now();
  if (ledgerEndMemo && now - ledgerEndMemo.ts < LEDGER_END_TTL_MS) {
    return ledgerEndMemo.offset;
  }
  return singleFlight("ledger-end-offset", async () => {
    if (ledgerEndMemo && Date.now() - ledgerEndMemo.ts < LEDGER_END_TTL_MS) {
      return ledgerEndMemo.offset;
    }
    const endRes = await fetch(`${host}/v2/state/ledger-end`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const offset = Number(((await endRes.json()) as { offset?: string }).offset);
    ledgerEndMemo = { offset, ts: Date.now() };
    return offset;
  });
}

/**
 * Sum a party's on-chain holdings for one registry asset, in smallest units,
 * read DIRECTLY from the ledger via the Holding interface view (the registry
 * holdings API 404s for non-registered parties; this is what the transfer
 * ledger-walk uses and is authoritative).
 */
export async function onChainRegistryBalanceSat(
  env: Env,
  asset: RegistryAsset,
  party: string
): Promise<{ sat: number; decimals: number; holdings: number }> {
  const { id: wantInstrument, decimals } = await assetInstrument(env, asset);
  const host = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const token = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  const activeAtOffset = await ledgerEndOffset(host, token);
  const res = await fetch(`${host}/v2/state/active-contracts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: { interfaceId: HOLDING_IFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } } }] } } },
      verbose: false,
      activeAtOffset,
    }),
  });
  if (!res.ok) throw new Error(`holdings ledger-walk ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); }
  const rows: any[] = Array.isArray(parsed) ? parsed : parsed?.contractEntry ? [parsed] : [];
  const factor = 10 ** decimals;
  let sat = 0;
  let holdings = 0;
  for (const rec of rows) {
    const ev = rec?.contractEntry?.JsActiveContract?.createdEvent ?? rec?.createdEvent;
    const view = ev?.interfaceViews?.[0]?.viewValue ?? ev?.createArgument;
    if (!view) continue;
    if (view.owner !== party) continue;
    if ((view.instrumentId?.id ?? null) !== wantInstrument) continue;
    sat += Math.round(Number(view.amount) * factor);
    holdings++;
  }
  return { sat, decimals, holdings };
}

/**
 * Dispatch the per-asset transfer. Without externalKey: custodial (operator
 * actAs sender). With externalKey: sender is a self-custody external party and
 * the TransferFactory_Transfer is KMS-signed via interactive submission.
 */
async function transferRegistryAsset(
  env: Env,
  asset: RegistryAsset,
  sender: string,
  recipient: string,
  amountSat: number,
  memo: string,
  externalKey?: EncryptedKey
): Promise<{ updateId: string; transferInstructionCid: string | null }> {
  switch (asset) {
    case "cbtc": {
      const { transferCbtc } = await import("../cbtc/transfer");
      return transferCbtc(env, sender, recipient, amountSat, memo, externalKey);
    }
    case "ceth": {
      const { transferCeth } = await import("../ceth/transfer");
      return transferCeth(env, sender, recipient, amountSat, memo, externalKey);
    }
    case "tusd": {
      const { transferTusd } = await import("../tusd/transfer");
      return transferTusd(env, sender, recipient, amountSat, memo, externalKey);
    }
    case "hecto": {
      const { transferHecto } = await import("../hecto/transfer");
      return transferHecto(env, sender, recipient, amountSat, memo, externalKey);
    }
  }
}

/** Send a registry token FROM a self-custody external party (KMS-signed). */
export async function sendTokenFromExternal(
  env: Env,
  senderKey: EncryptedKey,
  asset: RegistryAsset,
  senderParty: string,
  recipientParty: string,
  amountSat: number,
  memo: string
): Promise<{ updateId: string; transferInstructionCid: string | null }> {
  return transferRegistryAsset(env, asset, senderParty, recipientParty, amountSat, memo, senderKey);
}

/**
 * Full per-asset migration step: send `amountSat` of a registry asset from the
 * old custodial party to the new external party, then have the external party
 * KMS-accept the resulting TransferOffer so it settles into a Holding.
 */
export async function drainRegistryAsset(
  env: Env,
  key: EncryptedKey,
  oldParty: string,
  newParty: string,
  asset: RegistryAsset,
  amountSat: number,
  memo: string
): Promise<{ updateId: string; tiCid: string | null; accepted: unknown }> {
  const t = await transferRegistryAsset(env, asset, oldParty, newParty, amountSat, memo);
  // Some asset transfers don't surface the offer cid in the tx tree — fall
  // back to scanning the new party's incoming TransferOffers.
  let tiCid = t.transferInstructionCid;
  if (!tiCid) {
    const pending = await findIncomingTransferInstructions(env, newParty);
    tiCid = pending[0] ?? null;
  }
  let accepted: unknown = null;
  if (tiCid) {
    accepted = await externalAcceptRegistryTI(env, key, newParty, tiCid, asset);
  }
  return { updateId: t.updateId, tiCid, accepted };
}

/** Per-asset registry instrument getter + accept-context loader. */
async function assetContext(env: Env, asset: RegistryAsset, tiCid: string) {
  switch (asset) {
    case "cbtc": {
      const { getCbtcInstrument } = await import("../cbtc/registry");
      const { getAcceptContext } = await import("../cbtc/accept");
      const inst = await getCbtcInstrument(env);
      return getAcceptContext(env, tiCid, inst.instrumentId.admin);
    }
    case "ceth": {
      const { getCethInstrument } = await import("../ceth/registry");
      const { getAcceptContext } = await import("../ceth/accept");
      const inst = await getCethInstrument(env);
      return getAcceptContext(env, tiCid, inst.instrumentId.admin);
    }
    case "tusd": {
      const { getTusdInstrument } = await import("../tusd/registry");
      const { getAcceptContext } = await import("../tusd/accept");
      const inst = await getTusdInstrument(env);
      return getAcceptContext(env, tiCid, inst.instrumentId.admin);
    }
    case "hecto": {
      const { getHectoInstrument } = await import("../hecto/registry");
      const { getAcceptContext } = await import("../hecto/accept");
      const inst = await getHectoInstrument(env);
      return getAcceptContext(env, tiCid, inst.instrumentId.admin);
    }
  }
}

/**
 * External party accepts an incoming registry (token-standard) TransferOffer,
 * KMS-signed. Works for CBTC/cETH/tUSD/HECTO — all share the utility-registry
 * TransferOffer model and the TransferInstruction_Accept interface choice.
 */
export async function externalAcceptRegistryTI(
  env: Env,
  key: EncryptedKey,
  party: string,
  tiCid: string,
  asset: RegistryAsset = "cbtc"
): Promise<unknown> {
  const ctx = await assetContext(env, asset, tiCid);
  const tiDisclosed = (ctx.disclosedContracts as Array<{ contractId: string; templateId?: string }>).find((d) => d.contractId === tiCid);
  const tiTemplateId =
    tiDisclosed?.templateId ??
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
  const commands = [
    {
      ExerciseCommand: {
        templateId: tiTemplateId,
        contractId: tiCid,
        choice: "TransferInstruction_Accept",
        choiceArgument: { extraArgs: { context: ctx.choiceContextData, meta: { values: {} } } },
      },
    },
  ];
  return externalExercise(env, key, party, commands, ctx.disclosedContracts as unknown[]);
}

/* ────────── v2 (prediction participant) registry receive path ────────── *
 *  Mirrors v1's accept, but the prediction party lives on the v2 participant
 *  and is controlled by participant_admin (not a KMS external key). So we
 *  find incoming TransferInstructions on the v2 ledger and accept them via the
 *  regular ledger exercise() targeting v2 with subOverride=participant_admin.
 * ────────────────────────────────────────────────────────────────────── */

/** Incoming registry TransferInstructions/Offers for `party` on the V2 ledger. */
export async function findIncomingTIsV2(env: Env, party: string): Promise<string[]> {
  const { rawLedgerCall } = await import("../canton/ledger");
  const end = await rawLedgerCall<{ offset?: string }>(env, "/v2/state/ledger-end", "GET", undefined, "v2");
  const offset = Number(end.offset);
  if (!Number.isFinite(offset)) return [];
  // Bounded flats walk, NOT active-contracts: this Canton build silently
  // ignores InterfaceFilter, so the "filtered" ACS query is a wildcard and
  // 413s on the prediction party's >200 contracts — which made this return
  // nothing (zero TIs ever accepted) until 2026-08-18. Same fix pattern as
  // every other chain-walker.
  const WINDOW = 1000;
  const MAX_WINDOWS = 100;
  const pending = new Map<string, true>();
  const archived = new Set<string>();
  for (let i = 0; i < MAX_WINDOWS; i++) {
    const winEnd = offset - i * WINDOW;
    const winBegin = Math.max(0, winEnd - WINDOW);
    if (winEnd <= 0) break;
    let body: any[] = [];
    try {
      body = await rawLedgerCall<any[]>(
        env,
        "/v2/updates/flats",
        "POST",
        {
          beginExclusive: String(winBegin),
          endInclusive: String(winEnd),
          filter: {
            filtersByParty: {
              [party]: {
                cumulative: [{ WildcardFilter: { value: { includeCreatedEventBlob: false } } }],
              },
            },
          },
          verbose: false,
        },
        "v2"
      );
    } catch {
      continue;
    }
    for (const rec of Array.isArray(body) ? body : []) {
      const evs = rec?.update?.Transaction?.value?.events ?? [];
      for (const evRaw of evs) {
        const ev = evRaw as {
          CreatedEvent?: { contractId?: string; createArgument?: { transfer?: { receiver?: string } } };
          ArchivedEvent?: { contractId?: string };
        };
        const cv = ev.CreatedEvent?.contractId ? ev.CreatedEvent : (ev as any).CreatedEvent?.value;
        if (cv?.contractId && cv.createArgument?.transfer?.receiver === party) {
          pending.set(cv.contractId, true);
        }
        const av = ev.ArchivedEvent?.contractId ? ev.ArchivedEvent : (ev as any).ArchivedEvent?.value;
        if (av?.contractId) archived.add(av.contractId);
      }
    }
  }
  return [...pending.keys()].filter((c) => !archived.has(c));
}

/** Accept an incoming registry TI for a v2 party (e.g. slaymoney-prediction),
 *  as participant_admin on the v2 ledger. Non-KMS: the v2 validator holds the
 *  party's authority, so a plain exercise() with actAs=[party] suffices. */
export async function v2AcceptRegistryTI(
  env: Env,
  party: string,
  tiCid: string,
  asset: RegistryAsset = "cbtc"
): Promise<unknown> {
  const ctx = await assetContext(env, asset, tiCid);
  const tiDisclosed = (ctx.disclosedContracts as Array<{ contractId: string; templateId?: string }>).find((d) => d.contractId === tiCid);
  const tiTemplateStr =
    tiDisclosed?.templateId ??
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
  // "#pkg:Module.Path:Entity" → structured TemplateId for tidToString.
  const [packageId, moduleName, entityName] = tiTemplateStr.split(":");
  const { exercise } = await import("../canton/ledger");
  return exercise(
    env,
    [party],
    { packageId, moduleName, entityName },
    tiCid,
    "TransferInstruction_Accept",
    { extraArgs: { context: ctx.choiceContextData, meta: { values: {} } } },
    { target: "v2", subOverride: "participant_admin", disclosedContracts: ctx.disclosedContracts as any }
  );
}
