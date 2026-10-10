/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The BYOB settings shape, validated once and projected once.
 *
 * Why the validation is here rather than in the handler
 * ----------------------------------------------------
 * Two things must never be true at the same time, and they are both decided by
 * the same body:
 *
 *  1. `mode: "byob"` with credentials that are absent or malformed. The store
 *     would then hold a mode pointing at a bucket nothing can reach, and every
 *     later request fails with an error that names the wrong cause.
 *  2. Credentials reaching a response. The only shape that leaves this module
 *     is `StorageSettingsPublic`, which has no field a secret could occupy --
 *     so "did we leak the key?" is answered by the type, not by review.
 *
 * `mode: "platform"` REFUSES credential fields rather than ignoring them.
 * Silently dropping them would tell the caller their bucket was configured
 * while their bytes continued to land in ours.
 */

/** Which bucket a caller's artifacts go to. */
export type StorageMode = "platform" | "byob"

/** The third-party credential pair, as stored and as replayed. */
export type StorageCredentials = {
  accessKey: string
  secretKey: string
}

/** A validated settings write. */
export type StorageSettingsWrite =
  | {mode: "platform"}
  | {
      mode: "byob"
      bucket: string
      endpoint: string
      credentials: StorageCredentials
    }

/** What the store holds and what the GET route may answer. */
export type StorageSettingsPublic = {
  mode: StorageMode
  hasCredentials: boolean
  bucket?: string
}

/** A validation failure, named so the route can answer a fixed code. */
export type StorageSettingsError =
  | "invalid_body"
  | "invalid_mode"
  | "credentials_not_allowed"
  | "missing_credentials"
  | "invalid_bucket"
  | "invalid_endpoint"
  | "credential_too_long"

/**
 * Where a BYOB credential is stored: one Secret Manager id per caller.
 *
 * Deterministic and uid-scoped, so a save and a later read agree without the
 * name being stored twice, and one account's secret is not addressable from
 * another account's request.
 * @param {string} uid The verified caller uid.
 * @return {string} The Secret Manager secret id.
 */
export const byobSecretId = (uid: string): string => `storage-byob-${uid}`

/** The S3-compatible bucket-name rules: lowercase, 3-63 characters. */
const BUCKET_SHAPE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

/** Upper bounds, so a request cannot write an unbounded secret. */
const MAX_ACCESS_KEY_LENGTH = 256
const MAX_SECRET_KEY_LENGTH = 1024

/** A field that carries nothing: absent, null, or whitespace.
 * @param {unknown} value The candidate.
 * @return {boolean} Whether it is empty.
 */
const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "")

/** The trimmed string, or undefined for a blank or non-string value.
 * @param {unknown} value The candidate.
 * @return {string|undefined} The trimmed value.
 */
const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

/**
 * Whether `endpoint` is an https origin and nothing more.
 *
 * https only: an http endpoint would carry the credential pair in clear, and
 * this field is the one place the caller names where their secret is sent.
 * @param {string} endpoint The candidate endpoint.
 * @return {boolean} True when it may be stored.
 */
export const isAcceptableEndpoint = (endpoint: string): boolean => {
  try {
    return new URL(endpoint).protocol === "https:"
  } catch {
    return false
  }
}

/**
 * The validated write, or the reason it was refused.
 *
 * Never returns a partially-validated object: a caller that gets `ok` can write
 * every field it holds without a second check, which is what keeps the "mode
 * set, credentials missing" state unreachable.
 * @param {unknown} body The raw request body.
 * @return {*} The write, or a named error.
 */
export const validateStorageSettingsInput = (
  body: unknown
): {ok: true; value: StorageSettingsWrite} | {ok: false; error: StorageSettingsError} => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {ok: false, error: "invalid_body"}
  }

  const record = body as Record<string, unknown>
  const mode = trimmed(record["mode"])

  if (mode !== "platform" && mode !== "byob") {
    return {ok: false, error: "invalid_mode"}
  }

  const bucket = trimmed(record["bucket"])
  const endpoint = trimmed(record["endpoint"])
  const accessKey = trimmed(record["accessKey"])
  const secretKey = trimmed(record["secretKey"])

  if (mode === "platform") {
    const supplied = [bucket, endpoint, accessKey, secretKey].some(
      (value) => !isBlank(value)
    )
    if (supplied) {
      return {ok: false, error: "credentials_not_allowed"}
    }

    return {ok: true, value: {mode: "platform"}}
  }

  if (!bucket || !BUCKET_SHAPE.test(bucket)) {
    return {ok: false, error: "invalid_bucket"}
  }

  if (!endpoint || !isAcceptableEndpoint(endpoint)) {
    return {ok: false, error: "invalid_endpoint"}
  }

  if (!accessKey || !secretKey) {
    return {ok: false, error: "missing_credentials"}
  }

  if (
    accessKey.length > MAX_ACCESS_KEY_LENGTH ||
    secretKey.length > MAX_SECRET_KEY_LENGTH
  ) {
    return {ok: false, error: "credential_too_long"}
  }

  return {
    ok: true,
    value: {mode: "byob", bucket, endpoint, credentials: {accessKey, secretKey}},
  }
}

/**
 * The credential pair as one secret payload.
 *
 * One secret rather than two: the pair is only ever read together, and one
 * `getSecretFromManager` call is one round trip instead of two on a path that
 * runs before every BYOB write.
 * @param {StorageCredentials} credentials The validated pair.
 * @return {string} JSON to hand to Secret Manager.
 */
export const serializeCredentials = (credentials: StorageCredentials): string =>
  JSON.stringify({
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
  })

/**
 * The credential pair out of a stored secret payload, or null.
 *
 * Null for any other shape, including a legacy or hand-edited value, so a
 * malformed secret degrades to "no credentials" rather than to a request
 * signed with an empty string.
 * @param {unknown} raw The value read back from Secret Manager.
 * @return {StorageCredentials | null} The pair, or null.
 */
export const parseCredentials = (raw: unknown): StorageCredentials | null => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const accessKey = trimmed(parsed["accessKey"])
    const secretKey = trimmed(parsed["secretKey"])

    return accessKey && secretKey ? {accessKey, secretKey} : null
  } catch {
    return null
  }
}

/**
 * The only settings shape that may reach a client.
 *
 * Typed with no credential field, so the projection is enforced by the
 * compiler rather than by remembering. `bucket` is included because it is the
 * caller's own configuration and not a secret; the endpoint and the pair are
 * not.
 * @param {StorageSettingsPublic} settings The stored state.
 * @return {StorageSettingsPublic} The public projection.
 */
export const toPublicSettings = (
  settings: StorageSettingsPublic
): StorageSettingsPublic => {
  const projected: StorageSettingsPublic = {
    mode: settings.mode,
    hasCredentials: settings.hasCredentials,
  }

  if (settings.bucket) {
    projected.bucket = settings.bucket
  }

  return projected
}
