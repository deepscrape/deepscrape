/* eslint-disable object-curly-spacing */
/**
 * The HTTP-facing half of the session domain: what a create request must look
 * like, and what a refusal answers with.
 *
 * Why these live in the domain rather than the handler: the handler imports the
 * store, which builds the Admin SDK and a Secret Manager client on load, so
 * nothing reachable from there can be imported by a test without an emulator.
 * `serp.ts` splits its pure mapping out for the same reason, and `storage.ts`
 * had to fall back to a source-shape spec because it did not.
 *
 * What is worth pinning here is the part a passing request would not reveal:
 * that an unknown engine is refused rather than cast through, that a blank
 * `cdpUrl` is treated as absent rather than as a configured endpoint, and that
 * no refusal in the set is a 402.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  BROWSER_REFUSAL_STATUS,
  LEASE_REFUSALS,
  parseCreateRequest,
  refusalFor,
} from "./browser-session.domain"

describe("refusalFor", () => {
  it("answers every reason with a status and a sentence", () => {
    for (const reason of LEASE_REFUSALS) {
      const refusal = refusalFor(reason)
      assert.equal(refusal.code, reason)
      assert.ok(refusal.status >= 400, `${reason} has no client-error status`)
      assert.ok(refusal.error.length > 0, `${reason} has no sentence`)
    }
  })

  it("never answers 402, which is the reason these routes use access", () => {
    // The whole point of gating on `access` rather than `paid`: a free caller
    // gets a reason, not a plan wall that says nothing about which limit broke.
    for (const reason of LEASE_REFUSALS) {
      assert.notEqual(refusalFor(reason).status, 402, reason)
    }
  })

  it("separates a wrong request from a refused one", () => {
    assert.equal(BROWSER_REFUSAL_STATUS["unsupported-kind"], 400)
    assert.equal(BROWSER_REFUSAL_STATUS["cdp-url-refused"], 400)
    assert.equal(BROWSER_REFUSAL_STATUS["byo-not-allowed"], 403)
    assert.equal(BROWSER_REFUSAL_STATUS.quota, 429)
  })

  it("gives the same code for the same reason every time", () => {
    // A status taken from one row and a code from another would be the bug this
    // helper exists to prevent, so the pair is asserted together.
    assert.deepEqual(refusalFor("quota"), {
      status: 429,
      code: "quota",
      error: "You already hold as many browser sessions as your plan allows",
    })
  })
})

describe("parseCreateRequest", () => {
  it("refuses anything that is not an object", () => {
    for (const body of [undefined, null, "dedicated", 7, []]) {
      const parsed = parseCreateRequest(body)
      assert.equal(parsed.ok, false, JSON.stringify(body))
    }
  })

  it("refuses a mode it does not serve", () => {
    for (const mode of [undefined, "", "shared", "DEDICATED", 3]) {
      const parsed = parseCreateRequest({mode: mode, kind: "chrome"})
      assert.equal(parsed.ok, false, String(mode))
      if (!parsed.ok) {
        assert.equal(parsed.refusal.status, 400)
        assert.equal(parsed.refusal.code, "unsupported-mode")
      }
    }
  })

  it("refuses an engine we cannot drive rather than casting it through", () => {
    // The type is erased by the time JSON arrives, so this has to be a runtime
    // check — a cast here would reach the store.
    for (const kind of [undefined, "", "firefox", "Chrome", 1, {}]) {
      const parsed = parseCreateRequest({mode: "dedicated", kind: kind})
      assert.equal(parsed.ok, false, JSON.stringify(kind))
      if (!parsed.ok) {
        assert.equal(parsed.refusal.code, "unsupported-kind")
      }
    }
  })

  it("accepts a dedicated request with no endpoint", () => {
    const parsed = parseCreateRequest({mode: "dedicated", kind: "chrome"})
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.request.mode, "dedicated")
      assert.equal(parsed.request.kind, "chrome")
      assert.equal(parsed.request.cdpUrl, undefined)
    }
  })

  it("accepts every engine the platform can drive", () => {
    for (const kind of ["chrome", "lightpanda", "obscura"]) {
      const parsed = parseCreateRequest({mode: "byo", kind: kind})
      assert.equal(parsed.ok, true, kind)
    }
  })

  it("trims a supplied endpoint", () => {
    const parsed = parseCreateRequest({
      mode: "byo",
      kind: "chrome",
      cdpUrl: "  wss://browser.example.com/devtools  ",
    })
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.request.cdpUrl, "wss://browser.example.com/devtools")
    }
  })

  it("treats a blank endpoint as absent, not as configured", () => {
    // `byoConfigured` is derived from this being present, so a whitespace-only
    // string must not read as a configured endpoint — otherwise the lease is
    // allowed and the refusal moves to a later, less obvious place.
    for (const cdpUrl of ["", "   ", "\t"]) {
      const parsed = parseCreateRequest({
        mode: "byo",
        kind: "chrome",
        cdpUrl: cdpUrl,
      })
      assert.equal(parsed.ok, true)
      if (parsed.ok) {
        assert.equal(parsed.request.cdpUrl, undefined, JSON.stringify(cdpUrl))
      }
    }
  })

  it("ignores a non-string endpoint", () => {
    for (const cdpUrl of [7, {}, [], true]) {
      const parsed = parseCreateRequest({
        mode: "byo",
        kind: "chrome",
        cdpUrl: cdpUrl,
      })
      assert.equal(parsed.ok, true, JSON.stringify(cdpUrl))
      if (parsed.ok) {
        assert.equal(parsed.request.cdpUrl, undefined)
      }
    }
  })
})
