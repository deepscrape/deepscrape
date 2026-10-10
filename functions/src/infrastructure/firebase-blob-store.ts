/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The `firebase-admin` Storage adapter for `blob-store.port.ts`.
 *
 * Why this still exists now that Tigris does
 * ------------------------------------------
 * `firebase-admin` is already a dependency and already initialised
 * (`app/config.ts`), so this adapter needs no extra dependency, no credential
 * and no second initialisation path. It is now the FALLBACK: when
 * `TIGRIS_BUCKET` is set the platform store is the S3 adapter
 * (`s3-blob-store.ts`), and this one answers only for a deployment that has not
 * migrated yet, or a local run with no Tigris credentials. Keeping it is what
 * makes the migration reversible -- a deployment that sets an env var moves,
 * and one that clears it moves back, with nothing above the port changing.
 *
 * Reversal is safe in one direction only, and worth stating: objects written to
 * GCS are not in Tigris and vice versa, so clearing the variable after writing
 * artifacts makes them unreachable rather than merely slower.
 *
 * The bucket is named explicitly rather than left to the SDK's default: the
 * deployment may set `STORAGE_BUCKET`, and falling back to
 * `${GCP_PROJECT_ID}.appspot.com` keeps the local and emulator cases working
 * without a hard-coded project name in the source.
 */
import * as admin from "firebase-admin"
import { env } from "../config/env"
import type { BlobStore, PutOptions, StoredBlob } from "./blob-store.port"

// Bun ESM does not surface firebase-admin's legacy CJS namespace through
// `import *`, so `admin.storage()` was undefined at runtime while typing as
// present. The CJS exports object is reachable as `.default`, and under
// tsc/CommonJS the namespace IS the exports -- the same resolution
// `app/config.ts` uses for `apps`/`firestore()`.
const adminNs = (admin as unknown as {default?: typeof admin}).default ?? admin

/** The metadata fields this adapter reads, structurally typed. */
type BlobMetadata = {
  size?: string | number
  contentType?: string
  timeCreated?: string
  metadata?: Record<string, unknown>
}

/**
 * The bucket artifacts are stored in.
 *
 * `STORAGE_BUCKET` wins when set; otherwise the appspot default for the
 * configured project. Undefined when neither is known, which hands the choice
 * to the SDK rather than inventing a bucket name.
 * @return {string|undefined} The bucket name.
 */
export const resolveBucketName = (): string | undefined => {
  const configured = env.STORAGE_BUCKET.trim()
  if (configured.length > 0) {
    return configured
  }

  const project = env.GCP_PROJECT_ID.trim()
  return project.length > 0 ? `${project}.appspot.com` : undefined
}

/** True for the GCS "no such object" answer, in either code spelling.
 * @param {unknown} error The thrown value.
 * @return {boolean} Whether the object is absent.
 */
const isNotFound = (error: unknown): boolean => {
  const code = (error as {code?: unknown} | null)?.code
  return code === 404 || code === "404"
}

/** Only the string-valued custom metadata, so a backend that coerces does not
 * leak a non-string into a response.
 * @param {unknown} value The raw `metadata.metadata` map.
 * @return {Record<string, string>} The string-valued subset.
 */
const toStringMap = (value: unknown): Record<string, string> => {
  const result: Record<string, string> = {}

  if (typeof value !== "object" || value === null) {
    return result
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry
    }
  }

  return result
}

/** One object's metadata as the port's record.
 * @param {string} key The object key.
 * @param {BlobMetadata} metadata The backend's metadata.
 * @return {StoredBlob} The port's record.
 */
const toStoredBlob = (key: string, metadata: BlobMetadata): StoredBlob => {
  const blob: StoredBlob = {
    key,
    bytes: Number(metadata.size ?? 0) || 0,
    custom: toStringMap(metadata.metadata),
  }

  if (typeof metadata.contentType === "string" && metadata.contentType) {
    blob.contentType = metadata.contentType
  }

  return blob
}

/** The bucket handle, resolved once per process.
 * @return {*} The GCS bucket.
 */
const bucket = () => {
  const storage = adminNs.storage()
  const name = resolveBucketName()
  return name ? storage.bucket(name) : storage.bucket()
}

let cachedStore: BlobStore | null = null

/**
 * The platform bucket as a `BlobStore` -- the GCS implementation.
 *
 * Named for the backend, not for the role: "the platform bucket" is now a
 * choice between this and Tigris, and that choice lives in
 * `platform-blob-store.ts`. A caller asking for the platform store wants the
 * dispatcher; only the dispatcher wants this.
 *
 * Lazy and cached: resolving the bucket at module load would call into the
 * Admin SDK during import, which is exactly the failure mode `app/config.ts`
 * documents for `__dirname`. Cached because the adapter holds no per-request
 * state -- the store is the bucket, not the caller.
 * @return {BlobStore} The shared adapter instance.
 */
export const getGcsBlobStore = (): BlobStore => {
  if (cachedStore) {
    return cachedStore
  }

  const bucketRef = bucket()

  const store: BlobStore = {
    put: async (key: string, body: Buffer, options?: PutOptions) => {
      const custom = options?.custom ?? {}
      const cacheSeconds = options?.cacheSeconds

      // Never a public cache directive: these objects are reached through
      // presigned URLs, and a shared cache holding a user-tier object is a
      // leak that no access check can undo. `cacheControl` is a file-metadata
      // field, not a save option, so it travels inside `metadata`.
      await bucketRef.file(key).save(body, {
        resumable: false,
        contentType: options?.contentType,
        metadata: {
          contentType: options?.contentType,
          cacheControl: typeof cacheSeconds === "number" ?
            `private, max-age=${cacheSeconds}` :
            "private, no-store",
          metadata: custom,
        },
      })
    },

    stat: async (key: string): Promise<StoredBlob | null> => {
      try {
        const [metadata] = await bucketRef.file(key).getMetadata()
        return toStoredBlob(key, metadata as unknown as BlobMetadata)
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }
        throw error
      }
    },

    list: async (prefix: string, limit: number): Promise<StoredBlob[]> => {
      const [files] = await bucketRef.getFiles({
        prefix,
        maxResults: limit,
        autoPaginate: false,
      })

      const records: StoredBlob[] = []

      for (const file of files) {
        // `getFiles` assigns the list response's item to `file.metadata`, so
        // this is usually free. The fallback covers a backend or a projection
        // that returns only names, and keeps `list` from reporting 0 bytes for
        // everything rather than admitting it does not know.
        const listed = file.metadata as unknown as BlobMetadata
        const metadata = listed && listed.size !== undefined ?
          listed :
          (await file.getMetadata())[0] as unknown as BlobMetadata

        records.push(toStoredBlob(file.name, metadata))
      }

      return records
    },

    delete: async (key: string): Promise<void> => {
      try {
        await bucketRef.file(key).delete()
      } catch (error) {
        // Absent is the state we wanted, so a retried purge is not an error.
        // Anything else -- permissions, transport -- must surface, because a
        // silent failure here leaves a caller's bytes where they should not be.
        if (isNotFound(error)) {
          return
        }
        throw error
      }
    },

    signedUrl: async (key: string, ttlSeconds: number): Promise<string> => {
      const [url] = await bucketRef.file(key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + ttlSeconds * 1000,
      })
      return url
    },
  }

  cachedStore = store
  return cachedStore
}
