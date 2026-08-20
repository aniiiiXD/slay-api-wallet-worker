/* ------------------------------------------------------------------ *
 *  kms/provision.ts — give a NEW user a self-custody party.
 *
 *  Post-cutover every user's funds live on their own KMS-keyed
 *  `slay-money::` party. But party creation still ran through the Splice
 *  validator's onboarding API, which mints a CUSTODIAL party hinted with the
 *  user's email local part (`ayush::…`). Those two facts disagreed silently:
 *  looksExternalParty() only recognises the `slay-money::` prefix, so a
 *  custodially-onboarded user is treated as legacy everywhere — their balance
 *  is read from the pg shadow, their sends can't be KMS-signed, and they are
 *  outside the model the rest of the app now assumes.
 *
 *  This is the counterpart of the migration's per-user path: same hint, same
 *  external_parties row, same preapproval — just done at onboarding, before
 *  there is anything to drain.
 * ------------------------------------------------------------------ */
import { sql } from "drizzle-orm";
import type { Env } from "../env";
import type { createDb } from "../db";
import { createExternalParty, setupPreapproval } from "./external-party";
import type { EncryptedKey } from "./keys";

type DB = ReturnType<typeof createDb>;

/** The ON-CHAIN hint. Shared brand, not the user — every self-custody party is
 *  `slay-money::<their-unique-key>`, which is what looksExternalParty keys on. */
export function selfCustodyHint(env: Env): string {
  return (env.SLAY_PARTY_HINT || "slay-money")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30);
}

/** Default ON: self-custody is the model. "0" falls back to Splice custodial
 *  onboarding, kept only as an escape hatch if external signing is down. */
export function selfCustodyOnboarding(env: Env): boolean {
  const raw = String(env.SELF_CUSTODY_ONBOARDING ?? "")
    .replace(/^﻿/, "")
    .trim();
  return raw !== "0" && raw.toLowerCase() !== "false";
}

async function ensureTable(db: DB): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS external_parties (
    id text PRIMARY KEY, label text, party_hint text, party_id text UNIQUE,
    public_key_hex text, enc_priv_key text, iv text, encrypted_data_key text,
    migrated boolean DEFAULT false, created_at timestamptz DEFAULT now())`);
  await db
    .execute(sql`ALTER TABLE external_parties ADD COLUMN IF NOT EXISTS label text`)
    .catch(() => {});
}

/**
 * Allocate (or reuse) this user's self-custody party and point their wallet at
 * it. Moves no funds — a brand-new user has none.
 *
 * The wallet UPDATE is guarded on `canton_address IS NULL`. A user who already
 * has a party must go through the migration path instead (create → preapproval
 * → drain → repoint); repointing a funded party here would strand its balance
 * on a party nothing references any more.
 */
export async function provisionSelfCustodyParty(
  env: Env,
  db: DB,
  userId: string
): Promise<{ partyId: string; reused: boolean; repointed: boolean }> {
  const hint = selfCustodyHint(env);

  // Reuse an existing key for this label rather than minting a second party.
  // Users owning several parties was a genuine mess during the migration (it
  // needed a whole "which one has the funds" resolver in /external-party/repoint)
  // and there is no reason to recreate it here.
  const rows = await db.execute(sql`
    SELECT party_id, public_key_hex, enc_priv_key, iv, encrypted_data_key
    FROM external_parties WHERE label=${userId}
    ORDER BY created_at DESC LIMIT 1`);
  const existing = ((rows as unknown as { rows?: unknown[] }).rows ??
    (rows as unknown as unknown[]))[0] as
    | {
        party_id: string;
        public_key_hex: string;
        enc_priv_key: string;
        iv: string;
        encrypted_data_key: string;
      }
    | undefined;

  let partyId: string;
  let key: EncryptedKey;
  let reused = false;

  if (existing?.party_id) {
    partyId = existing.party_id;
    key = {
      publicKeyHex: existing.public_key_hex,
      encPrivKey: existing.enc_priv_key,
      iv: existing.iv,
      encryptedDataKey: existing.encrypted_data_key,
    };
    reused = true;
  } else {
    const r = await createExternalParty(env, hint, "full");
    await ensureTable(db);
    // The key is the user's funds. If this INSERT is lost the party is
    // unspendable, so it lands BEFORE the wallet points at the party.
    await db.execute(sql`
      INSERT INTO external_parties
        (id, label, party_hint, party_id, public_key_hex, enc_priv_key, iv, encrypted_data_key)
      VALUES (${crypto.randomUUID()}, ${userId}, ${hint}, ${r.partyId},
              ${r.key.publicKeyHex}, ${r.key.encPrivKey}, ${r.key.iv}, ${r.key.encryptedDataKey})
      ON CONFLICT (party_id) DO NOTHING`);
    partyId = r.partyId;
    key = r.key;
  }

  // Without a TransferPreapproval an inbound external send falls back to the
  // two-phase TransferInstruction and parks until the accept cron — the same
  // stuck-deposit failure the custodial path publishes one to avoid.
  // Best-effort: a chain hiccup must not cost the user their party.
  try {
    await setupPreapproval(env, partyId, key);
  } catch (err) {
    console.error(
      "[provisionSelfCustodyParty] setupPreapproval failed (non-fatal):",
      err instanceof Error ? err.message.slice(0, 200) : String(err)
    );
  }

  const upd = await db.execute(sql`
    UPDATE wallets SET canton_address=${partyId}
    WHERE user_id=${userId} AND canton_address IS NULL
    RETURNING user_id`);
  const repointed =
    (((upd as unknown as { rows?: unknown[] }).rows ??
      (upd as unknown as unknown[])) as unknown[]).length > 0;
  if (!repointed) {
    console.warn(
      `[provisionSelfCustodyParty] wallet user=${userId.slice(0, 8)}… already had a party; left it alone (party ${partyId} is provisioned and idle)`
    );
  }
  return { partyId, reused, repointed };
}
