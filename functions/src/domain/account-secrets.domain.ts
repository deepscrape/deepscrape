/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Every secret an account owns, by uid.
 *
 * Why a LIST is correct here, when the subcollection sweep deliberately avoids one
 * -----------------------------------------------------------------------------
 * `purgeOneAccount` destroys subcollections by ENUMERATION -- `listCollections`
 * plus a retention allowlist -- because a denylist would leak every collection
 * added later. Secret Manager has no equivalent: there is no `listCollections(uid)`
 * for it, and listing every secret in the project to filter by suffix would need a
 * project-wide read permission the purge has no other reason to hold. So this
 * registry IS the enumeration, and the naming helpers are its entries: each id is
 * derived from the uid by exactly one function and imported here, never rebuilt as
 * a string at the call site.
 *
 * The failure this closes
 * -----------------------
 * The purge read `users/{uid}/apikeys` for `secretPath` values, which covers BYOK
 * AI keys -- and only those. `storage-byob-<uid>` and `browser-cdp-<uid>` are
 * recorded as a path ON A SUBCOLLECTION DOCUMENT (`storage/settings`, and each
 * session's `cdpSecretPath`), so `recursiveDelete` removed the POINTER and left
 * the live third-party credential in Secret Manager. That is the worst shape a
 * deletion bug can take: the Firestore half is gone, so the account LOOKS erased.
 * Both are pure functions of the uid, so both are recoverable here without
 * reading anything that may already have been destroyed.
 *
 * The one maintenance rule
 * ------------------------
 * A new per-uid secret MUST be added below. That rule is why this lives in
 * `domain/` with a spec rather than inline in the purger: the spec pins that each
 * id comes from its owning helper, so a hand-rebuilt string cannot appear here
 * and drift from the id the writer actually used.
 */
import {byobSecretId} from "./storage-settings.domain"
import {cdpSecretId} from "./browser-session.domain"
import {vaultKeySecretId} from "./vault-entry.domain"

/** A per-uid Secret Manager id, and what the credential is for. */
export type AccountSecret = {
  /** The resource the credential belongs to, for the purge log. */
  resource: string
  /** The Secret Manager id, from its owning naming helper. */
  id: string
}

/**
 * Every secret id a uid owns, in a stable order.
 *
 * Returns IDs, not resource paths: this module is pure and `secretPathFor` lives
 * beside the Admin app, so the caller maps ids to paths. Keeping the conversion
 * out means this is testable with no emulator and no credentials.
 * @param {string} uid The verified caller uid.
 * @return {AccountSecret[]} One entry per derived credential.
 */
export const accountSecrets = (uid: string): AccountSecret[] => [
  {resource: "storage-byob", id: byobSecretId(uid)},
  {resource: "browser-cdp", id: cdpSecretId(uid)},
  {resource: "vault-key", id: vaultKeySecretId(uid)},
]
