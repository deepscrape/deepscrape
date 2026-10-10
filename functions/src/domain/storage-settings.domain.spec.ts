/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The two failures this module exists to make impossible.
 *
 *  1. A settings write that records BYOB without a usable credential, leaving a
 *     mode pointing at a bucket nothing can reach.
 *  2. A credential reaching a response. The projection is typed with no field a
 *     secret could occupy, so the assertion is about the shape, not about
 *     remembering.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  byobSecretId,
  isAcceptableEndpoint,
  parseCredentials,
  serializeCredentials,
  toPublicSettings,
  validateStorageSettingsInput,
} from "./storage-settings.domain"

/** A complete, valid BYOB body. */
const byob = {
  mode: "byob",
  bucket: "my-artifacts",
  endpoint: "https://fly.storage.tigris.dev",
  accessKey: "tid_access",
  secretKey: "tid_secret",
}

describe("mode platform", () => {
  it("accepts the bare mode", () => {
    const result = validateStorageSettingsInput({mode: "platform"})
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok ? result.value : null, {mode: "platform"})
  })

  it("refuses credential fields rather than ignoring them", () => {
    // Ignoring them would tell the caller their bucket was configured while
    // their bytes kept landing in ours.
    const result = validateStorageSettingsInput({mode: "platform", bucket: "x"})
    assert.equal(result.ok, false)
    assert.equal(result.ok ? "" : result.error, "credentials_not_allowed")
  })
})

describe("mode byob", () => {
  it("accepts a complete body", () => {
    const result = validateStorageSettingsInput(byob)
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok ? result.value : null, {
      mode: "byob",
      bucket: "my-artifacts",
      endpoint: "https://fly.storage.tigris.dev",
      credentials: {accessKey: "tid_access", secretKey: "tid_secret"},
    })
  })

  it("refuses a bucket that is missing or malformed", () => {
    for (const bucket of [undefined, "", "A", "My-Bucket", "no", "x".repeat(70)]) {
      const result = validateStorageSettingsInput({...byob, bucket})
      assert.equal(result.ok, false, `accepted bucket ${String(bucket)}`)
      assert.equal(result.ok ? "" : result.error, "invalid_bucket")
    }
  })

  it("refuses a non-https endpoint", () => {
    // http would carry the credential pair in clear, and this field is where
    // the caller names where their secret is sent.
    for (const endpoint of ["http://example.com", "not a url", "", undefined]) {
      const result = validateStorageSettingsInput({...byob, endpoint})
      assert.equal(result.ok, false, `accepted endpoint ${String(endpoint)}`)
      assert.equal(result.ok ? "" : result.error, "invalid_endpoint")
    }
  })

  it("refuses a body with either credential missing", () => {
    for (const key of ["accessKey", "secretKey"]) {
      const result = validateStorageSettingsInput({...byob, [key]: "  "})
      assert.equal(result.ok, false)
      assert.equal(result.ok ? "" : result.error, "missing_credentials")
    }
  })

  it("refuses an unbounded credential", () => {
    const result = validateStorageSettingsInput({...byob, secretKey: "s".repeat(2000)})
    assert.equal(result.ok, false)
    assert.equal(result.ok ? "" : result.error, "credential_too_long")
  })
})

describe("the body itself", () => {
  it("refuses anything that is not an object", () => {
    for (const body of [undefined, null, "byob", 7, []]) {
      const result = validateStorageSettingsInput(body)
      assert.equal(result.ok, false, `accepted ${String(body)}`)
      assert.equal(result.ok ? "" : result.error, "invalid_body")
    }
  })

  it("refuses a missing or unknown mode", () => {
    for (const mode of [undefined, "", "s3", "PLATFORM"]) {
      const result = validateStorageSettingsInput({mode})
      assert.equal(result.ok, false, `accepted mode ${String(mode)}`)
      assert.equal(result.ok ? "" : result.error, "invalid_mode")
    }
  })
})

describe("the projection a response is built from", () => {
  it("has no field a credential could occupy", () => {
    const projected = toPublicSettings({
      mode: "byob",
      hasCredentials: true,
      bucket: "my-artifacts",
    })

    assert.deepEqual(Object.keys(projected).sort(), [
      "bucket",
      "hasCredentials",
      "mode",
    ])
  })

  it("omits the bucket when there is none", () => {
    const projected = toPublicSettings({mode: "platform", hasCredentials: false})
    assert.deepEqual(Object.keys(projected).sort(), ["hasCredentials", "mode"])
  })
})

describe("the stored credential payload", () => {
  it("round-trips the pair", () => {
    const payload = serializeCredentials({
      accessKey: "tid_access",
      secretKey: "tid_secret",
    })

    assert.deepEqual(parseCredentials(payload), {
      accessKey: "tid_access",
      secretKey: "tid_secret",
    })
  })

  it("answers null for anything not a complete pair", () => {
    for (const raw of [
      undefined,
      "",
      "not json",
      "{}",
      JSON.stringify({accessKey: "a"}),
      JSON.stringify({accessKey: "", secretKey: "b"}),
      JSON.stringify(["a", "b"]),
    ]) {
      assert.equal(parseCredentials(raw), null, String(raw))
    }
  })

  it("names the secret per caller, so one account cannot reach another's", () => {
    assert.notEqual(byobSecretId("uid-1"), byobSecretId("uid-2"))
    assert.ok(byobSecretId("uid-1").includes("uid-1"))
  })
})

describe("endpoint acceptance", () => {
  it("takes an https origin", () => {
    assert.equal(isAcceptableEndpoint("https://s3.example.com"), true)
  })

  it("refuses everything else", () => {
    for (const value of ["http://s3.example.com", "ftp://x", "", "s3.example.com"]) {
      assert.equal(isAcceptableEndpoint(value), false, value)
    }
  })
})
