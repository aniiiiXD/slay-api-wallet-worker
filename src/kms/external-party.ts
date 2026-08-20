/* ------------------------------------------------------------------ *
 *  kms/external-party.ts — allocate a Canton external party bound to a
 *  KMS-custodied ed25519 key, via Splice's validator external-signing API.
 *
 *  Flow (no custom topology code — Splice does the heavy lifting):
 *    1. generateUserKey()                          (kms/keys.ts)
 *    2. POST external-party/topology/generate       → party_id + hashes
 *    3. KMS-sign each hash                          (kms/keys.ts signForUser)
 *    4. POST external-party/topology/submit         → external party created
 *    5. setup-proposal + prepare-accept/submit-accept → TransferPreapproval
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import { splicePostService, spliceGetService } from "../splice/client";
import { generateUserKey, signForUser, type EncryptedKey } from "./keys";
import { fetchTransferPreapproval, transferViaPreapprovalDirect } from "../splice/amulet";

const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");

const B = "/api/validator/v0/admin/external-party";

/** The raw generate response — shape learned empirically via the dry-run. */
export type TopologyGenerateResponse = {
  party_id?: string;
  partyId?: string;
  topology_txs?: unknown;
  topologyTxs?: unknown;
  [k: string]: unknown;
};

const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const hexToBytes = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

/**
 * Step 1-2 (dry-run safe): generate a fresh KMS key and ask the validator to
 * generate the external-party topology transactions for it. Submits NOTHING —
 * returns the KMS key material + the validator's raw response so we can inspect
 * the exact schema (party id, hashes) before wiring the signing/submit.
 */
export async function dryRunGenerateExternalParty(
  env: Env,
  partyHint: string
): Promise<{ key: EncryptedKey; publicKeyB64: string; response: unknown }> {
  const key = await generateUserKey(env);
  // The validator expects the raw ed25519 public key as a HEX string.
  const body = { party_hint: partyHint, public_key: key.publicKeyHex };
  const response = await splicePostService<TopologyGenerateResponse>(env, `${B}/topology/generate`, body);
  return { key, publicKeyB64: toB64(hexToBytes(key.publicKeyHex)), response };
}

type GenTx = { topology_tx: string; hash: string };

/**
 * Full external-party creation: KMS-gen key → topology/generate → KMS-sign each
 * hash → topology/submit. Creates the self-custody party ON-CHAIN (moves no
 * funds). Returns the party id + the KMS-encrypted key material to persist.
 * `hashMode` picks what bytes we sign ("full" = the 1220-prefixed hash as
 * returned; "digest" = the 32 bytes after the prefix) — the submit tells us
 * which if the first is wrong.
 */
export async function createExternalParty(
  env: Env,
  partyHint: string,
  hashMode: "full" | "digest" = "full"
): Promise<{ key: EncryptedKey; partyId: string; submit: unknown }> {
  const key = await generateUserKey(env);
  const gen = await splicePostService<TopologyGenerateResponse>(env, `${B}/topology/generate`, {
    party_hint: partyHint,
    public_key: key.publicKeyHex,
  });
  const partyId = (gen.party_id || gen.partyId) as string;
  const txs = (gen.topology_txs || gen.topologyTxs) as GenTx[];
  if (!partyId || !Array.isArray(txs)) throw new Error(`unexpected generate response: ${JSON.stringify(gen).slice(0, 200)}`);

  const signed_topology_txs: Array<{ topology_tx: string; signed_hash: string }> = [];
  for (const tx of txs) {
    const full = hexToBytes(tx.hash);
    const toSign = hashMode === "digest" && full.length > 32 ? full.slice(full.length - 32) : full;
    const sig = await signForUser(env, key, toSign);
    signed_topology_txs.push({ topology_tx: tx.topology_tx, signed_hash: toHex(sig) });
  }

  const submit = await splicePostService(env, `${B}/topology/submit`, {
    public_key: key.publicKeyHex,
    signed_topology_txs,
  });
  return { key, partyId, submit };
}

/** Read a party's CC balance via the validator's external-party balance API. */
export async function externalPartyBalance(env: Env, partyId: string): Promise<unknown> {
  return spliceGetService(env, `/api/validator/v0/admin/external-party/balance?party_id=${encodeURIComponent(partyId)}`);
}

/**
 * Move `amountCc` CC from an operator-custodial party (sender, we hold actAs)
 * to an external party via that party's TransferPreapproval. This is how funds
 * migrate old→new. Returns the on-chain update id.
 */
export async function migrateCcToExternal(
  env: Env,
  fromParty: string,
  toParty: string,
  amountCc: number,
  memo: string
): Promise<{ updateId: string | null }> {
  const preapproval = await fetchTransferPreapproval(env, toParty);
  if (!preapproval) throw new Error(`no TransferPreapproval for ${toParty} — run setup-preapproval first`);
  const r = await transferViaPreapprovalDirect(env, fromParty, toParty, amountCc, memo, preapproval);
  return { updateId: (r as { updateId?: string }).updateId ?? null };
}

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o && o[k] != null) return o[k];
  return undefined;
};

/**
 * Set up the external party's TransferPreapproval so it can send/receive CC:
 *   setup-proposal → prepare-accept → KMS-sign → submit-accept.
 * Moves no funds (just creates the preapproval contract, accepted by the new
 * party's own key). Returns each step's response so we can see the schemas.
 */
export async function setupPreapproval(
  env: Env,
  partyId: string,
  key: EncryptedKey
): Promise<{ step: string; proposal?: unknown; prepared?: unknown; accepted?: unknown }> {
  // 1. Operator proposes a TransferPreapproval for the external party. If one
  //    already exists (409), reuse its contract id (carried in the error).
  let proposal: Record<string, unknown>;
  let contractId: unknown;
  try {
    proposal = (await splicePostService(env, `${B}/setup-proposal`, { user_party_id: partyId })) as Record<string, unknown>;
    contractId = pick(proposal, "contract_id", "contractId", "setup_proposal_contract_id");
  } catch (e) {
    const err = e as { status?: number; detail?: unknown; message?: string };
    if (err.status === 409) {
      const m = /ContractId\(([^)]+)\)/.exec(JSON.stringify(err.detail ?? err.message ?? ""));
      if (!m) throw e;
      contractId = m[1];
      proposal = { reused: true, contract_id: contractId };
    } else throw e;
  }

  // 2. Prepare the accept — returns the transaction + a hash for the party to sign.
  const prepared = (await splicePostService(env, `${B}/setup-proposal/prepare-accept`, {
    contract_id: contractId,
    user_party_id: partyId,
  })) as Record<string, unknown>;
  const txHashHex = pick(prepared, "transaction_hash", "tx_hash", "hash") as string;
  const transaction = pick(prepared, "transaction", "prepared_transaction", "tx");
  if (!txHashHex) return { step: "prepare-accept (no hash)", proposal, prepared };

  // 3. KMS-sign the accept hash with the NEW party's key (full-hash mode, as topology).
  const sig = await signForUser(env, key, hexToBytes(txHashHex));

  // 4. Submit the signed accept → TransferPreapproval created. Wrapped in the
  //    ExternalPartySubmission { party_id, transaction, signed_tx_hash, public_key }.
  const accepted = await splicePostService(env, `${B}/setup-proposal/submit-accept`, {
    submission: {
      party_id: partyId,
      transaction,
      signed_tx_hash: toHex(sig),
      public_key: key.publicKeyHex,
    },
  });
  return { step: "done", proposal, prepared, accepted };
}
