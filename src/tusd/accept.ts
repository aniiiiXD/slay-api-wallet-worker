/**
 * tUSD TransferInstruction Accept — receiver-side completion of a
 * two-phase tUSD transfer.
 *
 * Why this exists: TransferFactory_Transfer creates a
 * `TransferInstruction` contract on chain rather than a direct Holding.
 * The tUSD doesn't actually land in the receiver's wallet until the
 * receiver exercises `TransferInstruction_Accept` (the Splice Token
 * Standard's two-phase pattern — sender proposes, receiver accepts).
 *
 * Without this Accept call, the funds sit in an unaccepted contract
 * forever and never become a Holding.
 *
 * Flow:
 *   1. Registry pre-flight — POST to the
 *      transfer-instruction/v1/accept-choice-context endpoint with the
 *      TI's contract id. Returns the choice context + disclosed
 *      contracts the receiver needs to interpret the choice.
 *   2. Exercise `TransferInstruction_Accept` on the TI cid, actAs the
 *      receiver party, including the registry's disclosures.
 *   3. Parse the new Holding from the transaction tree.
 *   4. Caller (cron or admin route) writes the Postgres credit + tx row.
 *
 * AUTH: Same Keycloak bearer used for sends (see ./keycloak.ts).
 */

import type { Env } from "../env";
import { LedgerCallError } from "../canton/ledger";
import { getTusdInstrument } from "./registry";
import { getTusdKeycloakToken, invalidateKeycloakToken } from "./keycloak";
import { maybeTrimDisclosed } from "../cbtc/disclosed-trim";

/* ────────── Wire shapes ────────── */

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

/**
 * The accept-context endpoint returns the ChoiceContext FLAT — no
 * `choiceContext` wrapper, the `choiceContextData` and
 * `disclosedContracts` fields sit at the top level of the body. The
 * Splice Token Standard spec shows a wrapper; reality differs. This
 * alias makes the flatness explicit at the type layer.
 */
type AcceptContextResponse = ChoiceContext;

/* ────────── Public result shape ────────── */

export type AcceptResult = {
  /** Chain update id — proof of settlement. */
  updateId: string;
  /** Contract id of the new Holding created by the Accept. */
  holdingCid: string | null;
  /** Receiver party (owner of the new Holding) — echoed back for caller. */
  ownerParty: string;
  /** Amount in smallest unit extracted from the new Holding payload.
   *  Null if the template's amount field isn't in the create argument
   *  (defensive). */
  amountSat: number | null;
};

/* ────────── Registry pre-flight ────────── */

/**
 * Ask the registry for the disclosed contracts and context blob needed
 * to exercise `TransferInstruction_Accept` on the given TI cid.
 *
 * Endpoint (per Splice Token Standard):
 *   POST {registryUrl}/api/token-standard/v0/registrars/{admin}/registry/
 *        transfer-instruction/v1/{cid}/choice-contexts/accept
 *
 * Returns choiceContextData + disclosedContracts (current TransferFactory,
 * latest AmuletRules / open-mining-round, whatever else the choice body
 * inspects).
 */
export async function getAcceptContext(
  env: Env,
  transferInstructionCid: string,
  resolvedAdmin: string
): Promise<AcceptContextResponse> {
  const registryUrl = env.TUSD_REGISTRY_URL!.replace(/\/$/, "");
  const url =
    `${registryUrl}/api/token-standard/v0/registrars/` +
    `${encodeURIComponent(resolvedAdmin)}/registry/transfer-instruction/v1/` +
    `${encodeURIComponent(transferInstructionCid)}/choice-contexts/accept`;

  // Splice convention: pre-flights are reads, no auth required. But
  // some deployments gate them; pass the Keycloak token defensively
  // when we have one cached (cheap).
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    // Empty body — endpoint reads from URL path only.
    body: "{}",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LedgerCallError(
      res.status,
      `tUSD accept-context registry rejected: ${res.status} ${text.slice(0, 240)}`
    );
  }
  return (await res.json()) as AcceptContextResponse;
}

/* ────────── Ledger submit ────────── */

async function submitAcceptCommand(
  env: Env,
  _accessToken: string,
  receiverParty: string,
  transferInstructionCid: string,
  context: ChoiceContext
): Promise<{
  updateId: string;
  createdEvents: Array<{
    contractId: string;
    templateId?: string;
    createArgument: Record<string, unknown>;
  }>;
}> {
  const ledgerHost = (env.JSON_API_URL ?? "").replace(/\/$/, "");
  if (!ledgerHost) {
    throw new LedgerCallError(500, "JSON_API_URL not set.");
  }
  // The ledger submit goes against OUR participant, not the registry.
  // Use the local participant_admin JWT (wildcard auth → implicit actAs
  // over every hosted party) rather than the Keycloak bearer. The
  // issuer's JWT doesn't carry the `user-id` claim our participant's
  // auth-services entry expects, hence the INVALID_TOKEN errors.
  // Keycloak stays for the registry pre-flight.
  const ledgerToken = env.JSON_LEDGER_ADMIN_TOKEN ?? "";
  if (!ledgerToken) {
    throw new LedgerCallError(
      500,
      "JSON_LEDGER_ADMIN_TOKEN not set — required for the participant submit leg."
    );
  }

  // Find the TI's template id from the disclosed contracts — the TI
  // itself MUST be among them (the choice exercise references its own
  // contract id; the participant needs the create event blob to
  // interpret it). Same trick as the factory templateId discovery in
  // transfer.ts.
  const tiDisclosed = context.disclosedContracts.find(
    (d) => d.contractId === transferInstructionCid
  );
  const tiTemplateId =
    tiDisclosed?.templateId ??
    // Fallback to the canonical Splice Token Standard name. If our
    // packageId is wrong, the participant will tell us which one to use
    // in the error.
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

  const commandId = `tusd-accept-${transferInstructionCid.slice(0, 16)}-${Date.now()}`;

  const commandBody = {
    commands: [
      {
        ExerciseCommand: {
          templateId: tiTemplateId,
          contractId: transferInstructionCid,
          choice: "TransferInstruction_Accept",
          choiceArgument: {
            extraArgs: {
              context: context.choiceContextData,
              meta: { values: {} as Record<string, string> },
            },
          },
        },
      },
    ],
    commandId,
    // The wildcard-auth admin token's implicit user is `participant_admin`.
    // Daml 3.x requires this when the JWT doesn't carry a user-id claim.
    userId: "participant_admin",
    actAs: [receiverParty],
    // Optionally trim disclosedContracts to only those referenced by the
    // choice context plus the TI cid itself. Off by default; flip via
    // CBTC_TRIM_DISCLOSED=1 (the trim helper is generic and shared with
    // CBTC). Dry-run logs the would-be savings either way.
    disclosedContracts: maybeTrimDisclosed(
      env,
      "accept",
      context.disclosedContracts,
      context.choiceContextData,
      [transferInstructionCid]
    ),
  };

  const url = `${ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`;

  if (env.TRAFFIC_DEBUG === "1") {
    const disc = commandBody.disclosedContracts ?? [];
    const bodyBytes = JSON.stringify(commandBody).length;
    const discBytes = disc.reduce((a, d) => a + ((d as { createdEventBlob?: string }).createdEventBlob?.length ?? 0), 0);
    console.log(
      `[traffic] choice=tUSD:TransferInstruction_Accept bodyBytes=${bodyBytes} disclosedBytes=${discBytes} disclosedCount=${disc.length}`
    );
  }

  // ── Sequencer-409 retry loop ───────────────────────────────────────
  //
  // Canton mainnet sequencer returns 409 SEQUENCER_REQUEST_FAILED /
  // RequestRefused under sustained backpressure. The command never
  // reached consensus, so retrying with the SAME commandId is safe
  // (and actively desirable — same commandId means dedup if a past
  // attempt actually landed but the response was lost).
  //
  // Same retry shape as src/tusd/transfer.ts. Bounded: 6 attempts with
  // linear backoff. Other failures (DAML_FAILURE, CONTRACT_NOT_FOUND,
  // 5xx) bail immediately — those aren't transient and retrying just
  // burns subrequest budget.
  const MAX_ATTEMPTS = 6;
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

    // Linear backoff: 1s, 2s, 3s, 4s, 5s. Gives sequencer breathing room.
    const sleepMs = 1000 * attempt;
    console.log(
      `[tusd.accept] sequencer 409 attempt ${attempt}/${MAX_ATTEMPTS}, retry in ${sleepMs}ms — cid=${commandId.slice(0, 16)}…`
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

  const created: Array<{
    contractId: string;
    templateId?: string;
    createArgument: Record<string, unknown>;
  }> = [];
  for (const ev of Object.values(result.transactionTree?.eventsById ?? {})) {
    const e = ev as {
      CreatedTreeEvent?: {
        value: {
          contractId: string;
          templateId: string;
          createArgument: Record<string, unknown>;
        };
      };
    };
    if (e.CreatedTreeEvent?.value) {
      const v = e.CreatedTreeEvent.value;
      created.push({
        contractId: v.contractId,
        templateId: v.templateId,
        createArgument: v.createArgument ?? {},
      });
    }
  }

  return {
    updateId: result.transactionTree.updateId,
    createdEvents: created,
  };
}

/* ────────── Public API ────────── */

/**
 * Accept a TransferInstruction on chain, as `receiverParty`.
 *
 * Returns the chain update id, the new Holding cid (if any was created
 * — defensive null in case the factory archives differently), and the
 * amount-in-smallest-unit extracted from the Holding's payload.
 *
 * The caller is responsible for the Postgres-side credit + transaction
 * row write. This function ONLY handles the chain side.
 */
export async function acceptTransferInstruction(
  env: Env,
  receiverParty: string,
  transferInstructionCid: string
): Promise<AcceptResult> {
  if (env.TUSD_ENABLED !== "1" && env.TUSD_ENABLED !== "true") {
    throw new LedgerCallError(503, "tUSD is not enabled.");
  }
  if (!transferInstructionCid) {
    throw new LedgerCallError(400, "transferInstructionCid required.");
  }
  if (!receiverParty) {
    throw new LedgerCallError(400, "receiverParty required.");
  }

  const instrument = await getTusdInstrument(env);
  const resolvedAdmin = instrument.instrumentId.admin;
  const accessToken = await getTusdKeycloakToken(env);

  // ── Pre-flight
  let ctx: AcceptContextResponse;
  try {
    ctx = await getAcceptContext(env, transferInstructionCid, resolvedAdmin);
  } catch (err) {
    if (err instanceof LedgerCallError && err.status === 401) {
      await invalidateKeycloakToken(env);
      throw new LedgerCallError(
        401,
        "Registry rejected auth on accept-context. Token invalidated; retry."
      );
    }
    throw err;
  }

  // ── Exercise. AcceptContextResponse is the ChoiceContext itself
  //    (flat, no wrapper) — see the type alias.
  let result: Awaited<ReturnType<typeof submitAcceptCommand>>;
  try {
    result = await submitAcceptCommand(
      env,
      accessToken,
      receiverParty,
      transferInstructionCid,
      ctx
    );
  } catch (err) {
    if (err instanceof LedgerCallError && err.status === 401) {
      await invalidateKeycloakToken(env);
      throw new LedgerCallError(
        401,
        "Ledger rejected auth on accept. Token invalidated; retry."
      );
    }
    throw err;
  }

  // ── Parse new Holding from the resulting transaction tree
  let holdingCid: string | null = null;
  let amountSat: number | null = null;
  // tUSD ships with decimals=10. The registry's `decimals` field is the
  // source of truth. Fall back to 8 only if the registry didn't return
  // a value (which shouldn't happen, but defends against malformed
  // metadata).
  const conversionFactor = 10 ** (instrument.decimals ?? 8);
  for (const ev of result.createdEvents) {
    if (!ev.templateId?.includes(":Holding")) continue;
    const arg = ev.createArgument as {
      owner?: string;
      amount?: string | number;
    };
    if (arg.owner !== receiverParty) continue;
    holdingCid = ev.contractId;
    // Daml Decimal arrives as a string. Convert decimal → smallest
    // unit (which we keep calling "sat" for code consistency).
    if (arg.amount != null) {
      const tusd = Number(arg.amount);
      if (Number.isFinite(tusd)) {
        amountSat = Math.round(tusd * conversionFactor);
      }
    }
    break;
  }

  return {
    updateId: result.updateId,
    holdingCid,
    ownerParty: receiverParty,
    amountSat,
  };
}
