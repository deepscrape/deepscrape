/* eslint-disable max-len */
/**
 * The key-resolution rules for AI vendors.
 *
 * These decide whose credential pays for a call, so the assertions that matter are
 * the two failure directions: a free plan must never reach the platform's key, and
 * a supplied key must always win over the platform's. Both are silent when wrong —
 * nothing errors, the bill is simply not what anyone intended.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  AI_VENDORS,
  availableVendors,
  isAiVendorId,
  isPaidPlan,
  isPlausibleApiKey,
  resolveAiKeySource,
} from "./user-ai-settings.domain"

describe("AI vendor catalogue", () => {
  it("has unique ids and a label key each", () => {
    const ids = AI_VENDORS.map((vendor) => vendor.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const vendor of AI_VENDORS) {
      assert.ok(vendor.labelKey.length > 0, `${vendor.id} has no i18n key`)
    }
  })

  it("names an env variable for every vendor but carries no value", () => {
    // A name is configuration; a value would be a credential in source. This
    // asserts the shape stays a bare identifier so a real key cannot slip in.
    for (const vendor of AI_VENDORS) {
      assert.match(vendor.envKeyName, /^[A-Z][A-Z0-9_]*$/, `${vendor.id}: envKeyName is not a bare name`)
    }
  })
})

describe("isPaidPlan", () => {
  it("treats only an explicit 'free' (or nothing) as unpaid", () => {
    assert.equal(isPaidPlan("free"), false)
    assert.equal(isPaidPlan(undefined), false)
    assert.equal(isPaidPlan(""), false)
    for (const paid of ["plan", "credits", "grace", "admin"]) {
      assert.equal(isPaidPlan(paid), true, `${paid} should count as paid`)
    }
  })
})

describe("resolveAiKeySource", () => {
  it("refuses a vendor the platform does not have", () => {
    const resolution = resolveAiKeySource("mystery-vendor", "plan", true)
    assert.equal(resolution.allowed, false)
    assert.equal(resolution.refusal, "unknown-vendor")
    assert.equal(resolution.source, "none")
  })

  it("REFUSES the platform key for a free plan", () => {
    const resolution = resolveAiKeySource("anthropic", "free", false)
    assert.equal(resolution.allowed, false)
    assert.equal(resolution.refusal, "plan-required")
    assert.equal(resolution.source, "none")
  })

  it("allows the platform key for a paid plan", () => {
    const resolution = resolveAiKeySource("anthropic", "plan", false)
    assert.equal(resolution.allowed, true)
    assert.equal(resolution.source, "platform")
  })

  it("lets anybody use their own key, including a free plan", () => {
    // The platform pays nothing, so there is no quota of ours to protect.
    const resolution = resolveAiKeySource("anthropic", "free", true)
    assert.equal(resolution.allowed, true)
    assert.equal(resolution.source, "user")
  })

  it("prefers the user's key over the platform's on a paid plan", () => {
    // Otherwise supplying a key would have no effect for the people most likely
    // to supply one, and the platform would keep paying.
    const resolution = resolveAiKeySource("anthropic", "plan", true)
    assert.equal(resolution.source, "user")
  })

  it("never reports a source other than the three known ones", () => {
    const plans = ["free", "plan", "credits", "grace", "admin", undefined, "", "nonsense"]
    // `jina` sits with the REFUSED cases on purpose: it is a scrape provider, not a chat
    // vendor, so this resolver answers `unknown-vendor` for it -- which is correct and is what
    // the separation of the two catalogues means. It used to be in the accepted set only
    // because the key store was keyed by this union.
    const vendors = ["anthropic", "openai", "groq", "deepseek", "jina", "unknown", null, 42, {}]
    for (const plan of plans) {
      for (const vendor of vendors) {
        for (const hasKey of [true, false]) {
          const resolution = resolveAiKeySource(vendor, plan, hasKey)
          assert.ok(
            ["user", "platform", "none"].includes(resolution.source),
            `bad source ${resolution.source} for ${String(vendor)}/${String(plan)}/${hasKey}`,
          )
          // An allowed resolution must name where the key came from; a refused one
          // must say why. Neither half may be missing.
          if (resolution.allowed) {
            assert.notEqual(resolution.source, "none", `allowed with no source for ${String(vendor)}`)
            assert.equal(resolution.refusal, undefined)
          } else {
            assert.equal(resolution.source, "none", `refused but claims a source for ${String(vendor)}`)
            assert.ok(resolution.refusal, `refused with no reason for ${String(vendor)}`)
          }
        }
      }
    }
  })
})

describe("availableVendors", () => {
  it("offers a free user without keys nothing", () => {
    const offered = availableVendors("free", [])
    assert.equal(offered.every((entry) => !entry.allowed), true)
  })

  it("offers a free user every vendor they have brought a key for", () => {
    const offered = availableVendors("free", ["anthropic", "groq"])
    const allowed = offered.filter((entry) => entry.allowed).map((entry) => entry.vendor?.id)
    assert.deepEqual(allowed, ["anthropic", "groq"])
  })

  it("offers a paid user the platform-backed vendors with no keys at all", () => {
    const offered = availableVendors("plan", [])
    const platform = offered.filter((entry) => entry.source === "platform").map((entry) => entry.vendor?.id)
    // Three, not four: `jina` used to be in this list as a BYOK vendor, and it is not a chat
    // vendor at all. Its credential is chosen by the SCRAPE catalogue's `byok` flag, so it is
    // reported on the scrape half of the settings reply instead of here.
    assert.deepEqual(platform, ["anthropic", "openai", "groq"])
  })

  it("ignores a stored reader key, because a reader is not a chat vendor", () => {
    // `availableVendors` maps the AI catalogue, so a provider id from the other catalogue must
    // pass through without inventing a row. The key store holds both, which is the whole reason
    // the two are separate lists rather than one that has to accommodate a reader.
    const offered = availableVendors("plan", ["jina"])
    // Widened to `string` on purpose: `jina` is no longer in `AiVendorId`, so the direct
    // comparison is a type error -- which is the point of the test and not a reason to delete
    // it. Asserting on the widened value still fails the day `jina` is added back to
    // `AI_VENDORS`, and that is the regression worth catching.
    const ids: readonly (string | undefined)[] = offered.map((entry) => entry.vendor?.id)
    assert.equal(ids.includes("jina"), false)
    assert.equal(offered.length, AI_VENDORS.length)
  })
})

describe("isPlausibleApiKey", () => {
  it("accepts a long token and rejects the obvious non-keys", () => {
    assert.equal(isPlausibleApiKey("sk-" + "a".repeat(40)), true)
    for (const value of ["", "   ", "short", null, undefined, 12345, {}, "a".repeat(513)]) {
      assert.equal(isPlausibleApiKey(value), false, `should reject ${JSON.stringify(value)}`)
    }
  })

  it("does not try to guess a vendor's format", () => {
    // A format regex that rejects a valid new key has no workaround for the user.
    assert.equal(isPlausibleApiKey("not-a-known-prefix-but-long-enough"), true)
  })
})

describe("isAiVendorId", () => {
  it("accepts only catalogue ids, case-sensitively", () => {
    assert.equal(isAiVendorId("anthropic"), true)
    assert.equal(isAiVendorId("Anthropic"), false)
    assert.equal(isAiVendorId("anthropic "), false)
  })
})
