import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  computeFrom,
  computeSecretId,
  computeSourceOf,
  DEFAULT_COMPUTE,
  parseFlyTenant,
  serializeFlyTenant,
  toPublicCompute,
  validateComputeInput,
  type FlyTenantConfig,
} from "./byo-compute.domain"

/** A deploy token, which is what every assertion here guards. */
const TOKEN = "FlyV1 fm2_test-deploy-token"

/** A complete config, the shape a caller sends and we store. */
const CONFIG: FlyTenantConfig = {
  app: "their-app",
  token: TOKEN,
  region: "fra",
}

describe("byo compute: the secret id", () => {
  it("namespaces one secret per caller", () => {
    assert.equal(computeSecretId("abc"), "compute-byo-abc")
    assert.notEqual(computeSecretId("abc"), computeSecretId("abd"))
  })
})

describe("byo compute: resolving whose organization to act on", () => {
  it("uses the platform organization when the caller has no pointer", () => {
    // `undefined` is the ABSENCE of a pointer, not a failure.
    assert.deepEqual(computeFrom(undefined), {kind: "platform"})
  })

  it("refuses when a pointer exists but did not resolve", () => {
    // The fail-closed case, and the expensive one: falling back here would
    // create the caller's machines in OUR organization and bill US, while they
    // believe the work landed on the account they configured.
    assert.deepEqual(computeFrom(null), {kind: "unusable"})
  })

  it("uses the caller's own organization when it resolves", () => {
    assert.deepEqual(computeFrom(CONFIG), {kind: "tenant", config: CONFIG})
  })
})

describe("byo compute: the source a bill reads", () => {
  it("bills nothing when the config did not resolve", () => {
    // Null, never `platform`: returning a billable source here would charge a
    // caller compute for machines that were never created.
    assert.equal(computeSourceOf(computeFrom(null)), null)
  })

  it("names the platform when the caller has nothing configured", () => {
    assert.equal(computeSourceOf(computeFrom(undefined)), "platform")
  })

  it("names the tenant so compute is not billed twice", () => {
    // A BYO caller pays Fly directly, so our compute line must be zero -- which
    // the billing path can only know from this value.
    assert.equal(computeSourceOf(computeFrom(CONFIG)), "byo")
  })
})

describe("byo compute: the stored payload", () => {
  it("round trips a config", () => {
    const raw = serializeFlyTenant(CONFIG)
    assert.deepEqual(parseFlyTenant(raw), CONFIG)
  })

  it("refuses anything that is not a usable config", () => {
    const rejected: unknown[] = [
      undefined,
      null,
      42,
      "",
      "   ",
      "not json",
      JSON.stringify({}),
      // Each field missing on its own: an app with no token cannot be acted on,
      // and a token with no app cannot be addressed.
      JSON.stringify({app: "their-app"}),
      JSON.stringify({token: TOKEN}),
      JSON.stringify({app: "", token: TOKEN}),
      JSON.stringify({app: "their-app", token: ""}),
      // A region we would pass to Fly unread.
      JSON.stringify({app: "their-app", token: TOKEN, region: "not-a-region"}),
    ]

    for (const raw of rejected) {
      assert.equal(parseFlyTenant(raw), null, `should refuse: ${String(raw)}`)
    }
  })

  it("re-validates on the way out, not just the way in", () => {
    // A secret can be hand-edited or restored from a backup, so a stored value
    // is input like any other. This one decides whose organization we act on.
    const handEdited = JSON.stringify({
      app: "their-app",
      token: "no\nline-breaks",
    })
    assert.equal(parseFlyTenant(handEdited), null)
  })
})

describe("byo compute: validating a write", () => {
  it("accepts an explicit clear", () => {
    assert.deepEqual(validateComputeInput({mode: "platform"}), {
      ok: true,
      write: {mode: "platform"},
    })
  })

  it("requires a mode rather than guessing one", () => {
    // Either guess is wrong for somebody: reading an absent mode as "set" lets
    // a typo overwrite a working config, and as "clear" silently moves a caller
    // off their own organization.
    for (const body of [{}, {app: "a", token: "t"}, {mode: "nope"}]) {
      const check = validateComputeInput(body)
      assert.equal(check.ok, false, `should refuse: ${String(body)}`)
    }
  })

  it("accepts a complete config", () => {
    // `mode` is supplied here because the VALIDATOR requires it: `CONFIG` is the
    // STORED shape, which carries no mode. That requirement is the subject of
    // the test above rather than an inconvenience of this one.
    assert.deepEqual(validateComputeInput({mode: "byo", ...CONFIG}), {
      ok: true,
      write: {mode: "byo", ...CONFIG},
    })
  })

  it("defaults an absent region rather than refusing the config", () => {
    // Region is not a credential: a caller who named an app and a token has
    // said who they are, so an unset region is the provider's default.
    const check = validateComputeInput({
      mode: "byo",
      app: "their-app",
      token: TOKEN,
    })

    assert.equal(check.ok, true)
    if (!check.ok || check.write.mode !== "byo") {
      return
    }
    assert.equal(check.write.region, "")
  })

  it("refuses a token that would forge a header", () => {
    // The token is set as `Authorization: Bearer <token>`, so a line break in
    // it appends headers to a request we make.
    for (const token of ["a\nb", "a\r\nb", "a\rb"]) {
      const check = validateComputeInput({mode: "byo", app: "a", token})
      assert.equal(check.ok, false, `should refuse: ${JSON.stringify(token)}`)
    }
  })

  it("names a reason and never echoes the value it refused", () => {
    // A message quoting the input would put a deploy token in the response
    // body and the log at the same time.
    const check = validateComputeInput({
      mode: "byo",
      app: "their-app",
      token: "bad\ntoken",
    })

    assert.equal(check.ok, false)
    if (check.ok) {
      return
    }
    assert.ok(!check.reason.includes("bad"), "the reason quoted the token")
  })

  it("refuses an app name Fly would not accept", () => {
    for (const app of ["Their-App", "-leading", "trailing-", "with space"]) {
      const check = validateComputeInput({mode: "byo", app, token: TOKEN})
      assert.equal(check.ok, false, `should refuse app: ${app}`)
    }
  })
})

describe("byo compute: the caller-facing projection", () => {
  it("has no field named for a credential", () => {
    for (const key of Object.keys(DEFAULT_COMPUTE)) {
      assert.ok(!/token|secret|password/i.test(key), `field names one: ${key}`)
    }
  })

  it("never carries the token, in any field", () => {
    // Asserted on the SERIALISED shape rather than on the field names, because
    // a name-based check would pass while a future edit put the token in a
    // differently named field. `hasCredentials` is why that distinction is not
    // theoretical: its NAME contains "credential" and its value must stay a bit.
    const serialized = JSON.stringify(toPublicCompute(computeFrom(CONFIG)))

    assert.ok(!serialized.includes(TOKEN), "the token reached the public shape")
    assert.ok(!serialized.includes("fm2_"), "part of the token reached it")
  })

  it("shows the app so a caller can confirm which one", () => {
    const publicShape = toPublicCompute(computeFrom(CONFIG))

    assert.equal(publicShape.mode, "byo")
    assert.equal(publicShape.computeSource, "byo")
    assert.equal(publicShape.hasCredentials, true)
    assert.equal(publicShape.app, "their-app")
  })

  it("reads an unusable config as theirs-but-credentialless", () => {
    // The honest description of a pointer that did not resolve, and the same
    // condition the resolver refuses on -- so a UI can say "configured, but not
    // usable" rather than showing their organization as switched off.
    const publicShape = toPublicCompute(computeFrom(null))

    assert.equal(publicShape.mode, "byo")
    assert.equal(publicShape.hasCredentials, false)
    assert.equal(publicShape.app, "")
  })

  it("reads an unconfigured caller as the platform default", () => {
    assert.deepEqual(toPublicCompute(computeFrom(undefined)), DEFAULT_COMPUTE)
  })
})
