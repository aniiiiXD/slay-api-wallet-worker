/* ------------------------------------------------------------------ *
 *  Slay Ledger Client — Canton 3.x JSON Ledger API v2.                 *
 *                                                                      *
 *  The v2 API replaced the v1 namespaced endpoints (/v1/create,        *
 *  /v1/exercise, /v1/query) with a unified command-submission model:   *
 *                                                                      *
 *    POST /v2/commands/submit-and-wait-for-transaction-tree            *
 *         — generic "do these N things, give me the tx tree" endpoint  *
 *           used for both creates and exercises.                       *
 *                                                                      *
 *    POST /v2/state/active-contracts                                   *
 *         — paginated active-contract query.                           *
 *                                                                      *
 *    GET  /v2/state/ledger-end                                         *
 *         — current ledger offset (needed for active-contracts queries) *
 *                                                                      *
 *    POST /v2/users / /v2/users/<id>/rights                            *
 *         — Canton user management (actAs rights granted per user-id).  *
 *                                                                      *
 *  Auth:                                                               *
 *    - Token's `sub` claim names the Canton user the bearer is acting *
 *      as. That user's pre-configured actAs/readAs rights apply.       *
 *    - In Splice disable-auth mode the secret is "unsafe", audience    *
 *      is whatever the participant's app.conf has — usually            *
 *      "https://canton.network.global". Both in env.                   *
 *                                                                      *
 *  Public surface kept compatible with the v1 wrapper where possible — *
 *  callers (markets/onchain.ts etc.) keep their existing call sites.   *
 * ------------------------------------------------------------------ */

import { signLedgerJWT, signAdminJWT } from "./jwt";
import type { Env } from "../env";

/* ------------------------------------------------------------------ */
/*  Errors                                                              */
/* ------------------------------------------------------------------ */

export class LedgerCallError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown
  ) {
    super(message);
  }

  get isRetryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status >= 500;
  }
}

/* ------------------------------------------------------------------ */
/*  Template identifiers                                                */
/*                                                                      */
/*  Wire format: <package-id>:<module>:<entity>                        */
/*  Same as v1. Centralised so package promotion is one env-var swap.  */
/* ------------------------------------------------------------------ */

export type TemplateId = {
  packageId: string;
  moduleName: string;
  entityName: string;
};

export function slayTemplate(
  env: Env,
  moduleName: string,
  entityName: string
): TemplateId {
  const packageId = env.SLAY_DAR_PACKAGE_ID;
  if (!packageId) {
    throw new LedgerCallError(
      500,
      "SLAY_DAR_PACKAGE_ID is not set — DAR isn't deployed yet."
    );
  }
  return { packageId, moduleName, entityName };
}

export function tidToString(tid: TemplateId): string {
  return `${tid.packageId}:${tid.moduleName}:${tid.entityName}`;
}

/* ------------------------------------------------------------------ */
/*  HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

type CallOpts = {
  /** Token override — use signAdminJWT() for user-mgmt endpoints. */
  asAdmin?: boolean;
  /** Override the `sub` claim. Defaults to env.LEDGER_USER_ID. */
  subOverride?: string;
  /** Which participant's ledger to hit. Default "v1" (wallet participant,
   *  JSON_API_URL). "v2" targets the prediction participant (JSON_API_URL_V2)
   *  and adds the X-Ledger-Gate shared-secret header its Caddy requires. */
  target?: "v1" | "v2";
};

/* Exported under a stable name so the admin diag endpoint can hit any
 * v2 JSON Ledger path without a dedicated wrapper for each one. Same
 * auth + base-URL plumbing as everything else in this file. */
export async function rawLedgerCall<T>(
  env: Env,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: object,
  target: "v1" | "v2" = "v1"
): Promise<T> {
  return call<T>(env, path, method, body, { target });
}

async function call<T>(
  env: Env,
  path: string,
  method: "GET" | "POST",
  body?: object,
  opts: CallOpts = {}
): Promise<T> {
  const jwt = opts.asAdmin
    ? await signAdminJWT(env)
    : await signLedgerJWT(env, opts.subOverride);

  const baseUrl = opts.target === "v2" ? (env.JSON_API_URL_V2 ?? "") : env.JSON_API_URL;
  if (opts.target === "v2" && !baseUrl) {
    throw new LedgerCallError(0, `v2 ledger call to ${path} but JSON_API_URL_V2 is not configured`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  };
  // Both ledgers run with participant auth DISABLED, so the only thing standing
  // between the public internet and "submit any command as any party" is a
  // Caddy shared-secret gate on the hostname. Every call must carry the gate
  // header for its target or Caddy 403s before the request reaches the ledger.
  // Sending the header is harmless before the gate is switched on, which lets
  // us deploy this first and flip Caddy second without an outage.
  if (opts.target === "v2" && env.JSON_API_V2_GATE) {
    headers["X-Ledger-Gate"] = env.JSON_API_V2_GATE;
  }
  if (opts.target !== "v2" && env.JSON_API_GATE) {
    headers["X-Ledger-Gate"] = env.JSON_API_GATE;
  }
  const fullUrl = `${baseUrl}${path}`;
  // DNS-outage stopgap: when LEDGER_RESOLVE_IP is set, route the v1 ledger call
  // straight to the box IP (keeping SNI/Host = the configured hostname so the
  // existing TLS cert still matches) instead of relying on public DNS. Lets us
  // survive a lapsed/parked domain without touching DNS. v2 (validator-2) is
  // left on normal resolution.
  const init: RequestInit = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  if (opts.target !== "v2" && env.LEDGER_RESOLVE_IP) {
    (init as RequestInit & { cf?: Record<string, unknown> }).cf = {
      resolveOverride: env.LEDGER_RESOLVE_IP,
    };
  }
  let res: Response;
  try {
    res = await fetch(fullUrl, init);
  } catch (err) {
    throw new LedgerCallError(
      0,
      `Network error calling ${path}: ${err instanceof Error ? err.message : err}`
    );
  }

  const text = await res.text();
  if (!res.ok) {
    // Try to extract a structured error message.
    let detail: unknown = text;
    try {
      detail = JSON.parse(text);
    } catch {
      // Plain text body.
    }
    // Surface enough detail to debug without grepping logs — the body
    // is the only thing that tells us why the participant rejected.
    // Include just the path + status in the message (production logs);
    // body preview goes in `detail` for callers that want it.
    const bodyPreview = text.slice(0, 800).replace(/\s+/g, " ");
    throw new LedgerCallError(
      res.status,
      `${method} ${path} → ${res.status}: ${bodyPreview}`,
      detail
    );
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LedgerCallError(
      res.status,
      `Non-JSON response from ${path}: ${text.slice(0, 200)}`
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Command envelope                                                    */
/*                                                                      */
/*  In v2 every mutation goes through one endpoint with a list of       */
/*  commands. We expose `create()` and `exercise()` as convenience      */
/*  wrappers that each submit a single-command tree.                    */
/* ------------------------------------------------------------------ */

type V2Command =
  | { CreateCommand: { templateId: string; createArguments: object } }
  | {
      ExerciseCommand: {
        templateId: string;
        contractId: string;
        choice: string;
        choiceArgument: object;
      };
    };

type V2SubmitRequest = {
  commands: V2Command[];
  commandId: string;
  actAs: string[];
  readAs: string[];
  userId: string;
  applicationId?: string;
  workflowId?: string;
  disclosedContracts?: DisclosedContract[];
};

/** Subset of the v2 transactionTree we care about. */
type V2TransactionTree = {
  updateId: string;
  commandId: string;
  workflowId?: string;
  effectiveAt: string;
  offset: string;
  rootEventIds: string[];
  eventsById: Record<
    string,
    | {
        CreatedTreeEvent: {
          value: {
            eventId: string;
            contractId: string;
            templateId: string;
            createArgument: unknown;
            signatories: string[];
            observers: string[];
            witnessParties?: string[];
          };
        };
      }
    | {
        ExercisedTreeEvent: {
          value: {
            eventId: string;
            contractId: string;
            templateId: string;
            choice: string;
            choiceArgument: unknown;
            exerciseResult: unknown;
            consuming: boolean;
            childEventIds: string[];
          };
        };
      }
  >;
};

type V2SubmitResponse = { transactionTree: V2TransactionTree };

/* ------------------------------------------------------------------ */
/*  Contract envelope (matches what callers expected from the v1       */
/*  client — we recompose v1-shaped objects from the v2 tree events).  */
/* ------------------------------------------------------------------ */

export type ContractEnvelope<TPayload> = {
  contractId: string;
  templateId: string;
  payload: TPayload;
  signatories: string[];
  observers: string[];
};

/* ------------------------------------------------------------------ */
/*  v2 event extraction                                                 */
/*                                                                      */
/*  Walks eventsById, returning a normalised list of created/archived  */
/*  envelopes so the caller doesn't have to know about the tree shape.  */
/* ------------------------------------------------------------------ */

export type NormalisedEvent =
  | {
      kind: "created";
      contractId: string;
      templateId: string;
      payload: unknown;
      signatories: string[];
      observers: string[];
    }
  | {
      kind: "archived";
      contractId: string;
      templateId: string;
    };

export function eventsFromTree(tree: V2TransactionTree): NormalisedEvent[] {
  const out: NormalisedEvent[] = [];
  for (const id of Object.keys(tree.eventsById)) {
    const ev = tree.eventsById[id];
    if ("CreatedTreeEvent" in ev) {
      const c = ev.CreatedTreeEvent.value;
      out.push({
        kind: "created",
        contractId: c.contractId,
        templateId: c.templateId,
        payload: c.createArgument,
        signatories: c.signatories,
        observers: c.observers,
      });
    } else if ("ExercisedTreeEvent" in ev) {
      // A consuming exercise archives its target. Surface the archive
      // so the caller can map "which contract was replaced".
      const e = ev.ExercisedTreeEvent.value;
      if (e.consuming) {
        out.push({
          kind: "archived",
          contractId: e.contractId,
          templateId: e.templateId,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Public API — create                                                 */
/* ------------------------------------------------------------------ */

export async function create<TPayload extends object, TResult = TPayload>(
  env: Env,
  parties: string[],
  templateId: TemplateId,
  payload: TPayload,
  opts: { commandId?: string; subOverride?: string; target?: "v1" | "v2" } = {}
): Promise<ContractEnvelope<TResult>> {
  const userId = opts.subOverride || env.LEDGER_USER_ID || "slay-money-api";
  const req: V2SubmitRequest = {
    commands: [
      {
        CreateCommand: {
          templateId: tidToString(templateId),
          createArguments: payload,
        },
      },
    ],
    commandId: opts.commandId || newCommandId(),
    actAs: parties,
    readAs: parties,
    userId,
    applicationId: userId,
  };

  const resp = await call<V2SubmitResponse>(
    env,
    "/v2/commands/submit-and-wait-for-transaction-tree",
    "POST",
    req,
    { subOverride: opts.subOverride, target: opts.target }
  );

  // Find the created event for our template.
  const created = eventsFromTree(resp.transactionTree).find(
    (e) => e.kind === "created" && e.templateId === tidToString(templateId)
  );
  if (!created || created.kind !== "created") {
    throw new LedgerCallError(
      500,
      `Create succeeded but no matching created-event for ${tidToString(templateId)} in the response tree.`
    );
  }
  // One-time observability — log the participant's update id + tree size
  // so we can verify ledger-side that our submission actually hit. Behind
  // SPLICE_DEBUG flag so prod stays quiet.
  if (env.SPLICE_DEBUG === "1") {
    const tree = resp.transactionTree as Record<string, unknown>;
    console.log(
      `[ledger.create] tx_update_id=${tree?.updateId ?? "?"} ` +
        `offset=${tree?.offset ?? "?"} ` +
        `contract_id=${created.contractId} ` +
        `template=${created.templateId}`
    );
  }
  return {
    contractId: created.contractId,
    templateId: created.templateId,
    payload: created.payload as TResult,
    signatories: created.signatories,
    observers: created.observers,
  };
}

/* ------------------------------------------------------------------ */
/*  Public API — exercise                                               */
/* ------------------------------------------------------------------ */

export type ExerciseResult<TResult> = {
  exerciseResult: TResult;
  events: NormalisedEvent[];
  /** The on-chain transaction (update) id — the id Lighthouse/scan index this
   *  transfer under (e.g. lighthouse.cantonloop.com/transactions/<updateId>). */
  updateId: string;
};

/**
 * A contract surfaced to the participant for command-time-only use,
 * even though the submitter isn't an observer or signatory of it. Used
 * for DSO-private contracts like AmuletRules / OpenMiningRound that we
 * fetch via scan-proxy.
 */
export type DisclosedContract = {
  templateId: string;
  contractId: string;
  /** Base64-encoded created-event blob from scan-proxy. */
  createdEventBlob: string;
  /** Synchronizer the contract lives on (e.g. "global-domain::..."). */
  synchronizerId: string;
};

export async function exercise<TArg extends object, TResult = unknown>(
  env: Env,
  parties: string[],
  templateId: TemplateId,
  contractId: string,
  choice: string,
  argument: TArg,
  opts: {
    commandId?: string;
    subOverride?: string;
    disclosedContracts?: DisclosedContract[];
    target?: "v1" | "v2";
  } = {}
): Promise<ExerciseResult<TResult>> {
  const userId = opts.subOverride || env.LEDGER_USER_ID || "slay-money-api";
  const req: V2SubmitRequest = {
    commands: [
      {
        ExerciseCommand: {
          templateId: tidToString(templateId),
          contractId,
          choice,
          choiceArgument: argument,
        },
      },
    ],
    commandId: opts.commandId || newCommandId(),
    actAs: parties,
    readAs: parties,
    userId,
    applicationId: userId,
    // Splice 0.6.3: disclosedContracts is a sibling of commands/actAs/etc.
    // Each entry carries the createdEventBlob (base64) we fetched from
    // scan-proxy so the participant can verify the contract without us
    // being an observer of it. synchronizerId narrows command routing.
    ...(opts.disclosedContracts && opts.disclosedContracts.length > 0
      ? { disclosedContracts: opts.disclosedContracts }
      : {}),
  };

  if (env.TRAFFIC_DEBUG === "1") {
    const bodyBytes = JSON.stringify(req).length;
    const disc = opts.disclosedContracts ?? [];
    const discBytes = disc.reduce((a, d) => a + ((d as { createdEventBlob?: string }).createdEventBlob?.length ?? 0), 0);
    console.log(
      `[traffic] choice=${choice} bodyBytes=${bodyBytes} disclosedBytes=${discBytes} disclosedCount=${disc.length}`
    );
  }

  const resp = await call<V2SubmitResponse>(
    env,
    "/v2/commands/submit-and-wait-for-transaction-tree",
    "POST",
    req,
    { subOverride: opts.subOverride, target: opts.target }
  );

  // exerciseResult lives on the matching ExercisedTreeEvent.
  let exerciseResult: TResult = undefined as unknown as TResult;
  for (const ev of Object.values(resp.transactionTree.eventsById)) {
    if ("ExercisedTreeEvent" in ev) {
      const e = ev.ExercisedTreeEvent.value;
      if (e.contractId === contractId && e.choice === choice) {
        exerciseResult = e.exerciseResult as TResult;
        break;
      }
    }
  }

  return {
    exerciseResult,
    events: eventsFromTree(resp.transactionTree),
    updateId: resp.transactionTree.updateId,
  };
}

/* ------------------------------------------------------------------ */
/*  Public API — query                                                  */
/*                                                                      */
/*  v2 active-contracts requires the current ledger offset. We fetch    */
/*  it then issue the filtered ACS request.                             */
/* ------------------------------------------------------------------ */

type LedgerEnd = { offset: string };

async function getLedgerEnd(env: Env, target: "v1" | "v2" = "v1"): Promise<string> {
  const r = await call<LedgerEnd>(env, "/v2/state/ledger-end", "GET", undefined, { target });
  return r.offset;
}

/**
 * Snapshot of all active contracts matching `templateId`, visible to
 * `parties`. Returns a normalised v1-shape envelope so callers stay
 * happy.
 *
 * NB: this is a snapshot at the latest ledger end at call time. For
 * streaming updates we'll add subscribe* helpers in the event-mirror
 * cron — not needed for the simple "list my markets" code path.
 */
export async function query<TPayload>(
  env: Env,
  parties: string[],
  templateId: TemplateId,
  opts: { target?: "v1" | "v2" } = {}
): Promise<ContractEnvelope<TPayload>[]> {
  if (parties.length === 0) return [];

  const activeAtOffset = await getLedgerEnd(env, opts.target);
  const filtersByParty: Record<string, unknown> = {};
  for (const p of parties) {
    filtersByParty[p] = {
      cumulative: [
        {
          TemplateFilter: {
            value: {
              templateId: tidToString(templateId),
              includeCreatedEventBlob: false,
            },
          },
        },
      ],
    };
  }

  // Splice 0.6.3 returns `contractEntry.JsActiveContract.createdEvent`
  // directly (no `.value` wrapper). Older Daml docs sometimes show a
  // `value` field — that was the v1 shape. Use the flat shape.
  // Also: the field is `createArguments` (plural), not the older
  // `createArgument`.
  type V2ActiveContractsResp = Array<{
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          contractId: string;
          templateId: string;
          createArguments?: TPayload;
          createArgument?: TPayload;
          signatories: string[];
          observers: string[];
        };
      };
    };
  }>;

  const raw = await call<V2ActiveContractsResp>(
    env,
    "/v2/state/active-contracts",
    "POST",
    {
      filter: { filtersByParty },
      verbose: true,
      activeAtOffset,
    },
    { target: opts.target }
  );

  return raw.map((row) => {
    const ev = row.contractEntry.JsActiveContract.createdEvent;
    return {
      contractId: ev.contractId,
      templateId: ev.templateId,
      // Splice 0.6.3 uses `createArguments` (plural). Keep `createArgument`
      // as a fallback for older participant versions.
      payload: (ev.createArguments ?? ev.createArgument) as TPayload,
      signatories: ev.signatories,
      observers: ev.observers,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Participant user / rights management                               */
/*                                                                      */
/*  In v2, every command-submitting user must be registered on the     */
/*  participant with explicit actAs rights for each party they         */
/*  exercise as. The wallet/service.ts signup hook calls these on      */
/*  first onboard so the user can submit immediately.                  */
/* ------------------------------------------------------------------ */

export type ParticipantUser = {
  id: string;
  primaryParty?: string;
  isDeactivated?: boolean;
  metadata?: { resourceVersion?: string; annotations?: Record<string, string> };
  identityProviderId?: string;
};

export async function getOrCreateParticipantUser(
  env: Env,
  userId: string,
  primaryParty: string
): Promise<ParticipantUser> {
  // Try to fetch first — idempotent. If it 404s we create.
  try {
    const got = await call<{ user: ParticipantUser }>(
      env,
      `/v2/users/${encodeURIComponent(userId)}`,
      "GET",
      undefined,
      { asAdmin: true }
    );
    return got.user;
  } catch (err) {
    if (!(err instanceof LedgerCallError) || err.status !== 404) throw err;
  }

  // Canton 3.x v2: rights use a `kind`/`value` tagged-union wrapper.
  // We confirmed this shape by POSTing manually — the older flat
  // {"CanActAs":{"party":...}} form returns "unknown kind of right".
  const body = {
    user: { id: userId, primaryParty },
    rights: [
      {
        kind: { CanActAs: { value: { party: primaryParty } } },
      },
    ],
  };
  const created = await call<{ user: ParticipantUser }>(
    env,
    "/v2/users",
    "POST",
    body,
    { asAdmin: true }
  );
  return created.user;
}

export async function grantUserActAs(
  env: Env,
  userId: string,
  party: string
): Promise<void> {
  // v2 of the Canton Ledger API requires `userId` echoed in the body to
  // match the URL path — sending just `{ rights }` fails with
  // "<userId> does not match user in body". This was added in Canton 3.x
  // to harden CSRF on cross-origin admin calls.
  await call(
    env,
    `/v2/users/${encodeURIComponent(userId)}/rights`,
    "POST",
    {
      userId,
      rights: [{ kind: { CanActAs: { value: { party } } } }],
    },
    { asAdmin: true }
  );
}

/* ------------------------------------------------------------------ */
/*  Operator helpers                                                    */
/* ------------------------------------------------------------------ */

export function operatorParty(env: Env): string {
  const id = env.SPLICE_VALIDATOR_PARTY_ID ?? env.SLAY_PARTY_ID;
  if (!id) {
    throw new LedgerCallError(
      500,
      "Operator party ID is not configured (SPLICE_VALIDATOR_PARTY_ID or SLAY_PARTY_ID)."
    );
  }
  return id;
}

function newCommandId(): string {
  // crypto.randomUUID is available in CF Workers + modern Node.
  return crypto.randomUUID();
}
