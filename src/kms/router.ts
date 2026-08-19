/* ------------------------------------------------------------------ *
 *  kms/router.ts — decide whether a party is a self-custody EXTERNAL
 *  party (operator can't actAs it → must KMS-sign) or a custodial one
 *  (operator actAs, the legacy path), and load its key when external.
 *
 *  Cheap gate: only external parties carry the shared SLAY_PARTY_HINT
 *  namespace ("slay-money::"). Custodial user parties are
 *  "<user>::1220fa07…" (operator namespace) and the operator/fees
 *  parties are "slay-money-validator::" / "slay-money-fees::" — none of
 *  which start with "slay-money::" — so we skip the DB lookup entirely
 *  for them and add zero overhead to the custodial hot path.
 * ------------------------------------------------------------------ */

import type { Env } from "../env";
import type { EncryptedKey } from "./keys";
import { createDb } from "../db";
import { sql } from "drizzle-orm";

function externalHintPrefix(env: Env): string {
  const hint = (env.SLAY_PARTY_HINT || "slay-money").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
  return `${hint}::`;
}

/** True if the party COULD be a self-custody external party (cheap, no DB). */
export function looksExternalParty(env: Env, party: string): boolean {
  return typeof party === "string" && party.startsWith(externalHintPrefix(env));
}

/** Load the KMS-encrypted key for an external party, or null if none/custodial. */
export async function loadExternalKeyForParty(env: Env, party: string): Promise<EncryptedKey | null> {
  if (!looksExternalParty(env, party)) return null;
  try {
    const db = createDb(env.DATABASE_URL);
    const rows = await db.execute(sql`SELECT public_key_hex, enc_priv_key, iv, encrypted_data_key FROM external_parties WHERE party_id=${party} LIMIT 1`);
    const row = ((rows as any).rows ?? rows)[0];
    if (!row) return null;
    return { publicKeyHex: row.public_key_hex, encPrivKey: row.enc_priv_key, iv: row.iv, encryptedDataKey: row.encrypted_data_key };
  } catch {
    return null;
  }
}

/** Return the provided key, or auto-load one if `party` is an external sender. */
export async function maybeExternalKey(env: Env, party: string, provided?: EncryptedKey): Promise<EncryptedKey | undefined> {
  if (provided) return provided;
  return (await loadExternalKeyForParty(env, party)) ?? undefined;
}
