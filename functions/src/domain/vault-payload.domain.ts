/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Sealing a vault payload: the one place plaintext becomes ciphertext.
 *
 * Pure, and that is the point. Everything here is a function of bytes and a key
 * -- no bucket, no Secret Manager, no clock -- because a mistake in this file is
 * either a credential in the clear or a credential nobody can read again, and
 * neither is discoverable by reading a handler.
 *
 * Why AES-GCM and not, say, AES-CBC with a separate HMAC
 * ----------------------------------------------------
 * GCM is AUTHENTICATED: a tampered ciphertext, a truncated one, or the wrong key
 * makes `final()` throw instead of returning plausible plaintext. For a payload
 * that is a live session cookie, "returned something, wrong" is strictly worse
 * than "refused", so the mode that cannot do it is the mode to use.
 *
 * Why the envelope is JSON and versioned
 * -------------------------------------
 * `v` is the whole forward-compatibility story, and it behaves exactly as
 * `docs/ADR-2026-10-DURABLE-SHAPE-DISCIPLINE.md` says a durable shape must: an
 * unknown FIELD is ignored (a newer writer's extra metadata is not fatal) and an
 * unknown VERSION fails closed (this build cannot know what it would be reading).
 * The envelope is stored, so unlike a cache entry it has to be readable by a
 * later build than the one that wrote it.
 *
 * Why one platform key instead of one per account
 * ----------------------------------------------
 * The per-account key is DERIVED (HKDF, uid as the info), not stored. A secret
 * per account would mean provisioning one on first save, an extra Secret Manager
 * call on every read, and a rotation that silently makes every existing blob
 * undecryptable -- for a blast-radius difference that does not exist here, since
 * both the master key and any per-account key are readable by this same server.
 */
import {createCipheriv, createDecipheriv, hkdfSync, randomBytes} from "node:crypto"

/** The cipher. 256-bit because the key is 32 bytes and nothing forces less. */
const VAULT_CIPHER = "aes-256-gcm"

/** GCM's nonce length. 12 is the size the mode is specified around. */
const VAULT_IV_BYTES = 12

/**
 * HKDF salt. Fixed, not secret: its job is domain separation (this key must not
 * equal a key derived from the same master for any other purpose), and the uid
 * is what makes each account's key distinct.
 */
const VAULT_KEY_SALT = Buffer.from("deepscrape.vault.v1", "utf8")

/** The envelope version this build writes, and the only one it reads. */
export const VAULT_PAYLOAD_ENVELOPE_VERSION = 1

/**
 * The largest payload one entry may hold, in bytes of PLAINTEXT.
 *
 * A cookie jar for one site is a few KB. 64 KB is two orders of magnitude of
 * headroom, which is what keeps the limit from being a product decision while
 * still bounding what one account can park in the bucket.
 */
export const VAULT_PAYLOAD_MAX_BYTES = 64 * 1024

/**
 * A base64 field from an envelope, or undefined when it is not one.
 * @param {unknown} value The candidate field.
 * @return {Buffer | undefined} The decoded bytes, or undefined.
 */
const base64Bytes = (value: unknown): Buffer | undefined => {
  if (typeof value !== "string" || value.length === 0) {
    return undefined
  }
  const decoded = Buffer.from(value, "base64")
  // `Buffer.from` never throws on junk -- it decodes what it can and stops --
  // so the length is the only signal that the input was not base64 at all.
  return decoded.length > 0 ? decoded : undefined
}

/**
 * The key for one account, derived from the one platform key.
 *
 * Deterministic: the same uid and master always give the same key, which is what
 * lets a payload be readable by a later process without storing a key id beside
 * it. A wrong-length master is refused rather than stretched -- a 16-byte value
 * pasted into a 32-byte setting is a configuration mistake, and silently
 * deriving from it would hide the mistake until an audit.
 * @param {string} platformKey The base64 master key.
 * @param {string} uid The verified caller uid.
 * @return {Buffer} 32 key bytes.
 */
export const derivedVaultKey = (platformKey: string, uid: string): Buffer => {
  const master = Buffer.from(platformKey, "base64")
  if (master.length !== 32) {
    throw new Error(
      "VAULT_DATA_KEY must be 32 base64-decoded bytes; the vault cannot seal " +
      "a payload without it",
    )
  }

  return Buffer.from(
    hkdfSync("sha256", master, VAULT_KEY_SALT, `vault:${uid}`, 32),
  )
}

/**
 * A payload as the bytes to store.
 *
 * The size check is here AND in the route: here because this is the last point
 * that can refuse before bytes are written, and in the route because a caller
 * deserves a 400 rather than a 500 for a body that is merely too large.
 * @param {Buffer} key 32 key bytes from `derivedVaultKey`.
 * @param {string} plaintext The JSON text to seal.
 * @return {Buffer} The envelope, as UTF-8 JSON.
 */
export const sealVaultPayload = (key: Buffer, plaintext: string): Buffer => {
  const body = Buffer.from(plaintext, "utf8")
  if (body.length > VAULT_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `vault payload is ${body.length} bytes, over the ` +
      `${VAULT_PAYLOAD_MAX_BYTES}-byte limit`,
    )
  }

  // A fresh random nonce per write. Reusing one under the same key is the one
  // way GCM actually breaks, and a counter would have to be stored to be safe.
  const iv = randomBytes(VAULT_IV_BYTES)
  const cipher = createCipheriv(VAULT_CIPHER, key, iv)
  const data = Buffer.concat([cipher.update(body), cipher.final()])

  return Buffer.from(JSON.stringify({
    v: VAULT_PAYLOAD_ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }), "utf8")
}

/**
 * The plaintext back out of an envelope, or a throw.
 *
 * Every failure is a THROW, never a fallback to empty or partial text: the two
 * things this can be asked to read are a credential and garbage, and answering
 * "here is your profile" with the wrong bytes is how a restore silently replaces
 * a session with nothing.
 * @param {Buffer} key 32 key bytes from `derivedVaultKey`.
 * @param {Buffer} sealed The envelope bytes as stored.
 * @return {string} The JSON text.
 */
export const openVaultPayload = (key: Buffer, sealed: Buffer): string => {
  let envelope: unknown

  try {
    envelope = JSON.parse(sealed.toString("utf8"))
  } catch {
    throw new Error("vault payload is not an envelope")
  }

  const doc = (envelope ?? {}) as Record<string, unknown>
  if (doc["v"] !== VAULT_PAYLOAD_ENVELOPE_VERSION) {
    throw new Error(
      "vault payload envelope version is not one this build reads",
    )
  }

  const iv = base64Bytes(doc["iv"])
  const tag = base64Bytes(doc["tag"])
  const data = base64Bytes(doc["data"])
  if (!iv || !tag || !data) {
    throw new Error("vault payload envelope is incomplete")
  }

  const decipher = createDecipheriv(VAULT_CIPHER, key, iv)
  decipher.setAuthTag(tag)

  // A tampered byte, a truncated file, or another account's key fails HERE.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}
