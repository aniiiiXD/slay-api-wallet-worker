/**
 * cETH transfer — Splice Token Standard `TransferFactory_Transfer` exercise.
 *
 * Mirrors ceth's CBTC sibling. The pattern:
 *
 *   1. Build the Transfer payload (sender, receiver, amount, instrumentId,
 *      timestamps, input holding cids, meta).
 *   2. POST to the registry transfer-factory endpoint. Returns:
 *        - factoryId         — the TransferFactory contract id to exercise
 *        - choiceContext     — the values map the choice arg needs
 *        - disclosedContracts — what to include as disclosures
 *   3. Exercise `TransferFactory_Transfer` on the factoryId, including
 *      the choiceContext from the registry and the disclosed contracts.
 *   4. actAs = [senderParty] only. (Receiver consent comes via the
 *      TransferInstruction the choice creates downstream — the
 *      accept-cron path picks it up.)
 *
 * AUTH: Bearer token = onrails cETH Keycloak access token (see
 * ./keycloak.ts). Our participant must trust the issuer as a JWT issuer.
 *
 * METADATA: the Splice Token Standard uses well-known keys in `meta.values`:
 *   - splice.lfdecentralizedtrust.org/reason     → user-visible memo
 *   - splice.lfdecentralizedtrust.org/reference  → client idempotency id
 */

import type { Env } from "../env";
import { LedgerCallError } from "../canton/ledger";
import type { CethTransferResult, InstrumentId } from "./types";
import { getCethInstrument } from "./registry";
import { discoverOperatorHoldingsViaLedger } from "../canton/operator-holdings";
import { getCethKeycloakToken, invalidateKeycloakToken } from "./keycloak";
import { createDb } from "../db";
import {
  getCachedHolding,
  setCachedHolding,
  invalidateCachedHolding,
} from "./holding-cache";
import { maybeTrimDisclosed } from "../cbtc/disclosed-trim";

/* ────────── Constants from the Splice Token Standard ────────── */

const META_REASON_KEY = "splice.lfdecentralizedtrust.org/reason";
const META_REFERENCE_KEY = "splice.lfdecentralizedtrust.org/reference";
const EXECUTE_BEFORE_HOURS = 168; // 7 days

/* ────────── Holdings pre-pick ────────── *
 *  The registry rejects `inputHoldingCids: []` with "No holdings         *
 *  provided" — it expects us to pre-pick the contracts the factory may  *
 *  consume. We list the sender's cETH Holdings, then pass ALL of them   *
 *  in. The factory picks which to consume and leaves change in a new    *
 *  Holding owned by the sender.                                          *
 *                                                                        *
 *  ── 200-element cap workaround ──                                     *
 *  Canton 3.5.1's JSON v2 API hardcodes a 200-element response cap on   *
 *  /v2/state/active-contracts. The operator party crosses that easily.  *
 *  The REAL workaround for the operator is the ceth_holding_cache table *
 *  (see holding-cache.ts). Treasury hits the cache; user parties (which *
 *  have <200 active contracts each) work fine via wildcard.             *
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Public, cache-bypassing variant of listSenderCethHoldings. Used by the
 * merge-fat-holdings admin endpoint to enumerate ALL active cETH Holdings
 * for a party (the cache only holds the latest senderChange cid — useless
 * for spotting the 30+ Holdings stuck on a fat-receiver bot).
 *
 * Returns the raw cid list — caller can count + decide whether to
 * consolidate. Same participant query as the internal version, just
 * without the cache fast-path.
 */
export async function listAllHoldingsForPartyFresh(
  env: Env,
  party: string
): Promise<string[]> {
  return listSenderCethHoldingsImpl(env, party, /* skipCache */ true);
}

async function listSenderCethHoldings(
  env: Env,
  senderParty: string,
  resolvedAdmin: string,
  minAmountSat?: number
): Promise<string[]> {
  void resolvedAdmin;
  return listSenderCethHoldingsImpl(env, senderParty, /* skipCache */ false, minAmountSat);
}

async function listSenderCethHoldingsImpl(
  env: Env,
  senderParty: string,
  skipCache: boolean,
  minAmountSat?: number
): Promise<string[]> {
  // ── Cache fast-path (gated on !skipCache) ──
  // Plan B for the 200-element cap: if the ceth_holding_cache table
  // has a cid for this sender, use it directly and skip the participant
  // query entirely. The cache is updated after every successful
  // transferCeth with the new "change Holding" cid, so it stays current
  // across the chain of self-referential UTXO consumption.
  //
  // For the operator party this is the ONLY path that works — its
  // contract count is permanently above 200 and the participant query
  // always 413s. For user parties (which have <10 contracts each) we
  // could fall through to the participant query, but using the cache
  // uniformly keeps the code path consistent.
  //
  // skipCache=true skips this short-circuit so callers that need the
  // FULL active-Holding set (merge-fat-holdings consolidation) actually
  // see every cid, not just the cached one.
  if (!skipCache) {
    try {
      const db = createDb(env.DATABASE_URL);
      const cached = await getCachedHolding(db, senderParty);
      if (cached && (minAmountSat === undefined || cached.amountRaw >= minAmountSat)) {
        console.log(
          `[ceth.transfer] listSenderCethHoldings cache HIT sender=${senderParty.slice(0, 30)} cid=${cached.holdingCid.slice(0, 24)}… amount=${cached.amountRaw}`
        );
        return [cached.holdingCid];
      }
      console.log(
        `[ceth.transfer] listSenderCethHoldings cache ${cached ? "INSUFFICIENT" : "MISS"} sender=${senderParty.slice(0, 30)} need=${minAmountSat ?? "?"} — walking ledger`
      );
    } catch (err) {
      // DB failures shouldn't break transfers — fall through to participant.
      console.warn(
        `[ceth.transfer] holding-cache read failed sender=${senderParty.slice(0, 30)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // ── End cache fast-path ──

  const operatorParty = (env.SPLICE_VALIDATOR_PARTY_ID ?? "").trim();
  if (operatorParty && senderParty === operatorParty) {
    const inst = await getCethInstrument(env);
    const cids = await discoverOperatorHoldingsViaLedger(
      env,
      senderParty,
      inst.instrumentId.id,
      inst.decimals ?? 10,
      minAmountSat ?? Number.MAX_SAFE_INTEGER
    );
    if (cids.length === 0) {
      throw new LedgerCallError(
        500,
        `Operator ${senderParty.slice(0, 32)}… has no spendable cETH Holdings (ledger walk).`
      );
    }
    return cids;
  }

  const ledgerHost = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  const ledgerToken = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!ledgerToken) {
    throw new LedgerCallError(
      500,
      "JSON_LEDGER_ADMIN_TOKEN not set — required to enumerate the sender's cETH Holdings."
    );
  }

  // Resolve the cETH Holding template + interface ids. Both are
  // OPTIONAL — Canton 3.5.1 silently ignores TemplateFilter and
  // InterfaceFilter in our setup, so they don't actually narrow the
  // response server-side regardless of whether we provide them. We
  // still include them in the filter array on the off-chance a future
  // participant version starts honoring them.
  //
  // The REAL workaround for the 200-element cap is the
  // ceth_holding_cache table (see holding-cache.ts). Treasury hits the
  // cache; user parties (which have <200 active contracts each) work
  // fine via wildcard, no filter needed.
  const instrument = await getCethInstrument(env);
  const packageId =
    instrument.packageId ?? env.CETH_HOLDING_TEMPLATE_PACKAGE_ID ?? null;
  const cethHoldingTemplateId = packageId
    ? `${packageId}:Utility.Registry.Holding:Holding`
    : null;
  const cethHoldingInterfaceId = env.CETH_HOLDING_INTERFACE_PACKAGE_ID
    ? `${env.CETH_HOLDING_INTERFACE_PACKAGE_ID}:Splice.Api.Token.HoldingV1:Holding`
    : null;

  // Current ledger end → activeAtOffset
  const endRes = await fetch(`${ledgerHost}/v2/state/ledger-end`, {
    headers: {
      Authorization: `Bearer ${ledgerToken}`,
      accept: "application/json",
    },
  });
  if (!endRes.ok) {
    throw new LedgerCallError(
      endRes.status,
      `Couldn't read ledger end while enumerating sender holdings.`
    );
  }
  const endBody = (await endRes.json()) as { offset?: string };
  const activeAtOffset = endBody.offset;
  if (!activeAtOffset) {
    throw new LedgerCallError(500, "ledger-end returned no offset.");
  }

  // Server-side filter array. We try Template/Interface filters when
  // we have the ids (in case a future participant version honors them),
  // and ALWAYS include a WildcardFilter as the safe-baseline so the
  // request never errors on a missing-id config issue.
  //
  // For parties with >200 contracts (treasury), this whole code path
  // is skipped — they hit the ceth_holding_cache fast-path above.
  // Correct v2 key is `identifierFilter` (not `identifier`, which Canton
  // silently ignores — leaking every token holding into this instrument's
  // factory call → "Given holdings are invalid"). Interface view populated so
  // we can filter client-side by instrument.
  const HOLDING_IFACE =
    "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
  const wantInstrument = instrument.instrumentId.id;
  const filterIdentifiers: Array<{ identifierFilter: Record<string, unknown> }> = [
    {
      identifierFilter: {
        InterfaceFilter: {
          value: {
            interfaceId: HOLDING_IFACE,
            includeInterfaceView: true,
            includeCreatedEventBlob: false,
          },
        },
      },
    },
  ];
  void cethHoldingTemplateId;
  void cethHoldingInterfaceId;

  const body = {
    filter: {
      filtersByParty: {
        [senderParty]: {
          cumulative: filterIdentifiers,
        },
      },
    },
    verbose: false,
    activeAtOffset,
  };

  const res = await fetch(`${ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ledgerToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const templateLabel = cethHoldingTemplateId
    ? cethHoldingTemplateId.slice(0, 40) + "…"
    : "<wildcard>";
  if (!res.ok) {
    const errBody = await res.text().catch(() => "<read failed>");
    console.error(
      `[ceth.transfer] listSenderCethHoldings ${res.status} from ${ledgerHost} ` +
        `(sender=${senderParty.slice(0, 30)}, template=${templateLabel}): ${errBody.slice(0, 500)}`
    );
    throw new LedgerCallError(
      res.status,
      `Couldn't list sender's active contracts (${res.status}).`
    );
  }

  // Response may be JSON array or NDJSON — handle both.
  const text = await res.text();
  console.log(
    `[ceth.transfer] listSenderCethHoldings ok sender=${senderParty.slice(0, 30)} ` +
      `bytes=${text.length} template=${templateLabel}`
  );

  let entries: Array<unknown> = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    entries = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  const cids: string[] = [];
  for (const entry of entries) {
    const ev = (
      entry as {
        contractEntry?: {
          JsActiveContract?: {
            createdEvent?: {
              contractId: string;
              templateId: string;
              interfaceViews?: Array<{
                viewValue?: {
                  owner?: string;
                  amount?: string | number;
                  instrumentId?: { admin?: string; id?: string };
                  lock?: unknown;
                };
              }>;
              createArgument?: {
                owner?: string;
                amount?: string | number;
                instrumentId?: { admin?: string; id?: string };
                lock?: unknown;
              };
            };
          };
        };
      }
    ).contractEntry?.JsActiveContract?.createdEvent;
    if (!ev) continue;

    const view = ev.interfaceViews?.[0]?.viewValue;
    const arg = view ?? ev.createArgument;
    if (!arg) continue;
    if (arg.owner !== senderParty) continue;
    if (arg.lock != null) continue;
    if ((arg.instrumentId?.id ?? null) !== wantInstrument) continue;

    cids.push(ev.contractId);
  }
  return cids;
}

/* ────────── Wire shapes ────────── */

type TransferPayload = {
  sender: string;
  receiver: string;
  /** Decimal string — precision matches the live `decimals` from the
   *  registry (cETH ships at decimals=10). */
  amount: string;
  instrumentId: InstrumentId;
  /** ISO-8601 UTC. Daml Time field. */
  requestedAt: string;
  /** ISO-8601 UTC. Choice fails after this. */
  executeBefore: string;
  /** Sender's cETH holding cids the factory may consume.
   *  EMPTY ARRAY (`[]`) = factory picks for us. `null` here makes
   *  the registry parser throw "Expected [ but was null" — the
   *  auto-pick sentinel is the empty array, not null. */
  inputHoldingCids: string[];
  meta: { values: Record<string, string> };
};

type DisclosedContract = {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
};

type ChoiceContext = {
  choiceContextData: { values: Record<string, unknown> };
  disclosedContracts: DisclosedContract[];
};

type RegistryFactoryResponse = {
  factoryId: string;
  transferKind: string;
  choiceContext: ChoiceContext;
};

/* ────────── Registry pre-flight ────────── */

async function getTransferFactory(
  env: Env,
  transfer: TransferPayload,
  resolvedAdmin: string
): Promise<RegistryFactoryResponse> {
  const registryUrl = env.CETH_REGISTRY_URL!.replace(/\/$/, "");
  // Use the RESOLVED admin from getCethInstrument(), not the raw env
  // var — handles admin-party rotation without env redeploy. The env
  // var is just the bootstrap hint; the registry's own metadata.admin
  // is the live source of truth.
  const adminParty = resolvedAdmin;

  // POST /api/token-standard/v0/registrars/{admin}/registry/transfer-instruction/v1/transfer-factory
  const url =
    `${registryUrl}/api/token-standard/v0/registrars/` +
    `${encodeURIComponent(adminParty)}/registry/transfer-instruction/v1/transfer-factory`;

  const body = {
    choiceArguments: {
      expectedAdmin: adminParty,
      transfer,
      extraArgs: {
        context: { values: {} as Record<string, unknown> },
        meta: { values: {} as Record<string, string> },
      },
    },
    excludeDebugFields: true,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LedgerCallError(
      res.status,
      `cETH transfer-factory registry rejected: ${res.status} ${text.slice(0, 240)}`
    );
  }
  return (await res.json()) as RegistryFactoryResponse;
}

/* ────────── Ledger submit ────────── */

async function submitTransferCommand(
  env: Env,
  _accessToken: string,
  senderParty: string,
  factoryResp: RegistryFactoryResponse,
  transfer: TransferPayload,
  commandId: string,
  resolvedAdmin: string,
  externalKey?: import("../kms/keys").EncryptedKey
): Promise<{
  updateId: string;
  createdEvents: Array<{
    contractId: string;
    templateId?: string;
    owner?: string;
    amountDecimal?: string;
  }>;
}> {
  const ledgerHost = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  if (!ledgerHost) {
    throw new LedgerCallError(
      500,
      "JSON_API_URL not set. The cETH transfer needs the same ledger host as CC."
    );
  }
  // Same reason as ceth/accept.ts: the participant rejects the Keycloak
  // bearer with INVALID_TOKEN ("missing user-id"). Use the local
  // participant_admin JWT (wildcard auth) for the submit. Keycloak is
  // for registry-side calls only.
  const ledgerToken = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!ledgerToken) {
    throw new LedgerCallError(
      500,
      "JSON_LEDGER_ADMIN_TOKEN not set — required for the participant submit leg."
    );
  }

  // `TransferFactory_Transfer` is an INTERFACE choice from
  // splice-api-token-transfer-instruction-v1. The concrete factory
  // template (TransferPreapproval for "direct" mode, AllocationFactory
  // for "offer" mode) implements that interface. We MUST submit using
  // the interface templateId — submitting with the concrete templateId
  // makes the participant look for a literal `TransferFactory_Transfer`
  // choice on the concrete template, which doesn't exist.
  //
  // The interface templateId is package-name resolved (the leading `#`
  // tells the participant "highest vetted version of this package
  // name"), so it works regardless of which version of
  // splice-api-token-transfer-instruction-v1 is installed. Shared across
  // every Token Standard asset — same for CBTC and cETH.
  const interfaceTemplateId =
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";

  // Optionally trim disclosedContracts to the subset actually referenced
  // by the choice's context (plus the factory cid itself, which the
  // participant needs to interpret the ExerciseCommand). Off by default;
  // CBTC_TRIM_DISCLOSED=1 flips it on (the trim helper is generic and
  // shared with CBTC). Dry-run logs the would-be savings regardless.
  const disclosedContracts = maybeTrimDisclosed(
    env,
    "transfer",
    factoryResp.choiceContext.disclosedContracts,
    factoryResp.choiceContext.choiceContextData,
    [factoryResp.factoryId]
  );

  const commandBody = {
    commands: [
      {
        ExerciseCommand: {
          templateId: interfaceTemplateId,
          contractId: factoryResp.factoryId,
          choice: "TransferFactory_Transfer",
          choiceArgument: {
            // Use the live-resolved admin (see registry.ts drift
            // handling) — env.CETH_ADMIN_PARTY may be stale if the
            // issuer rotated and the env wasn't redeployed yet.
            expectedAdmin: resolvedAdmin,
            transfer,
            extraArgs: {
              // Critical: use the context the registry gave us, not the
              // empty stub we sent in the pre-flight. The registry's
              // choiceContextData carries the disclosures the factory
              // needs.
              context: factoryResp.choiceContext.choiceContextData,
              meta: { values: {} as Record<string, string> },
            },
          },
        },
      },
    ],
    commandId,
    // The wildcard-auth admin token's implicit user. Daml 3.x requires
    // an explicit userId when the JWT doesn't carry a user-id claim.
    userId: "participant_admin",
    actAs: [senderParty],
    disclosedContracts,
  };

  const url = `${ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`;

  // Self-custody EXTERNAL sender: operator cannot actAs it, so KMS-sign the
  // same TransferFactory_Transfer via interactive submission.
  if (externalKey) {
    const { externalExercise } = await import("../kms/interactive");
    const r = await externalExercise(env, externalKey, senderParty, commandBody.commands, disclosedContracts as unknown[]);
    const created = r.events
      .filter((e) => e.kind === "created")
      .map((e) => ({ contractId: e.contractId, templateId: e.templateId, owner: (e.payload as any)?.owner, amountDecimal: (e.payload as any)?.amount != null ? String((e.payload as any).amount) : undefined }));
    return { updateId: r.updateId ?? "", createdEvents: created };
  }

  if (env.TRAFFIC_DEBUG === "1") {
    const bodyBytes = JSON.stringify(commandBody).length;
    const discBytes = disclosedContracts.reduce(
      (a, d) => a + ((d as { createdEventBlob?: string }).createdEventBlob?.length ?? 0),
      0
    );
    console.log(
      `[traffic] choice=cETH:TransferFactory_Transfer bodyBytes=${bodyBytes} disclosedBytes=${discBytes} disclosedCount=${disclosedContracts.length}`
    );
  }

  // ── Sequencer-409 retry loop ────────────────────────────────────
  //
  // Canton mainnet sequencer 409s with SEQUENCER_REQUEST_FAILED /
  // RequestRefused under sustained backpressure. The command never
  // reached consensus, so retrying with the SAME commandId is safe
  // (and actively desirable — same commandId means dedup if somehow
  // the first attempt DID land but the response was lost).
  //
  // Bounded: 3 attempts total with linear backoff (0s, 1s, 2s).
  // Other failures (DAML_FAILURE, CONTRACT_NOT_FOUND, 5xx) bail
  // immediately — those aren't transient.
  const MAX_ATTEMPTS = 3;
  let res: Response | null = null;
  let lastErrText = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${ledgerToken}`,
      },
      body: JSON.stringify(commandBody),
    });

    if (res.ok) break;

    lastErrText = await res.text().catch(() => "");
    const isSequencerCongestion =
      res.status === 409 &&
      /SEQUENCER_REQUEST_FAILED|RequestRefused|RequestQueueFull|Failed to send command/i.test(
        lastErrText
      );
    if (!isSequencerCongestion) break;
    if (attempt === MAX_ATTEMPTS) break;

    // Linear backoff (1s, 2s) — short because the cron caller fires
    // many of these in parallel, and we want to recover quickly when
    // the sequencer window opens.
    const sleepMs = 1000 * attempt;
    console.log(
      `[ceth.transfer] sequencer 409 attempt ${attempt}/${MAX_ATTEMPTS}, retry in ${sleepMs}ms — cid=${commandId.slice(0, 12)}…`
    );
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  if (!res || !res.ok) {
    throw new LedgerCallError(
      res?.status ?? 0,
      `POST /v2/commands/submit-and-wait-for-transaction-tree → ${res?.status ?? "no-response"}: ${lastErrText.slice(0, 300)}`
    );
  }

  const result = (await res.json()) as {
    transactionTree: {
      updateId: string;
      eventsById: Record<string, unknown>;
    };
  };

  // Pull the created Holding events (receiver's new holding, sender's
  // change). Each created event has its contractId and templateId; we
  // pick out those whose template name ends in :Holding. We also
  // capture the create argument's `amount` field — Daml Decimal arrives
  // as a string — so callers can update the cache with the REAL
  // change amount instead of approximating via subtraction (which
  // misses any per-transfer fee).
  const created: Array<{
    contractId: string;
    templateId?: string;
    owner?: string;
    amountDecimal?: string;
  }> = [];
  for (const ev of Object.values(result.transactionTree?.eventsById ?? {})) {
    const e = ev as {
      CreatedTreeEvent?: {
        value: {
          contractId: string;
          templateId: string;
          createArgument: { owner?: string; amount?: string | number };
        };
      };
    };
    if (e.CreatedTreeEvent?.value) {
      const v = e.CreatedTreeEvent.value;
      const arg = v.createArgument ?? {};
      created.push({
        contractId: v.contractId,
        templateId: v.templateId,
        owner: arg.owner,
        amountDecimal: arg.amount != null ? String(arg.amount) : undefined,
      });
    }
  }
  return {
    updateId: result.transactionTree.updateId,
    createdEvents: created,
  };
}

/* ────────── Public API ────────── */

export async function transferCeth(
  env: Env,
  senderParty: string,
  recipientParty: string,
  amountSat: number,
  memo: string,
  externalKey?: import("../kms/keys").EncryptedKey
): Promise<CethTransferResult> {
  // Auto-route: if the sender is a self-custody external party, KMS-sign.
  externalKey = await (await import("../kms/router")).maybeExternalKey(env, senderParty, externalKey);
  // ── Validation
  if (env.CETH_ENABLED !== "1" && env.CETH_ENABLED !== "true") {
    throw new LedgerCallError(
      503,
      "cETH is not enabled in this environment. Set CETH_ENABLED=1 once credentials + participant config are in place."
    );
  }
  if (amountSat <= 0) {
    throw new LedgerCallError(400, "cETH transfer amount must be positive.");
  }
  if (senderParty === recipientParty) {
    throw new LedgerCallError(400, "Sender and recipient are the same party.");
  }
  if (!env.CETH_ADMIN_PARTY) {
    throw new LedgerCallError(500, "CETH_ADMIN_PARTY not set.");
  }

  // ── Resolve instrument + auth (both cached in their respective modules).
  // The resolved instrument is the SOURCE OF TRUTH for admin party id —
  // env.CETH_ADMIN_PARTY is just the bootstrap hint to find the right
  // registrar, the registry's own metadata.admin tells us where to
  // actually route the transfer-factory call and the expectedAdmin
  // claim. The decimals field is ALSO live-resolved — cETH ships at
  // decimals=10, and a future rotation could change it.
  const instrument = await getCethInstrument(env);
  const resolvedAdmin = instrument.instrumentId.admin;
  const decimals = instrument.decimals ?? 8;
  const conversionFactor = 10 ** decimals;
  const accessToken = await getCethKeycloakToken(env);

  // ── Pre-pick sender's cETH holdings. The registry rejects empty
  //    arrays with "No holdings provided" — they want us to list the
  //    candidate UTXOs the factory may consume.
  const inputHoldingCids = await listSenderCethHoldings(
    env,
    senderParty,
    resolvedAdmin,
    amountSat
  );
  if (inputHoldingCids.length === 0) {
    throw new LedgerCallError(
      400,
      `Sender ${senderParty.slice(0, 32)}… has no spendable cETH Holdings.`
    );
  }

  // ── Build the Transfer payload
  // `amountSat` here is our internal "smallest unit" count, computed
  // against the live decimals. Format the decimal string to the same
  // precision the registry expects.
  const amountDecimal = (amountSat / conversionFactor).toFixed(decimals);
  // Using a stable "now" computed once per call so all timestamps are
  // mutually consistent and the executeBefore deadline is exactly +168h.
  const nowMs = Date.now();
  const requestedAt = new Date(nowMs).toISOString();
  const executeBefore = new Date(
    nowMs + EXECUTE_BEFORE_HOURS * 60 * 60 * 1000
  ).toISOString();
  const commandId = crypto.randomUUID();

  const transfer: TransferPayload = {
    sender: senderParty,
    receiver: recipientParty,
    amount: amountDecimal,
    instrumentId: instrument.instrumentId,
    requestedAt,
    executeBefore,
    // Pre-picked from the sender's active Holdings just above. We
    // pass ALL cETH Holdings owned by the sender; the factory picks
    // which to consume and leaves change in a new Holding.
    inputHoldingCids,
    meta: {
      values: {
        [META_REASON_KEY]: memo ?? "",
        // A stable reference per command for idempotency. We use the
        // same UUID as the commandId so the chain history is joinable
        // on a single id.
        [META_REFERENCE_KEY]: commandId,
      },
    },
  };

  // ── Registry pre-flight: get factory cid + context + disclosures
  let factoryResp: RegistryFactoryResponse;
  try {
    factoryResp = await getTransferFactory(env, transfer, resolvedAdmin);
  } catch (err) {
    if (err instanceof LedgerCallError && err.status === 401) {
      // Stale Keycloak token? Force re-mint and retry once.
      await invalidateKeycloakToken(env);
      throw new LedgerCallError(
        401,
        "Registry rejected auth; Keycloak token invalidated. Retry the request."
      );
    }
    // Stale-cache recovery — the registry pre-flight rejects when any of
    // the `inputHoldingCids` is archived ("Given holdings are invalid").
    // The cached cid is poisoned; invalidate so the next call can
    // re-seed from a fresh inbound cETH.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Given holdings are invalid") ||
      msg.includes("No holdings provided") ||
      msg.includes("holding cids are not active")
    ) {
      try {
        const db = createDb(env.DATABASE_URL);
        await invalidateCachedHolding(db, senderParty);
        console.warn(
          `[ceth.transfer] cache INVALIDATE (registry stale-cid) sender=${senderParty.slice(0, 30)} ` +
            `— registry rejected pre-flight: "${msg.slice(0, 120)}". Cache cleared.`
        );
      } catch (cacheErr) {
        console.error(
          `[ceth.transfer] failed to invalidate stale cache sender=${senderParty.slice(0, 30)}: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`
        );
      }
    }
    throw err;
  }

  // ── Exercise TransferFactory_Transfer
  let result: Awaited<ReturnType<typeof submitTransferCommand>>;
  try {
    result = await submitTransferCommand(
      env,
      accessToken,
      senderParty,
      factoryResp,
      transfer,
      commandId,
      resolvedAdmin,
      externalKey,
    );
  } catch (err) {
    if (err instanceof LedgerCallError && err.status === 401) {
      await invalidateKeycloakToken(env);
      throw new LedgerCallError(
        401,
        "Ledger rejected auth; Keycloak token invalidated. Retry the request."
      );
    }
    // ── Stale-cache recovery ──
    // If the chain rejected because the input Holding cid is invalid
    // (consumed by an earlier tx) or because its on-chain amount is
    // smaller than what we asked for (fee drift), the cached cid for
    // this sender is poisoned. Invalidate so the next call re-seeds via
    // accept-cron (when an inbound cETH lands) OR fails fast with
    // cache-miss + participant-query 413, surfacing the need for ops to
    // top the operator up.
    const msg = err instanceof Error ? err.message : String(err);
    const isStaleCid =
      msg.includes("collapseAction") ||
      msg.includes("amount must be positive") ||
      msg.includes("CONTRACT_NOT_FOUND") ||
      msg.includes("LOCAL_VERDICT_INACTIVE_CONTRACTS") ||
      msg.includes("not exceed total holding amount");
    if (isStaleCid) {
      try {
        const db = createDb(env.DATABASE_URL);
        await invalidateCachedHolding(db, senderParty);
        console.warn(
          `[ceth.transfer] cache INVALIDATE (stale cid recovery) sender=${senderParty.slice(0, 30)} ` +
            `— chain rejected with "${msg.slice(0, 800)}". Cache cleared; next call needs accept-cron seed or manual /seed-holding-cid.`
        );
      } catch (cacheErr) {
        console.error(
          `[ceth.transfer] failed to invalidate stale cache sender=${senderParty.slice(0, 30)}: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`
        );
      }
    }
    throw err;
  }

  // ── Pick out the result contracts. Two possible factory shapes:
  //   (a) Direct Holding path — receiver's Holding is created in this
  //       same transaction. transferInstructionCid stays null.
  //   (b) Two-phase TransferInstruction — receiver's cETH sits in a
  //       TransferInstruction contract until receiver exercises Accept.
  //       receiverHoldingCid stays null; the cron / manual route picks
  //       it up later via accept.ts.
  //
  // We surface BOTH cids regardless so callers can branch on which
  // path the factory took. The factory defaults to (b); we keep the
  // (a) branch alive because the Splice Token Standard allows direct
  // transfers and a future upgrade may flip to that.
  let receiverHoldingCid: string | null = null;
  let senderChangeCid: string | null = null;
  let senderChangeAmountDecimal: string | null = null;
  let transferInstructionCid: string | null = null;
  for (const ev of result.createdEvents) {
    if (!ev.templateId) continue;
    if (ev.templateId.includes(":TransferInstruction")) {
      // The TransferInstruction's "receiver" lives in its `transfer`
      // sub-payload, not directly on the event. We don't bother
      // matching here — there should only ever be ONE TI per
      // submission. If there are more, last wins; the accept cron
      // dedups by cid anyway.
      transferInstructionCid = ev.contractId;
      continue;
    }
    if (!ev.templateId.includes(":Holding")) continue;
    if (ev.owner === recipientParty) receiverHoldingCid = ev.contractId;
    else if (ev.owner === senderParty) {
      senderChangeCid = ev.contractId;
      senderChangeAmountDecimal = ev.amountDecimal ?? null;
    }
  }

  // ── Refresh the sender's cached cid ──
  // Plan B for the 200-element active-contracts cap. Read the REAL
  // change amount out of the chain response (createArgument.amount on
  // the sender's new Holding event) so the cache stays accurate even
  // when a per-transfer fee is deducted.
  //
  // If senderChangeCid is null (entire input went to a
  // TransferInstruction with no change), INVALIDATE so next call
  // re-seeds rather than reusing a dead cid.
  try {
    const db = createDb(env.DATABASE_URL);
    if (senderChangeCid) {
      let newAmountRaw = -1;
      if (senderChangeAmountDecimal != null) {
        const decimal = Number(senderChangeAmountDecimal);
        if (Number.isFinite(decimal)) {
          newAmountRaw = Math.round(decimal * conversionFactor);
        }
      }
      await setCachedHolding(db, senderParty, senderChangeCid, newAmountRaw);
      console.log(
        `[ceth.transfer] cache UPDATE sender=${senderParty.slice(0, 30)} ` +
          `cid=${senderChangeCid.slice(0, 24)}… amount=${newAmountRaw} ` +
          `(raw from chain: ${senderChangeAmountDecimal ?? "unknown"})`
      );
    } else {
      await invalidateCachedHolding(db, senderParty);
      console.warn(
        `[ceth.transfer] cache INVALIDATE sender=${senderParty.slice(0, 30)} ` +
          `— no senderChangeCid in transaction tree; next call must re-seed`
      );
    }
  } catch (err) {
    console.error(
      `[ceth.transfer] cache update failed sender=${senderParty.slice(0, 30)}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    updateId: result.updateId,
    receiverHoldingCid,
    senderChangeCid,
    transferInstructionCid,
  };
}
