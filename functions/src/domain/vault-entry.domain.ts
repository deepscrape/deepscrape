/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The vault's index layer: what an entry is, and how everything about it is
 * named.
 *
 * Pure: no I/O, no Firestore, no clock. The names it derives are the contract
 * two other layers depend on -- the store that persists the index, and the
 * account purge that must enumerate everything belonging to a uid -- so they are
 * derived here rather than inside either caller.
 *
 * The payload is never in this layer, and its LOCATION is derived rather than
 * stored
 * -------------------------------------------------------------------------
 * A vault entry's payload is cookies plus localStorage, i.e. a credential.
 * `storage-settings.store.ts` states the rule this follows: Firestore holds
 * "only the `secretPath` that points at them -- never the value". This goes one
 * step further and stores no pointer at all: `vaultBlobKey` is a pure function
 * of (uid, service, profile), so there is nothing for a hand-edited document to
 * repoint, and no stored path can disagree with the blob actually written. The
 * record below carries names and bookkeeping only.
 *
 * Why the name rule refuses more than Firestore does
 * --------------------------------------------------
 * `service` and `profile` reach a worker, which joins them onto a filesystem
 * path -- `profiles_dir()/<service>/<profile>/state.json`. So a name is an
 * ADDRESS, not a label: `..` or an embedded separator climbs out of that
 * directory on the worker. Firestore would accept several such strings, so this
 * guard has to be stricter than the store. This is the one place that decides,
 * and it decides before the value reaches a worker.
 */

/**
 * The longest `service` or `profile` this platform forwards to a worker.
 *
 * Bounded independently of the store's own limit, because the value becomes a
 * path SEGMENT on the worker's disk and a filesystem caps a segment at 255
 * bytes. 64 sits well inside that and leaves room for the filename the worker
 * appends.
 */
export const VAULT_NAME_MAX_LENGTH = 64

/**
 * A `service` or `profile` that is safe to address an entry by.
 *
 * Must START alphanumeric, then allow `.`, `_` and `-`. The one rule refuses
 * every shape that matters: `..` (leading dot), `.` alone, an embedded `/` or
 * `\` (neither is in the class), the empty string, and a leading `-` or `.` that
 * a shell or a path join could read as an option or a hidden file.
 * @param {*} value The untrusted name.
 * @return {boolean} True when the name may address a vault entry.
 */
export const isSafeVaultName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= VAULT_NAME_MAX_LENGTH &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)

/** One vault entry as this platform records it: names and bookkeeping only. */
export type VaultEntryRecord = {
  service: string
  profile: string
  /** The account the worker reported for the entry, when it reported one. */
  username?: string
  /** Epoch ms of the last write to this entry. */
  updatedAtMs?: number
}

/**
 * One vault entry as a caller may read it.
 *
 * A projection rather than the record itself, so a field added to the record
 * later cannot leak by default -- the same reason `toPublicSession` builds its
 * shape field by field instead of spreading.
 */
export type VaultEntryPublic = {
  service: string
  profile: string
  username?: string
}

/**
 * The document id for one entry: `service:profile`.
 *
 * `:` is legal in a Firestore document id and is in NEITHER name's alphabet (see
 * `isSafeVaultName`), so the pair cannot be ambiguous -- `a_b` + `c` and `a` +
 * `b_c` stay distinct. Both halves must be validated by the caller; this only
 * joins.
 * @param {string} service The validated service name.
 * @param {string} profile The validated profile name.
 * @return {string} The document id.
 */
export const vaultEntryId = (service: string, profile: string): string =>
  `${service}:${profile}`

/**
 * The object-key prefix every entry of one caller lives under.
 *
 * Exists so ERASURE can sweep by prefix. `purgeAccountBlobs` walks the artifact
 * namespace derived from a uid, and the vault namespace is a SIBLING of that
 * one, not a child -- so a purge that knew only `userObjectKeyPrefix` would
 * leave every vault payload behind: a credential outliving the account that
 * owned it. Two namespaces is what keeping entries out of the artifact listing
 * costs, since the storage page renders that listing.
 *
 * Unlike the artifact prefix this one carries the RAW uid. That is the specified
 * shape (`vault/<uid>/...`), it never leaves the platform bucket, and the
 * account purge has to be able to derive it from a uid alone.
 * @param {string} uid The verified caller uid.
 * @return {string} The key prefix, trailing slash included.
 */
export const vaultKeyPrefix = (uid: string): string => `vault/${uid}/`

/**
 * Where an entry's payload lives in the shared artifact bucket.
 *
 * Derived from the identity, never stored -- see this file's header. The `vault/`
 * prefix is what keeps entries out of the artifact namespace, and it is also the
 * prefix a purge can sweep by.
 * @param {string} uid The verified caller uid.
 * @param {string} service The validated service name.
 * @param {string} profile The validated profile name.
 * @return {string} The object key.
 */
export const vaultBlobKey = (
  uid: string,
  service: string,
  profile: string,
): string => `${vaultKeyPrefix(uid)}${service}/${profile}.json`

/**
 * The Secret Manager id for a caller's vault key.
 *
 * PER CALLER, not per entry, and that is the whole reason it is derived from the
 * uid alone: the key decrypts every one of that caller's entries, so purging it
 * alongside one entry's deletion would destroy the others. Same reasoning that
 * made the BYO CDP secret per user (`cdpSecretId`) rather than per session, and
 * the same shape as its siblings `storage-byob-<uid>` and `browser-cdp-<uid>`.
 *
 * Because a uid maps to exactly one id, a purge needs no prefix scan and no
 * hand-maintained list -- the list is the bug this avoids.
 * @param {string} uid The verified caller uid.
 * @return {string} The Secret Manager secret id.
 */
export const vaultKeySecretId = (uid: string): string => `vault-key-${uid}`

/**
 * The read projection: names only.
 *
 * `updatedAtMs` is dropped deliberately. It is index bookkeeping, not something
 * the UI shows, and a projection that forwarded every record field would ship
 * each future field by default.
 * @param {VaultEntryRecord} record The stored record.
 * @return {VaultEntryPublic} What a caller may see.
 */
export const toPublicVaultEntry = (
  record: VaultEntryRecord,
): VaultEntryPublic => {
  const entry: VaultEntryPublic = {
    service: record.service,
    profile: record.profile,
  }
  if (record.username) {
    entry.username = record.username
  }
  return entry
}
