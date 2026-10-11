import { createHash } from "node:crypto"

/**
 * How a presented platform API key finds its owner.
 *
 * The hole this fills
 * -------------------
 * A key's metadata lives at `users/{uid}/apikeys/{docId}` and its value in
 * Secret Manager under a name derived from `uid + docId`. So the key was
 * UNGUESSABLE BUT UNLOOKUPABLE: nothing could go from a presented `dpsp-key-…`
 * back to the uid that minted it, which is why the verification half of this
 * feature was never written. An index is the missing direction, not a nicety.
 *
 * Why the digest, and why the WHOLE key
 * ------------------------------------
 * The index document id is a SHA-256 of the entire key, hex. Hashing is
 * the point:
 * a lookup table that stored the credential would turn a Firestore export into
 * a working set of keys, and the index exists precisely so the credential
 * itself never leaves Secret Manager.
 *
 * Whole-key rather than a prefix or a truncated digest, because either would let
 * `dpsp-key-abc` and `dpsp-key-abcd` collide on the part they share -- two distinct
 * credentials resolving to one owner, which is the worst possible failure here.
 *
 * Pure and dependency-free so both the writer (`app/auth.ts`) and the reader
 * (`infrastructure/syncaiapi.ts`) share one definition. Two copies of a hash is how
 * a key gets written under one digest and looked up under another.
 */

/** The collection a platform key's owner is indexed in. */
export const API_KEY_INDEX_COLLECTION = "apiKeyIndex"

/**
 * What a presentable platform key starts with.
 *
 * The same literal `ApiKeyService.generateApiKey` builds, and the reason a
 * presented token can be classified before any lookup happens.
 */
export const API_KEY_PREFIX = "dpsp-key-"

/**
 * The index document id for a key.
 * @param {string} key The full presented key, prefix included.
 * @return {string} A hex SHA-256 digest.
 */
export const apiKeyIndexId = (key: string): string =>
    createHash("sha256").update(key).digest("hex")

/**
 * Whether a bearer token is a platform key rather than a Firebase ID token.
 *
 * A type predicate, so a caller that narrows on it gets a string rather than
 * having to assert one. Deliberately just a prefix test: classification and
 * verification are separate questions, and a token that merely LOOKS like a key
 * still has to resolve in the index to be worth anything.
 * @param {unknown} token
 * @return {boolean}
 */
export const isPlatformApiKey = (token: unknown): token is string =>
    typeof token === "string" && token.startsWith(API_KEY_PREFIX)
