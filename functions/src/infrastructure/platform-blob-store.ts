/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Which backend "the platform bucket" currently means.
 *
 * Why this exists
 * ---------------
 * The artifact bucket is a choice (Tigris or GCS), and it must be made in one
 * place. Everything above this line -- the scope decision, the handler, the
 * five routes -- asks for "the platform store" and does not care which provider
 * answers, which is exactly what `blob-store.port.ts` was written for.
 *
 * Why the choice is synchronous
 * ----------------------------
 * `createS3BlobStore` builds its S3 client lazily (see that file), so selecting
 * a backend needs no network and no `await`. That keeps this function's
 * signature synchronous and leaves every existing call site alone -- including
 * the two in `handlers/storage.ts` that read the shared prefix.
 *
 * Resolution ORDER, and why it is not a try/catch
 * ----------------------------------------------
 * A configured `TIGRIS_BUCKET` wins outright. It does not fall back to GCS on
 * failure, and `platformTigrisConfig` THROWS when the bucket is named but the
 * credentials are missing. A fallback would be the dangerous shape: a
 * half-migrated deployment would silently keep writing artifacts to GCS while
 * the operator believed they had moved, and the only symptom would be a bill.
 */
import type { BlobStore } from "./blob-store.port"
import { getGcsBlobStore } from "./firebase-blob-store"
import {
  createS3BlobStore,
  platformTigrisConfig,
  type S3BucketConfig,
} from "./s3-blob-store"

/** The last store built, with the configuration it was built from. */
let cached: {signature: string; store: BlobStore} | null = null

/** Whether the "which backend" line has already been logged. */
let announced = false

/**
 * The Tigris store for one configuration, rebuilt only when it changes.
 *
 * The signature includes the credentials so a rotated key produces a new store
 * rather than reusing one still holding the old value. `env` does not change at
 * runtime in production, so in practice this builds exactly once.
 * @param {S3BucketConfig} config The resolved configuration.
 * @return {BlobStore} The adapter.
 */
const tigrisStoreFor = (config: S3BucketConfig): BlobStore => {
  const signature = [
    config.bucket,
    config.endpoint,
    config.region,
    config.accessKeyId,
    config.secretAccessKey,
  ].join("|")

  if (cached && cached.signature === signature) {
    return cached.store
  }

  const store = createS3BlobStore(config)
  cached = {signature, store}
  return store
}

/**
 * The store artifacts go to, per the current configuration.
 *
 * Logs which backend answered, once per process. During a migration the
 * question "is this instance actually on Tigris yet?" is otherwise unanswerable
 * from the outside, and the bucket name is safe to log -- it is not a secret.
 * @return {BlobStore} Either adapter.
 */
export const getPlatformBlobStore = (): BlobStore => {
  const config = platformTigrisConfig()

  if (!config) {
    if (!announced) {
      announced = true
      console.info("[storage-backend] gcs")
    }
    return getGcsBlobStore()
  }

  if (!announced) {
    announced = true
    console.info("[storage-backend] tigris", config.bucket)
  }

  return tigrisStoreFor(config)
}

/**
 * A `BlobStore` for a caller's own S3-compatible bucket.
 *
 * This is the BYOB path, and it is the same adapter as the platform one: an S3
 * client signs against whatever endpoint it is handed, and the caller already
 * supplies the endpoint and the key pair. That is why BYOB stopped answering
 * `501 -- byob_unavailable` the moment an S3 dependency existed: the block was
 * never a tenancy problem, only a missing signer.
 *
 * Deliberately not cached. Credentials rotate, and a stale signer presents as
 * an authentication failure the caller cannot explain or fix.
 * @param {S3BucketConfig} config The caller's bucket and credentials.
 * @return {BlobStore} The adapter.
 */
export const getByobBlobStore = (config: S3BucketConfig): BlobStore =>
  createS3BlobStore(config)
