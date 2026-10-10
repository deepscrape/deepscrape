/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The two pure seams the S3 adapter exposes.
 *
 * Why these and not the adapter
 * ----------------------------
 * `createS3BlobStore` needs a live endpoint to be worth testing, but the two
 * things that can fail SILENTLY are pure, and they are pinned here:
 *
 *  1. `tigrisConfigFrom` decides whether a deployment is on Tigris or GCS. Its
 *     throwing branch is what stops a half-migrated deployment from writing
 *     artifacts into a bucket nobody chose, and a wrong answer there is
 *     invisible until somebody reads a bill.
 *  2. `encodeMetadata`/`decodeMetadata` move a URL through an HTTP header. A
 *     value that encodes but does not round-trip loses the URL while still
 *     producing a well-formed record -- no error, no log, just an empty field
 *     where a link should be.
 *
 * These are behavioural tests, not source-shape ones, which is why the logic
 * was split out of the environment read: `env` resolves once at module load, so
 * a test mutating `process.env` afterwards would still see the old values and
 * the throwing branch would be unreachable.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  decodeMetadata,
  encodeMetadata,
  tigrisConfigFrom,
  type TigrisEnvValues,
} from "./s3-blob-store"

/** A complete, valid set, so each test changes exactly one field. */
const COMPLETE: TigrisEnvValues = {
  bucket: "deepscrape-artifacts",
  endpoint: "https://t3.storage.dev",
  region: "auto",
  accessKeyId: "tid_example",
  secretAccessKey: "tsec_example",
}

/** The same set with named fields replaced.
 * @param {Partial<TigrisEnvValues>} overrides The fields to replace.
 * @return {TigrisEnvValues} The merged values.
 */
const withValues = (overrides: Partial<TigrisEnvValues>): TigrisEnvValues => ({
  ...COMPLETE,
  ...overrides,
})

describe("the platform backend is chosen fail-closed", () => {
  it("reports unconfigured for an empty bucket, so GCS is used", () => {
    assert.equal(tigrisConfigFrom(withValues({bucket: ""})), null)
    assert.equal(tigrisConfigFrom(withValues({bucket: "   "})), null)
  })

  it("throws rather than falling back when a named bucket lacks a secret", () => {
    assert.throws(
      () => tigrisConfigFrom(withValues({accessKeyId: ""})),
      /TIGRIS_ACCESS_KEY_ID/
    )
    assert.throws(
      () => tigrisConfigFrom(withValues({secretAccessKey: "  "})),
      /TIGRIS_SECRET_ACCESS_KEY/
    )
  })

  it("throws when a named bucket lacks an endpoint", () => {
    assert.throws(
      () => tigrisConfigFrom(withValues({endpoint: ""})),
      /TIGRIS_ENDPOINT/
    )
  })

  it("names every missing field at once, so one deploy fixes them all", () => {
    assert.throws(
      () => tigrisConfigFrom(withValues({
        endpoint: "",
        accessKeyId: "",
        secretAccessKey: "",
      })),
      /TIGRIS_ENDPOINT, TIGRIS_ACCESS_KEY_ID, TIGRIS_SECRET_ACCESS_KEY/
    )
  })

  it("defaults the region to auto and trims every value", () => {
    const config = tigrisConfigFrom(withValues({
      bucket: "  spaced-bucket  ",
      region: "   ",
      endpoint: "  https://t3.storage.dev  ",
    }))

    assert.ok(config, "a complete set was refused")
    assert.equal(config.bucket, "spaced-bucket")
    assert.equal(config.endpoint, "https://t3.storage.dev")
    assert.equal(config.region, "auto")
  })

  it("keeps a region that was supplied", () => {
    const config = tigrisConfigFrom(withValues({region: "us-east-1"}))

    assert.ok(config)
    assert.equal(config.region, "us-east-1")
  })
})

describe("metadata survives the header round trip", () => {
  it("returns ASCII values unchanged", () => {
    const original = {
      url: "https://example.com/a?b=c",
      scope: "shared",
      createdAt: "2026-10-01T00:00:00.000Z",
    }

    assert.deepEqual(decodeMetadata(encodeMetadata(original)), original)
  })

  it("round-trips a url with non-ASCII characters", () => {
    const original = {url: "https://example.com/caf\u00e9/na\u00efve?q=\u00fc"}
    const encoded = encodeMetadata(original)

    // The encoded form must be pure ASCII: this is the whole reason the codec
    // exists, because metadata travels in an HTTP header and a raw non-ASCII
    // byte either mangles or is rejected outright. Checked by code point rather
    // than a regex, because a control-character class trips `no-control-regex`.
    assert.equal(
      [...(encoded["url"] as string)].some((ch) => ch.charCodeAt(0) > 127),
      false
    )
    assert.deepEqual(decodeMetadata(encoded), original)
  })

  it("does not truncate a value that merely looks like the sentinel", () => {
    // The failure this guards: decoding a literal `~b64~...` that was never
    // encoded would silently cut the string, and the record would still look
    // well-formed with a shorter url.
    const original = {url: "~b64~not-actually-encoded"}
    const encoded = encodeMetadata(original)

    assert.equal(encoded["url"], "~b64~not-actually-encoded")
    assert.deepEqual(decodeMetadata(encoded), original)
  })

  it("drops non-string fields rather than coercing them", () => {
    assert.deepEqual(
      decodeMetadata({url: "https://example.com", bytes: 42, flag: true}),
      {url: "https://example.com"}
    )
  })

  it("answers an empty map for a missing or wrong-shaped input", () => {
    assert.deepEqual(decodeMetadata(undefined), {})
    assert.deepEqual(decodeMetadata(null), {})
    assert.deepEqual(decodeMetadata("nope"), {})
    assert.deepEqual(decodeMetadata([]), {})
  })
})
