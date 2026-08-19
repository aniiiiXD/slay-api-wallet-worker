/**
 * Daml JSON API client for the local sandbox (and eventually a real Canton
 * participant). All wallet-mutating operations on Slay route through here.
 *
 * Endpoints we use:
 *   POST /v1/parties/allocate    — mint a new Canton Party for a new user
 *   POST /v1/create               — create a contract (e.g. an empty SlayHolding)
 *   POST /v1/exercise             — exercise a choice (Topup, Transfer)
 *   POST /v1/query                — query contracts by template + filter
 *
 * In `daml start` sandbox, JSON API runs at http://localhost:7575 with HS256
 * JWT auth. For the spike this is good enough; prod swaps in a real OAuth
 * issuer for the same endpoint shape.
 */
import { signLedgerJWT } from "./jwt";
import type { Env } from "../env";

type LedgerOk<T> = { status: 200; result: T };
type LedgerErr = { status: number; errors: string[] };
type LedgerResponse<T> = LedgerOk<T> | LedgerErr;

export class LedgerError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/*  Slay party ID resolution                                           */
/*  Sandbox restart re-generates party fingerprints, so a hard-coded   */
/*  SLAY_PARTY_ID env var goes stale every time. Auto-resolve via the  */
/*  /v1/parties endpoint and cache for the wrangler dev session.       */
/*  Production pins via env var, skipping the lookup.                  */
/* ------------------------------------------------------------------ */

let cachedSlayPartyId: string | null = null;

export async function resolveSlayPartyId(env: Env): Promise<string> {
  // Production override — exact party ID pinned in env.
  if (env.SLAY_PARTY_ID && env.SLAY_PARTY_ID.includes("::1220")) {
    return env.SLAY_PARTY_ID;
  }
  if (cachedSlayPartyId) return cachedSlayPartyId;

  // Legacy sandbox client: v2 tokens no longer carry parties — passing
  // undefined keeps the default service-user sub.
  const jwt = await signLedgerJWT(env);
  const res = await fetch(`${env.JSON_API_URL}/v1/parties`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new LedgerError(
      res.status,
      `Couldn't list parties (is daml start running?): ${await res.text()}`
    );
  }
  const json = (await res.json()) as {
    status: number;
    result: Array<{ identifier: string; displayName?: string; isLocal: boolean }>;
  };
  if (json.status !== 200) {
    throw new LedgerError(json.status, "Failed to list parties");
  }

  const slay = json.result.find(
    (p) => p.displayName === "slay" || p.identifier.startsWith("slay::")
  );
  if (!slay) {
    throw new LedgerError(
      404,
      "No 'slay' party found on the ledger. Run `daml start` (which creates it via the setup script) first."
    );
  }

  cachedSlayPartyId = slay.identifier;
  return slay.identifier;
}

async function call<T>(
  env: Env,
  path: string,
  method: "GET" | "POST",
  parties: string[],
  body?: object
): Promise<T> {
  // v2: parties live on the command envelope, not the token. Pass the
  // first party as the `sub` so the participant resolves to the right
  // Canton user that has actAs rights on that party.
  const jwt = await signLedgerJWT(env, parties[0]);
  const res = await fetch(`${env.JSON_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json: LedgerResponse<T>;
  try {
    json = (await res.json()) as LedgerResponse<T>;
  } catch {
    throw new LedgerError(res.status, `Non-JSON response from ${path}`);
  }

  if (json.status !== 200) {
    const errs = (json as LedgerErr).errors ?? ["unknown"];
    throw new LedgerError(json.status, errs.join("; "));
  }
  return (json as LedgerOk<T>).result;
}

/* ------------------------------------------------------------------ */
/*  Parties                                                            */
/* ------------------------------------------------------------------ */

export type AllocatedParty = {
  identifier: string;
  displayName?: string;
  isLocal: boolean;
};

/**
 * Mint a new Canton Party for a user. The hint is just a human-readable
 * fragment — the resulting party ID is `hint::1220<fingerprint>::participant`.
 * The custodian (slay) is the submitter since they're the one operating the
 * participant; the new party is on the same participant.
 */
export async function allocateUserParty(
  env: Env,
  hint: string
): Promise<AllocatedParty> {
  const slayId = await resolveSlayPartyId(env);
  return await call<AllocatedParty>(
    env,
    "/v1/parties/allocate",
    "POST",
    [slayId],
    { identifierHint: hint, displayName: hint }
  );
}

/* ------------------------------------------------------------------ */
/*  SlayHolding contracts                                              */
/* ------------------------------------------------------------------ */

// Daml JSON API requires <package>:<module>:<entity> — three parts, two colons.
// We use the package name from daml.yaml ("slay-canton-spike") which the API
// resolves to the most recently uploaded version automatically.
const TEMPLATE_ID = "slay-canton-spike:Main:SlayHolding";

type CreateResult = {
  contractId: string;
  payload: { custodian: string; owner: string; amount: string };
};

/**
 * Create a SlayHolding for a user. Custodian is the only signatory in our
 * model, so submitting as slay alone is sufficient.
 */
export async function createHolding(
  env: Env,
  ownerParty: string,
  amount: number
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<CreateResult>(
    env,
    "/v1/create",
    "POST",
    [slayId],
    {
      templateId: TEMPLATE_ID,
      payload: {
        custodian: slayId,
        owner: ownerParty,
        amount: amount.toFixed(6),
      },
    }
  );
  return result.contractId;
}

/**
 * Exercise the Topup choice on an existing SlayHolding. Custodian (slay) is
 * the controller of Topup so we submit as slay.
 */
export async function exerciseTopup(
  env: Env,
  contractId: string,
  addAmount: number
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<{ exerciseResult: string }>(
    env,
    "/v1/exercise",
    "POST",
    [slayId],
    {
      templateId: TEMPLATE_ID,
      contractId,
      choice: "Topup",
      argument: { addAmt: addAmount.toFixed(6) },
    }
  );
  return result.exerciseResult;
}

/**
 * Query the user's current SlayHolding contracts. We submit as both the
 * owner (so they can see their own observer'd contracts) AND slay (so the
 * query has full coverage). Returns array of {contractId, payload}.
 */
export async function queryHoldings(
  env: Env,
  ownerParty: string
): Promise<Array<{ contractId: string; payload: { amount: string } }>> {
  const slayId = await resolveSlayPartyId(env);
  return await call(
    env,
    "/v1/query",
    "POST",
    [slayId, ownerParty],
    {
      templateIds: [TEMPLATE_ID],
      query: { owner: ownerParty },
    }
  );
}

/**
 * Exercise the Transfer choice on a sender's SlayHolding. The sender's party
 * is the controller — slay's signatory authority is implicit because slay
 * signs the underlying contract. JSON API needs slay listed in actAs too so
 * the new contracts (with slay as signatory) can be created within the same
 * submission.
 *
 * Returns the new (senderRest, recipientNew) contract IDs.
 */
export async function exerciseTransfer(
  env: Env,
  senderContractId: string,
  senderParty: string,
  recipientParty: string,
  amount: number
): Promise<{ senderRest: string; recipientNew: string }> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<{ exerciseResult: [string, string] }>(
    env,
    "/v1/exercise",
    "POST",
    [slayId, senderParty],
    {
      templateId: TEMPLATE_ID,
      contractId: senderContractId,
      choice: "Transfer",
      argument: {
        recipient: recipientParty,
        amt: amount.toFixed(6),
      },
    }
  );
  const [senderRest, recipientNew] = result.exerciseResult;
  return { senderRest, recipientNew };
}

/* ------------------------------------------------------------------ */
/*  Rewards — RewardEntitlement + SignupBonusEntitlement               */
/*                                                                     */
/*  Flow per claim:                                                    */
/*    1. Backend gates eligibility (referrals + txn count for          */
/*       milestones; first-claim for signup bonus).                    */
/*    2. createCmd RewardEntitlement (slay signatory, user observer).  */
/*    3. exerciseCmd Mint → returns the new SlayHolding contract ID.   */
/*    4. Backend stores the entitlement + holding contract IDs.        */
/* ------------------------------------------------------------------ */

const REWARD_TEMPLATE_ID = "slay-canton-spike:Rewards:RewardEntitlement";
const SIGNUP_BONUS_TEMPLATE_ID = "slay-canton-spike:Rewards:SignupBonusEntitlement";

export async function createRewardEntitlement(
  env: Env,
  recipientParty: string,
  level: number,
  rewardAmt: number
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<CreateResult>(
    env,
    "/v1/create",
    "POST",
    [slayId],
    {
      templateId: REWARD_TEMPLATE_ID,
      payload: {
        custodian: slayId,
        recipient: recipientParty,
        level,
        rewardAmt: rewardAmt.toFixed(6),
      },
    }
  );
  return result.contractId;
}

/** Exercise Mint on a RewardEntitlement. Returns the new SlayHolding cid. */
export async function exerciseMintReward(
  env: Env,
  entitlementContractId: string
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<{ exerciseResult: string }>(
    env,
    "/v1/exercise",
    "POST",
    [slayId],
    {
      templateId: REWARD_TEMPLATE_ID,
      contractId: entitlementContractId,
      choice: "Mint",
      argument: {},
    }
  );
  return result.exerciseResult;
}

export async function createSignupBonusEntitlement(
  env: Env,
  recipientParty: string,
  bonusAmt: number
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<CreateResult>(
    env,
    "/v1/create",
    "POST",
    [slayId],
    {
      templateId: SIGNUP_BONUS_TEMPLATE_ID,
      payload: {
        custodian: slayId,
        recipient: recipientParty,
        bonusAmt: bonusAmt.toFixed(6),
      },
    }
  );
  return result.contractId;
}

export async function exerciseMintSignupBonus(
  env: Env,
  entitlementContractId: string
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<{ exerciseResult: string }>(
    env,
    "/v1/exercise",
    "POST",
    [slayId],
    {
      templateId: SIGNUP_BONUS_TEMPLATE_ID,
      contractId: entitlementContractId,
      choice: "MintBonus",
      argument: {},
    }
  );
  return result.exerciseResult;
}

/* ------------------------------------------------------------------ */
/*  P2P escrow — SlayEscrow                                            */
/*                                                                     */
/*  Flow per order:                                                    */
/*    1. acceptOrder() in p2p/service.ts moves CC out of seller's      */
/*       wallet (Postgres mirror) and calls createEscrow() to mint a   */
/*       SlayEscrow contract holding the same amount on-ledger.        */
/*    2. confirmPaymentReceived() exercises Release → SlayHolding for  */
/*       the buyer is created, Postgres credits buyer.                 */
/*    3. cancelOrder() on a matched order exercises Refund → seller    */
/*       gets a SlayHolding back, Postgres refunds.                    */
/* ------------------------------------------------------------------ */

const ESCROW_TEMPLATE_ID = "slay-canton-spike:Escrow:SlayEscrow";

export async function createEscrow(
  env: Env,
  sellerParty: string,
  buyerParty: string,
  amount: number,
  orderId: string
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<CreateResult>(
    env,
    "/v1/create",
    "POST",
    [slayId],
    {
      templateId: ESCROW_TEMPLATE_ID,
      payload: {
        custodian: slayId,
        seller: sellerParty,
        buyer: buyerParty,
        amount: amount.toFixed(6),
        orderId,
      },
    }
  );
  return result.contractId;
}

/** Release escrow → new SlayHolding for the buyer. Returns the holding cid. */
export async function exerciseEscrowRelease(
  env: Env,
  escrowContractId: string
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<{ exerciseResult: string }>(
    env,
    "/v1/exercise",
    "POST",
    [slayId],
    {
      templateId: ESCROW_TEMPLATE_ID,
      contractId: escrowContractId,
      choice: "Release",
      argument: {},
    }
  );
  return result.exerciseResult;
}

/** Refund escrow → new SlayHolding back to the seller. Returns holding cid. */
export async function exerciseEscrowRefund(
  env: Env,
  escrowContractId: string
): Promise<string> {
  const slayId = await resolveSlayPartyId(env);
  const result = await call<{ exerciseResult: string }>(
    env,
    "/v1/exercise",
    "POST",
    [slayId],
    {
      templateId: ESCROW_TEMPLATE_ID,
      contractId: escrowContractId,
      choice: "Refund",
      argument: {},
    }
  );
  return result.exerciseResult;
}
