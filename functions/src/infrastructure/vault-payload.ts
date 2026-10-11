/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * A vault payload as stored: ciphertext in the platform bucket, one object per
 * entry.
 *
 * Why the PLATFORM bucket and not the caller's own
 * -----------------------------------------------
 * `blob-purge` sweeps the platform bucket and deliberately does not reach into a
 * BYOB caller's storage -- "we hold a credential that lets us read and write
 * them; we do not hold ownership". A payload written to their bucket would
 * therefore survive an erasure request, and for a credential that is the one
 * outcome that must not happen. The purge's own rule decides this one: erasable
 * means ours.
 *
 * Nothing is stored beside the blob
 * --------------------------------
 * No key id, no pointer, no path. The object key is `vaultBlobKey(uid, service,
 * profile)` and the key is derived from the uid, so an entry's payload cannot
 * drift away from its index row and a hand-edited document cannot repoint one
 * account's entry at another's object.
 *
 * Every refusal here is a THROW
 * ----------------------------
 * An unconfigured key or bucket is not a reason to write plaintext or to answer
 * "no such entry": the first would be a credential in the clear, and the second
 * would tell a caller their saved profile is gone when the truth is that we are
 * misconfigured. The route maps these to a status that says which.
 */
import {env} from "../config/env"
import {
  derivedVaultKey,
  openVaultPayload,
  sealVaultPayload,
} from "../domain/vault-payload.domain"
import {vaultBlobKey} from "../domain/vault-entry.domain"
import type {BlobStore} from "./blob-store.port"
import {getPlatformBlobStore} from "./platform-blob-store"

/**
 * The key one caller's payloads are sealed with.
 * @param {string} uid The verified caller uid.
 * @return {Buffer} 32 key bytes.
 */
const keyFor = (uid: string): Buffer => {
  if (!env.VAULT_DATA_KEY) {
    throw new Error(
      "VAULT_DATA_KEY is not configured, so a vault payload cannot be sealed " +
      "or read",
    )
  }
  return derivedVaultKey(env.VAULT_DATA_KEY, uid)
}

/**
 * The platform store, or a throw when none is configured.
 * @param {BlobStore | null} store The resolved store.
 * @return {BlobStore} The store.
 */
const storeOrThrow = (store: BlobStore | null): BlobStore => {
  if (!store) {
    throw new Error("no platform blob store is configured for the vault")
  }
  return store
}

/**
 * Whether this deployment can store a payload at all.
 *
 * Asked by the route BEFORE it does any work, so an unconfigured deployment
 * answers 503 instead of 404. The two are not the same message to a caller:
 * "no such entry" says their saved profile is gone, and it is not.
 * @return {boolean} True when a key and a bucket are both present.
 */
export const vaultStorageAvailable = (): boolean =>
  Boolean(env.VAULT_DATA_KEY) && getPlatformBlobStore() !== null

/**
 * Seal one payload and write it.
 *
 * A plain overwrite, because an entry is addressed by `service` + `profile`:
 * saving the same pair twice is the caller refreshing what is stored, which is
 * what a save means.
 * @param {string} uid The verified caller uid.
 * @param {string} service The validated service name.
 * @param {string} profile The validated profile name.
 * @param {unknown} payload The JSON value to store.
 * @param {BlobStore | null} store The platform store.
 * @return {Promise<number>} The size of the envelope written, in bytes.
 */
export const putVaultPayload = async (
  uid: string,
  service: string,
  profile: string,
  payload: unknown,
  store: BlobStore | null = getPlatformBlobStore(),
): Promise<number> => {
  const body = sealVaultPayload(keyFor(uid), JSON.stringify(payload))

  await storeOrThrow(store).put(vaultBlobKey(uid, service, profile), body, {
    contentType: "application/json",
    // Private, and deliberately not cached: this is a credential, and a copy in
    // a shared or intermediary cache is a copy nobody can revoke.
    cacheSeconds: 0,
  })

  return body.length
}

/**
 * The payload one entry holds, or undefined when the entry has no blob.
 *
 * A DECRYPTION failure throws rather than answering undefined: "there is no
 * payload" and "there is a payload this build cannot read" must not look alike,
 * or a wrong key reads as an empty profile.
 * @param {string} uid The verified caller uid.
 * @param {string} service The validated service name.
 * @param {string} profile The validated profile name.
 * @param {BlobStore | null} store The platform store.
 * @return {Promise<unknown | undefined>} The payload, or undefined.
 */
export const getVaultPayload = async (
  uid: string,
  service: string,
  profile: string,
  store: BlobStore | null = getPlatformBlobStore(),
): Promise<unknown | undefined> => {
  const sealed = await storeOrThrow(store)
    .get(vaultBlobKey(uid, service, profile))

  if (!sealed) {
    return undefined
  }

  return JSON.parse(openVaultPayload(keyFor(uid), sealed))
}

/**
 * Delete one entry's payload. Absent is success, per the port's contract.
 * @param {string} uid The verified caller uid.
 * @param {string} service The validated service name.
 * @param {string} profile The validated profile name.
 * @param {BlobStore | null} store The platform store.
 * @return {Promise<void>} Resolves once the object is gone.
 */
export const dropVaultPayload = async (
  uid: string,
  service: string,
  profile: string,
  store: BlobStore | null = getPlatformBlobStore(),
): Promise<void> => {
  await storeOrThrow(store).delete(vaultBlobKey(uid, service, profile))
}
