/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The S3-compatible adapter for `blob-store.port.ts`.
 *
 * One adapter, two callers
 * ------------------------
 * The PLATFORM bucket (Tigris) and a BYOB caller's bucket are the same problem:
 * sign a request against an S3 endpoint with an access key pair. So this file
 * takes its configuration as an argument rather than reading the environment --
 * `platformTigrisConfig` below resolves the platform case, and
 * `storage-settings.store.ts` resolves the caller's. That is also why BYOB
 * stopped answering `501 -- byob_unavailable` once an S3 dependency existed:
 * the block was never tenancy, only a missing signer.
 *
 * Why Tigris holds the platform bucket
 * -----------------------------------
 * Storage costs the same as GCS ($0.02/GB), so price is not the tiebreaker --
 * EGRESS is. GCS bills roughly $0.12/GB out; Tigris bills nothing. Monitor
 * history is re-read on every panel open and every diff check, so egress is the
 * cost that scales with the access pattern this product actually has, and it is
 * the only field where the two differ. Upstash Blob was the other candidate and
 * loses for the same reason: its 1 TB/month allowance is a bill that grows with
 * reads.
 *
 * THE PLATFORM BUCKET IS PRIVATE
 * ------------------------------
 * `image-cdn-a.deepscrape.dev` is a public asset CDN and is NOT this bucket.
 * A public bucket serves any object to anyone holding the key, which would
 * defeat `domain/storage-scope.domain.ts` completely -- bucket policy outranks
 * application logic, so the careful `anonymous === true` check upstream would
 * still leak every user-tier object. Public assets and private artifacts are
 * two buckets with two delivery models: this one is reached only through
 * short-lived presigned URLs, and a public asset needs a stable unsigned URL
 * that this port deliberately cannot produce.
 *
 * Why the SDK is loaded lazily
 * ---------------------------
 * `@aws-sdk/client-s3` is a large module, and this file is in the import graph
 * of `handlers/index.ts` -- so a static import would be paid on EVERY cold
 * start, including the ones that never touch storage. `loadSdk` defers it to
 * the first storage operation. The store factories stay synchronous as a
 * result, which is what keeps the existing call sites unchanged.
 *
 * Metadata is ASCII-encoded because S3 is
 * ---------------------------------------
 * S3 user metadata must survive an HTTP header round trip, and a non-ASCII
 * value (an IDN or unencoded URL) either mangles or is rejected. Object
 * metadata is where `url` lives, so this encodes any non-ASCII value with a
 * sentinel and decodes it on read -- transparently, so the port's contract
 * ("what `put` wrote, `list`/`stat` read back") holds exactly as it does for
 * the GCS adapter.
 */
import { env } from "../config/env"
import type { BlobStore, PutOptions, StoredBlob } from "./blob-store.port"

/** The module namespaces, named so the lazy types do not re-import. */
type S3Module = typeof import("@aws-sdk/client-s3")
type PresignerModule = typeof import("@aws-sdk/s3-request-presigner")

/** One resolved SDK pair. */
type S3Sdk = {
  mod: S3Module
  presigner: PresignerModule
}

/** A constructed client, derived from the SDK rather than re-declared. */
type S3ClientInstance = InstanceType<S3Module["S3Client"]>

/** One bucket and the credentials to sign for it. */
export type S3BucketConfig = {
  bucket: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * How many metadata reads one `list` may have in flight.
 *
 * `ListObjectsV2` returns key, size and timestamp but NOT user metadata, so
 * `custom` needs a HEAD per object. Bounded rather than unbounded so a 100-key
 * listing opens a predictable number of sockets.
 */
const LIST_CONCURRENCY = 8

/** Marks a metadata value that is base64 rather than literal ASCII. */
const B64_PREFIX = "~b64~"

/** The region name Tigris expects. It routes internally, so there is one. */
const DEFAULT_REGION = "auto"

/** The raw platform values, before validation. */
export type TigrisEnvValues = {
  bucket: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * The platform configuration for a set of raw values, or null when unset.
 *
 * Three states, and the middle one THROWS on purpose. An empty bucket name
 * means "not configured" and the caller falls back to GCS, which is a
 * deployment that has not migrated yet. But a NAMED bucket with missing
 * credentials is a misconfiguration, and falling back would write artifacts
 * into a bucket the operator explicitly stopped choosing -- the same silent
 * substitution `resolveBlobStore` refuses to make for a BYOB caller.
 *
 * Split from the environment read so all three states are testable: `env` is
 * resolved once at module load, so a test that mutates `process.env` afterwards
 * would still see the original values, and the throwing branch -- the one that
 * most needs pinning -- would be unreachable.
 * @param {TigrisEnvValues} values The raw values.
 * @return {S3BucketConfig | null} The configuration, or null when unset.
 */
export const tigrisConfigFrom = (
  values: TigrisEnvValues
): S3BucketConfig | null => {
  const bucket = values.bucket.trim()

  if (bucket.length === 0) {
    return null
  }

  const missing: string[] = []
  if (values.endpoint.trim().length === 0) {
    missing.push("TIGRIS_ENDPOINT")
  }
  if (values.accessKeyId.trim().length === 0) {
    missing.push("TIGRIS_ACCESS_KEY_ID")
  }
  if (values.secretAccessKey.trim().length === 0) {
    missing.push("TIGRIS_SECRET_ACCESS_KEY")
  }

  if (missing.length > 0) {
    throw new Error(
      `TIGRIS_BUCKET is set but ${missing.join(", ")} is not. Refusing to ` +
      "fall back to another bucket: artifacts would land somewhere the " +
      "operator explicitly stopped choosing."
    )
  }

  return {
    bucket,
    endpoint: values.endpoint.trim(),
    region: values.region.trim() || DEFAULT_REGION,
    accessKeyId: values.accessKeyId.trim(),
    secretAccessKey: values.secretAccessKey.trim(),
  }
}

/**
 * The platform bucket's configuration, from the environment.
 * @return {S3BucketConfig | null} The configuration, or null when unset.
 */
export const platformTigrisConfig = (): S3BucketConfig | null =>
  tigrisConfigFrom({
    bucket: env.TIGRIS_BUCKET,
    endpoint: env.TIGRIS_ENDPOINT,
    region: env.TIGRIS_REGION,
    accessKeyId: env.TIGRIS_ACCESS_KEY_ID,
    secretAccessKey: env.TIGRIS_SECRET_ACCESS_KEY,
  })

/** Whether the platform bucket is configured at all.
 * @return {boolean} True when a Tigris bucket name is set.
 */
export const isTigrisConfigured = (): boolean =>
  env.TIGRIS_BUCKET.trim().length > 0

let sdkPromise: Promise<S3Sdk> | null = null

/**
 * The AWS SDK modules, imported on first use and cached after.
 *
 * A failed load clears the cache so a transient resolution error can be retried
 * rather than poisoning every later call with the same rejected promise.
 * @return {Promise<S3Sdk>} The SDK namespaces.
 */
const loadSdk = (): Promise<S3Sdk> => {
  if (!sdkPromise) {
    sdkPromise = (async (): Promise<S3Sdk> => {
      const [mod, presigner] = await Promise.all([
        import("@aws-sdk/client-s3"),
        import("@aws-sdk/s3-request-presigner"),
      ])
      return {mod, presigner}
    })().catch((error: unknown) => {
      sdkPromise = null
      throw error
    })
  }

  return sdkPromise
}

/** Clients, keyed by the connection facts that build one. */
let clientCache: Map<string, S3ClientInstance> | null = null

/**
 * The client for one configuration, reused across calls.
 *
 * The key includes the secret, so a rotated credential yields a new client
 * instead of reusing one still holding the old value. This map is process-local
 * and a client already holds the same secret in memory, so nothing here is a
 * new exposure -- it only prevents a stale signer.
 * @param {S3BucketConfig} config The connection facts.
 * @return {Promise<S3ClientInstance>} The client.
 */
const clientFor = async (config: S3BucketConfig): Promise<S3ClientInstance> => {
  const {mod} = await loadSdk()

  if (!clientCache) {
    clientCache = new Map()
  }

  const cacheKey = [
    config.bucket,
    config.endpoint,
    config.region,
    config.accessKeyId,
    config.secretAccessKey,
  ].join("|")

  const cached = clientCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const client = new mod.S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })

  clientCache.set(cacheKey, client)
  return client
}

/** Whether every character is in the ASCII range S3 metadata tolerates.
 * @param {string} value The candidate.
 * @return {boolean} True when it needs no encoding.
 */
const isAscii = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) {
      return false
    }
  }
  return true
}

/** One metadata value in a shape S3 will round-trip.
 * @param {string} value The value.
 * @return {string} ASCII, or a sentinel-prefixed encoding.
 */
const encodeMetaValue = (value: string): string =>
  isAscii(value) ?
    value :
    B64_PREFIX + Buffer.from(value, "utf8").toString("base64")

/**
 * The original value, undoing `encodeMetaValue`.
 *
 * The payload is re-encoded and compared before it is trusted. A value that
 * merely STARTS with the sentinel -- an ordinary URL never does, but "never" is
 * not "cannot" -- would otherwise be silently cut into nonsense, and the record
 * would still look well-formed.
 * @param {string} value The stored value.
 * @return {string} The original.
 */
const decodeMetaValue = (value: string): string => {
  if (!value.startsWith(B64_PREFIX)) {
    return value
  }

  const encoded = value.slice(B64_PREFIX.length)
  const bytes = Buffer.from(encoded, "base64")

  // Canonical base64 only. `Buffer.from` ignores stray characters and accepts
  // a short tail, so a near-miss decodes to plausible-looking garbage rather
  // than failing -- which is exactly the case that would corrupt a URL quietly.
  if (bytes.toString("base64") !== encoded) {
    return value
  }

  const decoded = bytes.toString("utf8")

  // A corrupt payload decodes to replacement characters. Returning the literal
  // is more honest than returning mojibake that looks like a real URL.
  return decoded.includes("\uFFFD") ? value : decoded
}

/**
 * Every custom value, encoded.
 *
 * Exported for the round-trip test. This pair is the only place the port's
 * "what `put` wrote, `list`/`stat` read back" promise can break silently: a
 * value that encodes but does not decode loses a URL with no error raised
 * anywhere, and the record still looks well-formed.
 * @param {Record<string, string>} custom The caller's metadata.
 * @return {Record<string, string>} The encoded map.
 */
export const encodeMetadata = (
  custom: Record<string, string>
): Record<string, string> => {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(custom)) {
    result[key] = encodeMetaValue(value)
  }

  return result
}

/**
 * Every string-valued custom field, decoded. Non-strings are dropped rather
 * than coerced, so a backend that returns a number cannot become a "url".
 * @param {unknown} metadata The raw `Metadata` map.
 * @return {Record<string, string>} The decoded map.
 */
export const decodeMetadata = (metadata: unknown): Record<string, string> => {
  const result: Record<string, string> = {}

  if (typeof metadata !== "object" || metadata === null) {
    return result
  }

  for (const [key, value] of Object.entries(
    metadata as Record<string, unknown>
  )) {
    if (typeof value === "string") {
      result[key] = decodeMetaValue(value)
    }
  }

  return result
}

/** True for the S3 "no such object" answers, in any spelling.
 * @param {unknown} error The thrown value.
 * @return {boolean} Whether the object is absent.
 */
const isNotFound = (error: unknown): boolean => {
  const named = error as {
    name?: unknown
    $metadata?: {httpStatusCode?: unknown}
  } | null

  if (named?.name === "NotFound" || named?.name === "NoSuchKey") {
    return true
  }

  return named?.$metadata?.httpStatusCode === 404
}

/** A byte count from a field the SDK may type as a number or a string.
 * @param {unknown} value The raw length.
 * @return {number} The count, 0 when unusable.
 */
const toBytes = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Map over `items` with at most `limit` workers running at once.
 *
 * Index-addressed rather than `slice`-and-`Promise.all`, so the result keeps
 * the caller's ordering regardless of which worker finishes first.
 * @param {T[]} items The work.
 * @param {number} limit The maximum concurrency.
 * @param {*} worker The per-item async function.
 * @return {Promise<R[]>} The results, in input order.
 */
const mapWithLimit = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length)
  const width = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners: Promise<void>[] = []

  for (let index = 0; index < width; index += 1) {
    runners.push((async (): Promise<void> => {
      for (;;) {
        const current = cursor
        cursor += 1

        if (current >= items.length) {
          return
        }

        results[current] = await worker(items[current] as T)
      }
    })())
  }

  await Promise.all(runners)
  return results
}

/**
 * A `BlobStore` backed by one S3-compatible bucket.
 * @param {S3BucketConfig} config The bucket and credentials to sign with.
 * @return {BlobStore} The adapter.
 */
export const createS3BlobStore = (config: S3BucketConfig): BlobStore => {
  const store: BlobStore = {
    put: async (
      key: string,
      body: Buffer,
      options?: PutOptions
    ): Promise<void> => {
      const {mod} = await loadSdk()
      const client = await clientFor(config)
      const cacheSeconds = options?.cacheSeconds

      // Never a public cache directive, for the same reason the GCS adapter
      // never sets one: these objects are reached through presigned URLs, and a
      // shared cache holding a user-tier object is a leak no access check can
      // undo. Also the default `private, no-store` when no TTL was given.
      await client.send(new mod.PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: options?.contentType,
        CacheControl: typeof cacheSeconds === "number" ?
          `private, max-age=${cacheSeconds}` :
          "private, no-store",
        Metadata: encodeMetadata(options?.custom ?? {}),
      }))
    },

    stat: async (key: string): Promise<StoredBlob | null> => {
      const {mod} = await loadSdk()
      const client = await clientFor(config)

      try {
        const head = await client.send(new mod.HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }))

        const blob: StoredBlob = {
          key,
          bytes: toBytes(head.ContentLength),
          custom: decodeMetadata(head.Metadata),
        }

        if (typeof head.ContentType === "string" && head.ContentType) {
          blob.contentType = head.ContentType
        }

        return blob
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }
        throw error
      }
    },

    get: async (key: string): Promise<Buffer | null> => {
      const {mod} = await loadSdk()
      const client = await clientFor(config)

      try {
        const object = await client.send(new mod.GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }))

        const body = object.Body as AsyncIterable<Uint8Array> | undefined
        if (!body) {
          return Buffer.alloc(0)
        }

        // The SDK answers with a STREAM, not bytes. Collecting it here rather
        // than calling the SDK's own `transformToByteArray` keeps this correct
        // whichever mixin a given client version attaches to the body.
        const chunks: Buffer[] = []
        for await (const chunk of body) {
          chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }
        throw error
      }
    },

    list: async (prefix: string, limit: number): Promise<StoredBlob[]> => {
      const {mod} = await loadSdk()
      const client = await clientFor(config)

      const listing = await client.send(new mod.ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        MaxKeys: limit,
      }))

      const entries = listing.Contents ?? []

      // Key and size come free from the listing; `custom` does not, so it needs
      // one HEAD per object. A 404 here means the object was deleted between
      // the listing and the read, and is dropped rather than reported -- a
      // vanished object should not appear in the caller's list. Any other error
      // is rethrown: a credential or permission failure must surface, not
      // degrade into a listing of blank records.
      const records = await mapWithLimit(
        entries,
        LIST_CONCURRENCY,
        async (entry): Promise<StoredBlob | null> => {
          const key = typeof entry.Key === "string" ? entry.Key : ""

          if (!key) {
            return null
          }

          const record: StoredBlob = {
            key,
            bytes: toBytes(entry.Size),
            custom: {},
          }

          try {
            const head = await client.send(new mod.HeadObjectCommand({
              Bucket: config.bucket,
              Key: key,
            }))

            record.custom = decodeMetadata(head.Metadata)

            if (typeof head.ContentType === "string" && head.ContentType) {
              record.contentType = head.ContentType
            }

            if (head.ContentLength !== undefined) {
              record.bytes = toBytes(head.ContentLength)
            }

            return record
          } catch (error) {
            if (isNotFound(error)) {
              return null
            }
            throw error
          }
        }
      )

      return records.filter((record): record is StoredBlob => record !== null)
    },

    delete: async (key: string): Promise<void> => {
      const {mod} = await loadSdk()
      const client = await clientFor(config)

      // No NOT_FOUND handling, and that is not an omission: `DeleteObject` is
      // idempotent by specification, so removing an absent key already succeeds.
      await client.send(new mod.DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }))
    },

    signedUrl: async (key: string, ttlSeconds: number): Promise<string> => {
      const {mod, presigner} = await loadSdk()
      const client = await clientFor(config)

      return presigner.getSignedUrl(
        client,
        new mod.GetObjectCommand({Bucket: config.bucket, Key: key}),
        {expiresIn: ttlSeconds}
      )
    },
  }

  return store
}
