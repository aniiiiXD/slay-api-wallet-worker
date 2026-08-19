/* ------------------------------------------------------------------ *
 *  kms/keys.ts — KMS-custodied per-user ed25519 keys.
 *
 *  Each user gets a UNIQUE ed25519 keypair (Canton namespace keys are
 *  ed25519). The private key is envelope-encrypted with AWS KMS (same
 *  pattern as swapso): KMS GenerateDataKey → AES-256-GCM encrypt the priv
 *  key with that data key → store {encPrivKey, iv, encryptedDataKey}. The
 *  plaintext key never persists; to sign we KMS-Decrypt the data key,
 *  AES-decrypt the priv key, ed25519-sign, and zero it.
 *
 *  Workers-native: KMS over aws4fetch SigV4 (like SES), AES-GCM via Web
 *  Crypto, ed25519 via @noble. No AWS SDK (won't run in Workers).
 * ------------------------------------------------------------------ */

import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v2 needs a sync sha512 for its sync API.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

function kmsRegion(env: Env): string {
  return env.SLAY_KMS_AWS_REGION || "us-east-1";
}
function kmsClient(env: Env): AwsClient {
  // Trim defensively — a stray newline in the secret makes the access key
  // unrecognizable to AWS (UnrecognizedClientException).
  return new AwsClient({
    accessKeyId: (env.SLAY_KMS_AWS_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (env.SLAY_KMS_AWS_SECRET_ACCESS_KEY || "").trim(),
    region: kmsRegion(env).trim(),
    service: "kms",
  });
}

/** Safe credential diagnostics — shapes only, never the values. */
export function kmsCredDiag(env: Env): Record<string, unknown> {
  const ak = env.SLAY_KMS_AWS_ACCESS_KEY_ID || "";
  const sk = env.SLAY_KMS_AWS_SECRET_ACCESS_KEY || "";
  return {
    accessKeyIdLen: ak.length,
    accessKeyIdTrimmedLen: ak.trim().length,
    accessKeyIdPrefix: ak.trim().slice(0, 4),
    accessKeyIdHasWhitespace: ak !== ak.trim(),
    secretLen: sk.length,
    secretTrimmedLen: sk.trim().length,
    secretHasWhitespace: sk !== sk.trim(),
    region: (env.SLAY_KMS_AWS_REGION || "").trim() || "(unset→us-east-1)",
    keyIdSet: !!env.SLAY_KMS_KEY_ID,
    keyIdPrefix: (env.SLAY_KMS_KEY_ID || "").slice(0, 12),
  };
}
async function kmsCall<T = Record<string, string>>(env: Env, target: string, body: object): Promise<T> {
  const aws = kmsClient(env);
  const res = await aws.fetch(`https://kms.${kmsRegion(env)}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": target },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`KMS ${target} ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt) as T;
}

const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");
export const hexToBytes = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

async function aesGcmEncrypt(dataKey: Uint8Array, plaintext: Uint8Array): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { ct, iv }; // Web Crypto appends the 16-byte auth tag to ct
}
async function aesGcmDecrypt(dataKey: Uint8Array, ct: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

/** The at-rest, KMS-wrapped representation of a user's signing key. */
export type EncryptedKey = {
  publicKeyHex: string;
  encPrivKey: string; // base64 AES-GCM(ct+tag)
  iv: string; // base64
  encryptedDataKey: string; // base64 KMS CiphertextBlob
};

/** Generate a fresh ed25519 keypair and envelope-encrypt the private key in KMS. */
export async function generateUserKey(env: Env): Promise<EncryptedKey> {
  if (!env.SLAY_KMS_KEY_ID) throw new Error("SLAY_KMS_KEY_ID not set.");
  const priv = ed.utils.randomPrivateKey(); // 32 bytes
  const pub = ed.getPublicKey(priv); // 32 bytes
  const dk = await kmsCall(env, "TrentService.GenerateDataKey", { KeyId: env.SLAY_KMS_KEY_ID, KeySpec: "AES_256" });
  const dataKey = fromB64((dk as { Plaintext: string }).Plaintext);
  try {
    const { ct, iv } = await aesGcmEncrypt(dataKey, priv);
    return {
      publicKeyHex: toHex(pub),
      encPrivKey: toB64(ct),
      iv: toB64(iv),
      encryptedDataKey: (dk as { CiphertextBlob: string }).CiphertextBlob,
    };
  } finally {
    dataKey.fill(0);
    priv.fill(0);
  }
}

/** KMS-decrypt a user's private key (transient — caller must zero it). */
async function decryptUserPriv(env: Env, k: EncryptedKey): Promise<Uint8Array> {
  const d = await kmsCall(env, "TrentService.Decrypt", { CiphertextBlob: k.encryptedDataKey });
  const dataKey = fromB64((d as { Plaintext: string }).Plaintext);
  try {
    return await aesGcmDecrypt(dataKey, fromB64(k.encPrivKey), fromB64(k.iv));
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Export the user's raw ed25519 private key as hex — for the in-app
 * "reveal private key" flow (self-custody key export). This is the ONLY path
 * that returns key material to the outside; the caller (a user-authenticated
 * route) must have verified the key belongs to the requesting user, and the
 * app gates the call behind a device biometric. Returns the 32-byte seed hex.
 */
export async function exportUserPrivHex(env: Env, k: EncryptedKey): Promise<string> {
  const priv = await decryptUserPriv(env, k);
  try {
    return toHex(priv);
  } finally {
    priv.fill(0);
  }
}

/** Sign a message (e.g. a Canton prepared-transaction hash) with the user's key. */
export async function signForUser(env: Env, k: EncryptedKey, message: Uint8Array): Promise<Uint8Array> {
  const priv = await decryptUserPriv(env, k);
  try {
    return ed.sign(message, priv);
  } finally {
    priv.fill(0);
  }
}

/** Verify a signature against a stored public key (used in the pilot roundtrip). */
export function verifyForUser(publicKeyHex: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed.verify(signature, message, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
