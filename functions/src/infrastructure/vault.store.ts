/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The vault's index: which entries exist, for whom.
 *
 * Why an index exists at all
 * -------------------------
 * The payload lives on a worker (`state.json`) and, once the blob path lands, in
 * the artifact bucket. Neither can answer "what does this caller have saved?"
 * without a live worker -- and a worker is exactly the thing that may not exist
 * tomorrow. So the platform keeps its own record of the NAMES, which is also the
 * only thing the UI is allowed to show.
 *
 * What is NOT here
 * ----------------
 * No payload, and no pointer to one. The blob key is derived from the identity
 * by `vaultBlobKey`, so this document cannot be the thing that loses track of a
 * blob, and a caller cannot repoint an entry at somebody else's object by
 * editing a field. Same rule as `storage-settings.store.ts`, taken one step
 * further.
 *
 * Why uid-scoped and flat
 * -----------------------
 * `purgeOneAccount` enumerates a caller's subcollections and destroys whatever
 * is not on the retention allowlist. A uid-scoped collection is therefore swept
 * with no special case, and nothing here belongs on that allowlist: a vault
 * entry is a credential, and there is no tax or accounting reason to retain one.
 *
 * Not yet wired
 * -------------
 * Nothing calls this yet. Its two intended consumers are the blob export/import
 * path (which writes an entry after a successful `save_state`) and the account
 * purge (which enumerates one). Until the first exists the index is a contract
 * with no writer, and must not be presented as a working feature.
 */
import {db} from "../app/config"
import {
  isSafeVaultName,
  toPublicVaultEntry,
  vaultEntryId,
  type VaultEntryPublic,
  type VaultEntryRecord,
} from "../domain/vault-entry.domain"

/** The per-caller subcollection, named once so a rule or a test can reuse it. */
export const VAULT_ENTRIES_COLLECTION = "vaultEntries"

/**
 * One caller's vault entries.
 * @param {string} uid The verified caller uid.
 * @return {*} The Firestore collection reference.
 */
const entriesRef = (uid: string) =>
  db.collection("users").doc(uid).collection(VAULT_ENTRIES_COLLECTION)

/** What a stored document may carry. All untrusted: Firestore is a store, not a
 * validator, so a legacy or hand-edited document must not become an entry.
 */
type StoredEntryDoc = {
  service?: unknown
  profile?: unknown
  username?: unknown
  updatedAtMs?: unknown
}

/**
 * A stored document as a record, or undefined when it is not one.
 *
 * Re-runs the NAME guard rather than trusting the write path, so a document
 * written by an older build -- or by hand -- cannot reintroduce a name the
 * current guard refuses. A document that fails is dropped, never repaired: there
 * is no value here to guess at, and a guessed service name is a wrong address.
 * @param {*} raw The document data.
 * @return {VaultEntryRecord | undefined} The record, or undefined.
 */
export const parseVaultEntry = (
  raw: unknown,
): VaultEntryRecord | undefined => {
  if (!raw || typeof raw !== "object") {
    return undefined
  }
  const doc = raw as StoredEntryDoc
  if (!isSafeVaultName(doc.service) || !isSafeVaultName(doc.profile)) {
    return undefined
  }

  const record: VaultEntryRecord = {
    service: doc.service,
    profile: doc.profile,
  }
  if (typeof doc.username === "string" && doc.username.length > 0) {
    record.username = doc.username
  }
  if (typeof doc.updatedAtMs === "number" && Number.isFinite(doc.updatedAtMs)) {
    record.updatedAtMs = doc.updatedAtMs
  }
  return record
}

/**
 * Every entry this caller has, ordered by name.
 *
 * Sorted in memory rather than by a Firestore `orderBy`, because an `orderBy`
 * would want a composite index for a list this small -- and
 * `browser-session.store.ts` already establishes that a single-field subcollection
 * read needs none.
 * @param {string} uid The verified caller uid.
 * @return {Promise<VaultEntryPublic[]>} The entries, names only.
 */
export const listVaultEntries = async (
  uid: string,
): Promise<VaultEntryPublic[]> => {
  const snapshot = await entriesRef(uid).get()
  return snapshot.docs
    .map((doc) => parseVaultEntry(doc.data()))
    .filter((record): record is VaultEntryRecord => record !== undefined)
    .map(toPublicVaultEntry)
    .sort((a, b) =>
      a.service.localeCompare(b.service) ||
      a.profile.localeCompare(b.profile))
}

/**
 * Record that an entry exists, or refresh what is known about it.
 *
 * MERGED, so saving the same `service` + `profile` twice updates one entry
 * rather than creating a second: the worker's own vault is keyed by that pair,
 * so a duplicate here would be an index that disagrees with the thing it indexes.
 * An absent `username` leaves the stored one alone rather than clearing it -- a
 * caller saving again without a username has not told us the old one is wrong.
 *
 * `updatedAtMs` is taken from this process's clock, not a Firestore server
 * timestamp. It is bookkeeping used to reconcile the index against a worker, and
 * keeping it a plain number is what lets `parseVaultEntry` stay free of SDK
 * types and therefore testable without an emulator.
 * @param {string} uid The verified caller uid.
 * @param {VaultEntryRecord} entry The entry. Both names must already have passed
 *   `isSafeVaultName`.
 * @return {Promise<void>} Nothing.
 */
export const recordVaultEntry = async (
  uid: string,
  entry: VaultEntryRecord,
): Promise<void> => {
  const id = vaultEntryId(entry.service, entry.profile)
  await entriesRef(uid).doc(id).set({
    ...entry,
    updatedAtMs: Date.now(),
  }, {merge: true})
}

/**
 * Forget one entry, answering whether a document was there.
 *
 * Deliberately does NOT touch the payload. The blob is removed by whoever owns
 * that store, and coupling the two here would make this the one function that
 * must know both -- which is precisely what the derived key exists to avoid.
 * @param {string} uid The verified caller uid.
 * @param {string} service The validated service name.
 * @param {string} profile The validated profile name.
 * @return {Promise<boolean>} True when a document was deleted.
 */
export const deleteVaultEntry = async (
  uid: string,
  service: string,
  profile: string,
): Promise<boolean> => {
  const ref = entriesRef(uid).doc(vaultEntryId(service, profile))
  const existing = await ref.get()
  if (!existing.exists) {
    return false
  }
  await ref.delete()
  return true
}
