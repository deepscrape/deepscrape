/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The S3 adapter, against a REAL bucket.
 *
 * Why this file is separate from `s3-blob-store.spec.ts`
 * -----------------------------------------------------
 * That suite covers the two pure halves -- `tigrisConfigFrom`'s fail-closed
 * decision and the metadata header round trip -- and neither touches a network.
 * The ADAPTER itself has never run against a backend: `put`, `stat`, `list`,
 * `signedUrl` and `delete` are only type-checked. That matters most for
 * `delete`, which erases customer data and is reached by the account purge, so a
 * wrong key or a swallowed error is silent.
 *
 * Why it is opt-in, and doubly guarded
 * ------------------------------------
 * This suite WRITES and DELETES objects. Following this repo's `RUN_LIVE_GEO`
 * convention, it is skipped unless `RUN_LIVE_BLOB=1`, so it cannot run by
 * accident in CI or against a production bucket. Every key it makes lives under
 * its own `__blobstore-selftest/` prefix, so no run can touch an artifact key.
 *
 * Run it with:
 *   RUN_LIVE_BLOB=1 npx tsx --test src/infrastructure/s3-blob-store.live.spec.ts
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  createS3BlobStore,
  tigrisConfigFrom,
  type TigrisEnvValues,
} from "./s3-blob-store"

/** Opt-in, because this suite writes to a real bucket. */
const LIVE = process.env["RUN_LIVE_BLOB"] === "1"

/**
 * The five values the S3 config needs, from the process environment.
 *
 * Read inside the test rather than at module load, so a skipped run reads
 * nothing and a run with the values absent fails on its own assertion rather
 * than at import time. The values are never printed.
 * @return {TigrisEnvValues} The environment's Tigris values.
 */
const liveValues = (): TigrisEnvValues => ({
  bucket: process.env["TIGRIS_BUCKET"] ?? "",
  endpoint: process.env["TIGRIS_ENDPOINT"] ?? "",
  region: process.env["TIGRIS_REGION"] ?? "",
  accessKeyId: process.env["TIGRIS_ACCESS_KEY_ID"] ?? "",
  secretAccessKey: process.env["TIGRIS_SECRET_ACCESS_KEY"] ?? "",
})

/** A namespace of our own, so a run cannot reach a real artifact key. */
const PREFIX = `__blobstore-selftest/${Date.now()}/`

describe("the S3 adapter against a real bucket", {skip: !LIVE}, () => {
  it("round-trips put, stat, list, a signed URL and delete", async () => {
    const config = tigrisConfigFrom(liveValues())
    assert.ok(config, "RUN_LIVE_BLOB=1 but the TIGRIS_* values are incomplete")

    const store = createS3BlobStore(config)
    const key = `${PREFIX}one.json`
    // `JSON.stringify` rather than a quoted literal: the body IS json, and it
    // keeps the byte count below self-evident.
    const body = Buffer.from(JSON.stringify({a: 1}), "utf8")

    await store.put(key, body, {
      contentType: "application/json",
      custom: {url: "https://example.com", scope: "user"},
    })

    const written = await store.stat(key)
    assert.ok(written, "stat must find what put wrote")
    assert.equal(written.bytes, body.length)
    // The URL is the field that proves metadata survives the header encoding,
    // and it is the one the storage scope keys an object by.
    assert.equal(written.custom["url"], "https://example.com")

    const listed = await store.list(PREFIX, 10)
    assert.ok(
      listed.some((blob) => blob.key === key),
      "list must see what put wrote",
    )

    const url = await store.signedUrl(key, 60)
    assert.ok(url.startsWith("http"), `signed url looks wrong: ${url}`)

    await store.delete(key)
    assert.equal(await store.stat(key), null, "delete must remove the object")

    // Absent is SUCCESS, not an error. The account purge is a retried scheduled
    // job, so a second pass over an object it already removed must not throw --
    // S3 DeleteObject is idempotent by specification, and this is the assertion
    // that proves the adapter relies on that rather than on luck.
    await store.delete(key)

    assert.equal((await store.list(PREFIX, 10)).length, 0)
  })
})
