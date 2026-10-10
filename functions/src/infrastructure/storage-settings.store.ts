/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Where a caller's storage settings live, and where their BYOB credential does.
 *
 * Two stores, deliberately split
 * -----------------------------
 * The MODE and the bucket name are configuration: they are read on every
 * storage request and they are not secrets, so they live in the caller's
 * Firestore document. The ACCESS KEY and SECRET are a third-party credential,
 * so they go to Secret Manager through `upsertSecretValue`, and Firestore
 * holds only the `secretPath` that points at them -- never the value. The split
 * is the same one `gfunctions/user-settings.ts` uses for BYOK keys, for the
 * same reason: a Firestore document is backed up, exported and read by rules,
 * and none of those should be able to surface a credential.
 *
 * `readStorageSettings` composes `hasCredentials` from the pointer's presence
 * and never reads the secret, so the GET route cannot accidentally return it.
 * The one function that does read the secret (`readUserByobCredentials`) is the
 * seam a BYOB adapter calls, and its return type is the credential pair.
 *
 * A BYOB caller is served by `s3-blob-store.ts` through the configuration this
 * module resolves. `resolveBlobStore` still answers null when a caller's
 * settings are INCOMPLETE -- no bucket, no endpoint, no secret, or a secret in
 * an unexpected shape -- and the route turns that into 501 rather than silently
 * writing their bytes into our bucket after they asked for theirs. Null now
 * means "misconfigured", not "unsupported".
 */
import {
  db,
  getSecretFromManager,
  purgeSecretAndAllRevisions,
  upsertSecretValue,
} from "../app/config"
import {
  byobSecretId,
  parseCredentials,
  serializeCredentials,
  toPublicSettings,
  type StorageCredentials,
  type StorageMode,
  type StorageSettingsPublic,
  type StorageSettingsWrite,
} from "../domain/storage-settings.domain"
import type {StorageScope} from "../domain/storage-scope.domain"
import type {BlobStore} from "./blob-store.port"
import {getByobBlobStore, getPlatformBlobStore} from "./platform-blob-store"
import type {S3BucketConfig} from "./s3-blob-store"

/**
 * The caller's storage settings document.
 * @param {string} uid The verified caller uid.
 * @return {*} The Firestore document reference.
 */
const settingsRef = (uid: string) =>
  db.collection("users").doc(uid).collection("storage").doc("settings")

/** The document's fields, as read. All untrusted: Firestore is a store, not a
 * validator, and a hand-edited or legacy document must not become a mode.
 */
type StoredSettingsDoc = {
  mode?: unknown
  bucket?: unknown
  endpoint?: unknown
  region?: unknown
  secretPath?: unknown
}

/** What a caller with no document at all has. */
const DEFAULT_SETTINGS: StorageSettingsPublic = {
  mode: "platform",
  hasCredentials: false,
}

/** One settings read, without the secret.
 * @param {string} uid The verified caller uid.
 * @return {Promise<StorageSettingsPublic>} The public settings.
 */
export const readStorageSettings = async (
  uid: string
): Promise<StorageSettingsPublic> => {
  const snapshot = await settingsRef(uid).get()

  if (!snapshot.exists) {
    return toPublicSettings(DEFAULT_SETTINGS)
  }

  const data = (snapshot.data() ?? {}) as StoredSettingsDoc

  // Anything that is not exactly "byob" reads as the platform default, so a
  // corrupt document cannot point a caller at a bucket nobody chose.
  const mode: StorageMode = data.mode === "byob" ? "byob" : "platform"
  const bucket = typeof data.bucket === "string" ? data.bucket : undefined

  return toPublicSettings({
    mode,
    hasCredentials: mode === "byob" && hasSecretPointer(data),
    bucket,
  })
}

/** True when the document records a Secret Manager pointer, in any shape.
 * @param {StoredSettingsDoc} data The settings document.
 * @return {boolean} Whether a credential is on record.
 */
const hasSecretPointer = (data: StoredSettingsDoc): boolean =>
  typeof data.secretPath === "string" && data.secretPath.trim().length > 0

/**
 * Persist one validated settings write.
 *
 * The secret is written BEFORE the pointer, so a crash between the two leaves
 * an orphaned secret rather than a mode that claims credentials it cannot load.
 * The returned projection has no field a credential could occupy, so this
 * function physically cannot echo what it just stored.
 * @param {string} uid The verified caller uid.
 * @param {StorageSettingsWrite} write The validated write.
 * @return {Promise<StorageSettingsPublic>} The new public settings.
 */
export const writeStorageSettings = async (
  uid: string,
  write: StorageSettingsWrite
): Promise<StorageSettingsPublic> => {
  if (write.mode === "platform") {
    // The pointer is read BEFORE the write that removes it. After the `set`
    // below nothing records which secret this caller's credentials went to, so
    // the value would sit in Secret Manager forever with no way to find it --
    // and "I removed my key" would be untrue.
    const existing = await settingsRef(uid).get()
    const priorPath = (existing.data() as StoredSettingsDoc | undefined)
      ?.secretPath

    const {FieldValue} = await import("firebase-admin/firestore")

    await settingsRef(uid).set(
      {
        mode: "platform",
        secretPath: FieldValue.delete(),
        updatedAt: Date.now(),
      },
      {merge: true}
    )

    // Best-effort. The mode change is already committed, so failing the request
    // here would report an error for a change that DID take effect; a value
    // that survives is merely unreferenced rather than readable.
    if (typeof priorPath === "string" && priorPath.length > 0) {
      try {
        await purgeSecretAndAllRevisions(priorPath)
      } catch (error) {
        console.warn(
          "storage: could not purge the BYOB secret:",
          error instanceof Error ? error.name : typeof error
        )
      }
    }

    return toPublicSettings({mode: "platform", hasCredentials: false})
  }

  const secretPath = await upsertSecretValue(
    byobSecretId(uid),
    serializeCredentials(write.credentials)
  )

  await settingsRef(uid).set(
    {
      mode: "byob",
      bucket: write.bucket,
      endpoint: write.endpoint,
      secretPath,
      updatedAt: Date.now(),
    },
    {merge: true}
  )

  return toPublicSettings({
    mode: "byob",
    hasCredentials: true,
    bucket: write.bucket,
  })
}

/**
 * The caller's BYOB credential pair, for an adapter to sign with.
 *
 * The ONLY function that reads the secret. Null when there is no pointer, when
 * the secret was purged, or when the payload is not the expected shape -- so a
 * signed request is never built with an empty access key.
 * @param {string} uid The verified caller uid.
 * @return {Promise<StorageCredentials | null>} The pair, or null.
 */
export const readUserByobCredentials = async (
  uid: string
): Promise<StorageCredentials | null> => {
  const snapshot = await settingsRef(uid).get()

  if (!snapshot.exists) {
    return null
  }

  const data = (snapshot.data() ?? {}) as StoredSettingsDoc
  if (!hasSecretPointer(data)) {
    return null
  }

  const raw = await getSecretFromManager(data.secretPath as string)
  return parseCredentials(raw)
}

/**
 * The caller's BYOB bucket as an S3 configuration, or null.
 *
 * Re-read here rather than reused from `readStorageSettings`, because that
 * projection deliberately omits the endpoint -- the GET route has no business
 * returning it -- while a signer needs it.
 *
 * The credential is fetched through `readUserByobCredentials` rather than read
 * inline, at the cost of one extra document read. That is deliberate: keeping
 * exactly ONE function that touches the stored secret is what makes "who can
 * read a caller's key?" answerable by search rather than by audit.
 *
 * Null for every incomplete state -- no document, wrong mode, blank bucket or
 * endpoint, missing secret, or a secret in an unexpected shape -- so a request
 * is never signed against a half-configured target.
 * @param {string} uid The verified caller uid.
 * @return {Promise<S3BucketConfig | null>} The configuration, or null.
 */
const byobConfigFor = async (uid: string): Promise<S3BucketConfig | null> => {
  const snapshot = await settingsRef(uid).get()

  if (!snapshot.exists) {
    return null
  }

  const data = (snapshot.data() ?? {}) as StoredSettingsDoc

  if (data.mode !== "byob") {
    return null
  }

  const bucket = typeof data.bucket === "string" ? data.bucket.trim() : ""
  const endpoint =
    typeof data.endpoint === "string" ? data.endpoint.trim() : ""

  if (bucket.length === 0 || endpoint.length === 0) {
    return null
  }

  const credentials = await readUserByobCredentials(uid)
  if (!credentials) {
    return null
  }

  // `auto` is what Tigris expects and what the other S3-compatible providers
  // this path targets accept. A provider needing its real region (AWS S3
  // proper) wants a `region` field on the settings document -- the read below
  // already honours one when present, so adding that field to the API and the
  // settings form needs no change here.
  const storedRegion =
    typeof data.region === "string" ? data.region.trim() : ""

  return {
    bucket,
    endpoint,
    region: storedRegion.length > 0 ? storedRegion : "auto",
    accessKeyId: credentials.accessKey,
    secretAccessKey: credentials.secretKey,
  }
}

/**
 * The store a save or a list should use, or null when the caller's tier has no
 * adapter.
 *
 * A SHARED object always goes to the platform bucket, whatever the caller's
 * setting says: the shared tier is readable by everyone, and a caller's private
 * bucket cannot host it -- so a shared write ignores `mode` entirely.
 *
 * A USER object goes wherever the caller configured. A BYOB caller whose
 * settings are incomplete still gets null rather than the platform bucket,
 * because substituting would write their private bytes into a bucket they
 * explicitly did not choose; the route turns that null into a 501 rather than
 * a silent write to the wrong place.
 * @param {string} uid The verified caller uid.
 * @param {StorageScope} scope The decided scope.
 * @return {Promise<BlobStore | null>} The store, or null.
 */
export const resolveBlobStore = async (
  uid: string,
  scope: StorageScope
): Promise<BlobStore | null> => {
  if (scope === "shared") {
    return getPlatformBlobStore()
  }

  const settings = await readStorageSettings(uid)
  if (settings.mode === "platform") {
    return getPlatformBlobStore()
  }

  const config = await byobConfigFor(uid)
  return config ? getByobBlobStore(config) : null
}
