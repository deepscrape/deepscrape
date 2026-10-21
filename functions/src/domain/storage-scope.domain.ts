/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Where a saved artifact may live, decided in exactly one place.
 *
 * The rule this file exists to enforce
 * ------------------------------------
 * The SHARED tier is keyed by URL, so one object answers every caller who asks
 * for that URL. That is only safe while the object is the result of a fetch
 * that carried NO caller credential. Cache an authenticated fetch by URL and
 * user B is served user A's logged-in page -- and nothing throws, nothing logs,
 * and the wrong bytes look exactly like the right ones.
 *
 * So the shared tier is not the default and is not inferred. It is unlocked by
 * one explicit, positively-shaped assertion (`credential.anonymous === true`)
 * inside a descriptor this module can fully account for. Every other input --
 * an absent descriptor, an unknown field, cookie or authorization material, a
 * caller-supplied proxy, an unrecognised proxy value, a missing egress
 * identity -- lands the object in the caller's OWN storage instead.
 *
 * **Absence is not evidence.** A request that says nothing about its
 * credentials gets the user tier, because "we cannot tell whether this fetch
 * was credentialed" must never resolve to "probably fine".
 *
 * Why the key carries the egress identity
 * ---------------------------------------
 * Two exits can be served different bytes for one URL -- geo-routed pages,
 * A/B assignment, bot walls keyed by ASN. A key of URL alone would answer one
 * exit's request with another exit's page, which is the failure this repo's
 * `url-guard.domain.ts` calls out in the other direction. The key digests the
 * URL AND the egress identity the handler DERIVED (`PLATFORM_EGRESS_ID`), so a
 * change of exit is a different object rather than a wrong answer -- while a
 * caller-supplied string cannot become key material at all.
 *
 * The two tiers are namespaced so one bucket can hold both: `shared/<digest>`
 * for URL-keyed entries readable by all, `users/<digest(uid)>/<digest(url)>`
 * for one caller's own. Neither path contains a raw uid or a raw URL, so a
 * presigned URL does not leak either.
 */
import {createHash} from "crypto"

/** The two places an artifact may live. */
export type StorageScope = "shared" | "user"

/** Preimage separator, so `"a" + "b"` cannot collide with `"ab"`. */
const SEP = "\n"

/** Prefix for every shared-tier object. */
export const SHARED_KEY_PREFIX = "shared/"

/** Prefix for every caller-owned object. */
export const USERS_KEY_PREFIX = "users/"

/** The lifetime `/api/storage/presign` mints. Short on purpose: a signed URL
 * is a bearer credential in a query string, and this one is meant to be used
 * immediately and discarded.
 */
export const PRESIGN_TTL_SECONDS = 300

/** Longest filename accepted as object metadata. */
export const MAX_FILENAME_LENGTH = 120

/** How many objects one `list` call returns per tier. */
export const LIST_LIMIT = 100

/**
 * The only key shapes that exist. A key arriving in a request body is matched
 * against this before it is used for anything, so `shared/../users/x` and
 * friends are refused rather than prefix-matched.
 */
const KEY_SHAPE = /^(shared\/[0-9a-f]{64}|users\/[0-9a-f]{64}\/[0-9a-f]{64})$/

/** A hex sha256 of one UTF-8 preimage.
 * @param {string} preimage The value to digest.
 * @return {string} 64 lowercase hex characters.
 */
const digest = (preimage: string): string =>
  createHash("sha256").update(preimage, "utf8").digest("hex")

/** True for a non-array, non-null object.
 * @param {unknown} value The candidate.
 * @return {boolean} Whether it is a plain record.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** True when a field carries credential material.
 *
 * `null` and `undefined` are the only values that mean "none was sent". ANY
 * other value -- including an empty string, which is what a client that always
 * emits the key would send -- counts as material, because a descriptor that
 * mentions a credential is one this module cannot vouch for.
 * @param {unknown} value The candidate.
 * @return {boolean} Whether it is credential material.
 */
const isCredentialMaterial = (value: unknown): boolean =>
  value !== undefined && value !== null

/** The field names a credential descriptor may carry, and no others. */
const RECOGNISED_CREDENTIAL_KEYS: readonly string[] = [
  "anonymous",
  "cookies",
  "authorization",
  "proxy",
  "egress",
]

/** Why the scope came out the way it did. Returned, so it is visible. */
export type StorageScopeReason =
  | "anonymous"
  | "no-descriptor"
  | "credentialed"
  | "unrecognised-field"
  | "byop"
  | "missing-egress"
  | "unverified-egress"

/** The decision, and the key it produced. */
export type StorageScopeDecision = {
  scope: StorageScope
  key: string
  reason: StorageScopeReason
}

/**
 * The exit a shared-tier object in this build was actually fetched through.
 *
 * `handlers/storage.ts` performs one anonymous, unproxied `fetch`, so there is
 * exactly one answer to "where did these bytes come from" and it is not a
 * caller choice. The key still carries an egress component -- a future handler
 * that routes through several exits needs it, and the key shape is worth
 * keeping -- but the value is DERIVED here and never read from the descriptor.
 * A caller-supplied string as key material would let one URL fan out into a
 * shared entry per invented exit, every one of them holding the same bytes.
 */
export const PLATFORM_EGRESS_ID = "platform:direct"

/** The shared-tier key for one (url, egress) pair.
 * @param {string} url The URL the bytes were fetched from.
 * @param {string} egress The egress identity that fetched them.
 * @return {string} The object key.
 */
export const sharedObjectKey = (url: string, egress: string): string =>
  `${SHARED_KEY_PREFIX}${digest(`url:${SEP}${url}${SEP}egress:${SEP}${egress}`)}`

/** The namespace one caller's own objects live under.
 * @param {string} uid The verified caller uid.
 * @return {string} The prefix, ending in `/`.
 */
export const userObjectKeyPrefix = (uid: string): string =>
  `${USERS_KEY_PREFIX}${digest(`uid:${SEP}${uid}`)}/`

/**
 * One caller's key for one URL.
 *
 * URL-scoped and deliberately overwriting: the tier is the caller's own, so a
 * re-save of the same URL replaces their copy rather than accumulating
 * near-duplicates. The shared tier is the one where a wrong collision is a
 * cross-user leak, and that key includes the egress identity for exactly that
 * reason.
 * @param {string} uid The verified caller uid.
 * @param {string} url The URL the bytes were fetched from.
 * @return {string} The object key.
 */
export const userObjectKey = (uid: string, url: string): string =>
  `${userObjectKeyPrefix(uid)}${digest(`url:${SEP}${url}`)}`

/**
 * Whether a key names a shared-tier object.
 *
 * Shape-checked, not prefix-checked: `shared/../users/...` starts with the
 * prefix and must not be treated as shared.
 * @param {string} key The candidate key.
 * @return {boolean} True when it is a well-formed shared key.
 */
export const isSharedObjectKey = (key: string): boolean =>
  KEY_SHAPE.test(key) && key.startsWith(SHARED_KEY_PREFIX)

/**
 * Whether this caller may read the object a key names.
 *
 * The shared tier is readable by anyone (that is what makes it a cache); the
 * user tier only by the caller whose uid hashes into the namespace. A key that
 * is malformed, shared-shaped but malformed, or another caller's, is refused
 * by this one predicate.
 * @param {string} uid The verified caller uid.
 * @param {string} key The candidate key.
 * @return {boolean} True when the caller may read it.
 */
export const isReadableObjectKey = (uid: string, key: string): boolean => {
  if (!KEY_SHAPE.test(key)) {
    return false
  }

  return isSharedObjectKey(key) || key.startsWith(userObjectKeyPrefix(uid))
}

/**
 * Whether a shared entry's stored URL may be shown to a caller who did not
 * save it.
 *
 * The shared key is a digest, so it reveals nothing. The `url` metadata does:
 * it is the string some other caller fetched, and that string can BE a
 * capability -- a presigned link, an invite token in a query string, a password
 * in userinfo. Reading it would let a different tenant use it directly, which
 * is worse than reading the cached bytes. So only a URL with no query, no
 * fragment and no userinfo is listed, and an unparseable one is not listed at
 * all: it is not a value this function can vouch for.
 * @param {string} value The stored `url` metadata.
 * @return {boolean} True when nothing in it can act as a capability.
 */
export const isExposableSharedUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)

    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    )
  } catch {
    return false
  }
}

/**
 * A filename safe to store as metadata.
 *
 * Only metadata: the object key is a digest, so this is cosmetic. It still
 * strips separators and control characters, because the value reaches a
 * `Content-Disposition` header on the presigned path and a header is not the
 * place to discover that a filename was attacker-controlled.
 * @param {unknown} value The caller-supplied filename.
 * @return {string|undefined} The cleaned name, or undefined when unusable.
 */
export const sanitizeFilename = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }

  const base = value.trim().split(/[\\/]/).pop() ?? ""
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, MAX_FILENAME_LENGTH)
    .trim()

  return cleaned.length > 0 ? cleaned : undefined
}

/** The outcome of inspecting a credential descriptor. */
type SharedEligibility =
  | {ok: true; egress: string}
  | {ok: false; reason: StorageScopeReason}

/**
 * Whether a credential descriptor positively establishes an anonymous fetch.
 *
 * The order of the checks is the rule, not an implementation detail: the
 * positive assertion is verified LAST, so no branch above it can be skipped by
 * setting `anonymous: true`. Every earlier branch is a reason the descriptor
 * cannot be accounted for, and an unaccounted descriptor loses the shared tier.
 * @param {unknown} credential The raw `credential` field from the request.
 * @return {SharedEligibility} The egress identity, or the refusal reason.
 */
export const sharedEligibility = (credential: unknown): SharedEligibility => {
  if (!isPlainObject(credential)) {
    return {ok: false, reason: "no-descriptor"}
  }

  // An unrecognised field might be carrying a credential and this module cannot
  // tell, so the descriptor is not one it can vouch for. Forward compatibility
  // is the cost, and the cost is a user-tier object, not a leak.
  const unrecognised = Object.keys(credential).some(
    (key) => !RECOGNISED_CREDENTIAL_KEYS.includes(key)
  )
  if (unrecognised) {
    return {ok: false, reason: "unrecognised-field"}
  }

  const material =
    isCredentialMaterial(credential["cookies"]) ||
    isCredentialMaterial(credential["authorization"])

  if (material) {
    return {ok: false, reason: "credentialed"}
  }

  // A caller-supplied proxy IS a per-user credential: it is their exit, on
  // their account, and the bytes may be theirs alone.
  if (credential["proxy"] === "byop") {
    return {ok: false, reason: "byop"}
  }

  if (credential["proxy"] !== "none" && credential["proxy"] !== "platform") {
    return {ok: false, reason: "no-descriptor"}
  }

  const declared = typeof credential["egress"] === "string" ?
    credential["egress"].trim() :
    ""

  // A descriptor that names no exit cannot be accounted for at all.
  if (declared.length === 0) {
    return {ok: false, reason: "missing-egress"}
  }

  // Verified, not trusted. The handler fetches directly, so the only exit a
  // shared object can have been fetched through is `PLATFORM_EGRESS_ID`. Any
  // other declared value names an exit nothing used, and using it as a key
  // component is one URL stored under a fresh key per invented string.
  if (declared !== PLATFORM_EGRESS_ID) {
    return {ok: false, reason: "unverified-egress"}
  }

  if (credential["anonymous"] !== true) {
    return {ok: false, reason: "no-descriptor"}
  }

  // Derived, never echoed: the caller's string was only a claim to check.
  return {ok: true, egress: PLATFORM_EGRESS_ID}
}

/**
 * The single place the shared-vs-user decision is made.
 *
 * Both hosts call this and neither re-decides, so there is one answer to "may
 * this go in the shared cache?" rather than two that can drift.
 * @param {string} uid The verified caller uid.
 * @param {string} url The URL the bytes were (or will be) fetched from.
 * @param {unknown} credential The raw `credential` field from the request.
 * @return {StorageScopeDecision} The scope, the key, and the reason.
 */
export const decideStorageScope = (
  uid: string,
  url: string,
  credential: unknown
): StorageScopeDecision => {
  const eligibility = sharedEligibility(credential)

  if (!eligibility.ok) {
    return {
      scope: "user",
      key: userObjectKey(uid, url),
      reason: eligibility.reason,
    }
  }

  return {
    scope: "shared",
    key: sharedObjectKey(url, eligibility.egress),
    reason: "anonymous",
  }
}
