/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The blob-storage port.
 *
 * Why a port rather than calling `bucket.file(...)` in the handler
 * ---------------------------------------------------------------
 * The backing store is a choice, and it is now made in two places: the platform
 * bucket is Tigris when `TIGRIS_BUCKET` is set and GCS otherwise
 * (`platform-blob-store.ts`), and a BYOB caller gets their own S3 bucket
 * (`s3-blob-store.ts`). A handler that named a bucket API could not answer both
 * without editing every call site, so the call sites name this instead and the
 * decision stays in the adapters -- which is what let the platform backend move
 * from GCS to Tigris without touching a single handler.
 *
 * The surface is deliberately small and credential-free: keys in, bytes and
 * metadata out, plus a presigned read. Nothing here knows what a "scope" is or
 * which prefix belongs to whom -- that is `domain/storage-scope.domain.ts`, and
 * keeping it out of the port is what lets an S3 adapter be written without
 * re-deciding the tenancy rule.
 *
 * `custom` is the extension point. A backend that has no object-metadata
 * concept stores it beside the object; the only requirement is that `put` and
 * `list`/`stat` agree, so a caller can round-trip `url`, `scope` and
 * `createdAt` without this file naming any of them.
 */

/** One stored object as the port reports it. */
export type StoredBlob = {
  /** The object key, exactly as passed to `put`. */
  key: string
  /** Size in bytes, 0 when the backend did not report one. */
  bytes: number
  /** The media type, when one was recorded. */
  contentType?: string
  /** Free-form metadata set at `put` time and read back here. */
  custom: Record<string, string>
}

/** Options for one `put`. */
export type PutOptions = {
  contentType?: string
  custom?: Record<string, string>
  /** Seconds the object may be cached; the backend's default when absent. */
  cacheSeconds?: number
}

/**
 * The port. One implementation per backing store.
 *
 * `stat` answers `null` for an absent object rather than throwing, because
 * "not there yet" is the ordinary case on the cache path and not an error.
 */
export interface BlobStore {
  /**
   * Write an object, replacing any object at that key.
   * @param {string} key The object key.
   * @param {Buffer} body The bytes.
   * @param {PutOptions} options Content type and custom metadata.
   * @return {Promise<void>} Resolves once the object is durable.
   */
  put(key: string, body: Buffer, options?: PutOptions): Promise<void>

  /**
   * The object's metadata, or null when it does not exist.
   * @param {string} key The object key.
   * @return {Promise<StoredBlob | null>} The record, or null.
   */
  stat(key: string): Promise<StoredBlob | null>

  /**
   * The object's bytes, or null when it does not exist.
   *
   * A READ rather than a presigned URL: a URL is a credential with a lifetime,
   * and minting one for a server-side caller that already holds the store's own
   * credentials would add a secret to the request path for nothing. Same
   * absent-is-not-an-error rule as `stat`.
   * @param {string} key The object key.
   * @return {Promise<Buffer | null>} The bytes, or null.
   */
  get(key: string): Promise<Buffer | null>

  /**
   * Up to `limit` objects under `prefix`.
   * @param {string} prefix The key prefix.
   * @param {number} limit The maximum number of objects to return.
   * @return {Promise<StoredBlob[]>} The records, unordered.
   */
  list(prefix: string, limit: number): Promise<StoredBlob[]>

  /**
   * Delete one object. Absent is SUCCESS, not an error.
   *
   * Erasure is the caller, and it has to be re-runnable: `purgeOneAccount` is a
   * scheduled job that may be retried after a partial run, so a second pass over
   * an object it already removed must not throw. Both adapters enforce that --
   * S3 `DeleteObject` is idempotent by specification, and the GCS adapter treats
   * NOT_FOUND as done.
   * @param {string} key The object key.
   * @return {Promise<void>} Resolves once the object is gone.
   */
  delete(key: string): Promise<void>

  /**
   * A short-lived URL that reads one object.
   * @param {string} key The object key.
   * @param {number} ttlSeconds How long the URL stays valid.
   * @return {Promise<string>} The signed URL.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string>
}
