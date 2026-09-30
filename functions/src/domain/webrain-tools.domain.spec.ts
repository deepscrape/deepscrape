/* eslint-disable max-len */
/**
 * The gateway's tool allowlist.
 *
 * The assertion that matters most is the one covering `webrain_session`: it is the
 * observed hole in the worker's own guard, and on a shared pool it is a
 * cross-tenant read. The rest pin the allowlist's shape so it cannot quietly
 * become a denylist.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  PAID_ONLY_TOOLS,
  SHARED_POOL_TOOLS,
  decideWebrainTool,
  webrainTierFor,
  webrainToolRefusalMessage,
} from "./webrain-tools.domain"

describe("webrainTierFor", () => {
  it("maps admin explicitly and everything else by paid/free", () => {
    assert.equal(webrainTierFor("admin"), "admin")
    assert.equal(webrainTierFor("plan"), "paid")
    assert.equal(webrainTierFor("credits"), "paid")
    assert.equal(webrainTierFor("grace"), "paid")
    assert.equal(webrainTierFor("free"), "free")
    assert.equal(webrainTierFor(undefined), "free")
    assert.equal(webrainTierFor(""), "free")
  })

  it("treats an unrecognised access mode as paid, not free", () => {
    // A new mode added by billing must not silently become a free user.
    assert.equal(webrainTierFor("some-future-mode"), "paid")
  })
})

describe("the two tool sets", () => {
  it("are disjoint", () => {
    // A tool in both would make the decision depend on evaluation order.
    const overlap = SHARED_POOL_TOOLS.filter((tool) => PAID_ONLY_TOOLS.includes(tool))
    assert.deepEqual(overlap, [])
  })

  it("keeps every stateful tool out of the shared set", () => {
    // The shared pool holds no sessions. Any tool that can open, read or restore
    // one must never appear in the free set, however convenient it would be.
    const stateful = ["webrain_session", "webrain_profiles", "webrain_launch", "webrain_login"]
    for (const tool of stateful) {
      assert.equal(SHARED_POOL_TOOLS.includes(tool), false, `${tool} must not be shared`)
    }
  })
})

describe("decideWebrainTool", () => {
  it("REFUSES webrain_session on the shared tier — the verified worker hole", () => {
    const decision = decideWebrainTool("free", "webrain_session")
    assert.equal(decision.allowed, false)
    assert.equal(decision.refusal, "tier")
  })

  it("allows webrain_session for a paid tier", () => {
    assert.equal(decideWebrainTool("plan", "webrain_session").allowed, true)
  })

  it("allows every shared tool on the free tier", () => {
    for (const tool of SHARED_POOL_TOOLS) {
      assert.equal(decideWebrainTool("free", tool).allowed, true, `${tool} should be free`)
    }
  })

  it("refuses every paid-only tool on the free tier", () => {
    for (const tool of PAID_ONLY_TOOLS) {
      const decision = decideWebrainTool("free", tool)
      assert.equal(decision.allowed, false, `${tool} should not be free`)
      assert.equal(decision.refusal, "tier")
    }
  })

  it("FAILS CLOSED on a tool nobody has catalogued", () => {
    // This is the whole reason the file is an allowlist. webrain ships new tools
    // upstream; an unlisted name must be refused rather than forwarded.
    for (const tier of ["free", "plan"]) {
      const decision = decideWebrainTool(tier, "webrain_something_new")
      assert.equal(decision.allowed, false, `${tier}: unknown tool must be refused`)
      assert.equal(decision.refusal, "unknown-tool")
    }
  })

  it("refuses a missing or non-string tool name instead of forwarding it", () => {
    for (const value of [undefined, null, "", 0, false, {}, []]) {
      const decision = decideWebrainTool("plan", value)
      assert.equal(decision.allowed, false, `should refuse ${JSON.stringify(value)}`)
      assert.equal(decision.refusal, "unknown-tool")
    }
  })

  it("leaves admin unrestricted, including for uncatalogued tools", () => {
    // Deliberate: an operator diagnosing a failure needs the tool that failed, and
    // gating that pushes them to bypass the gateway entirely.
    assert.equal(decideWebrainTool("admin", "webrain_session").allowed, true)
    assert.equal(decideWebrainTool("admin", "webrain_something_new").allowed, true)
    assert.equal(decideWebrainTool("admin", "webrain_profiles").allowed, true)
  })

  it("reports the tier it decided against", () => {
    assert.equal(decideWebrainTool("plan", "webrain_scrape").tier, "paid")
    assert.equal(decideWebrainTool("free", "webrain_scrape").tier, "free")
    assert.equal(decideWebrainTool("admin", "webrain_scrape").tier, "admin")
  })
})

describe("webrainToolRefusalMessage", () => {
  it("sends a tier refusal to the upgrade remedy, not to support", () => {
    assert.match(webrainToolRefusalMessage("tier"), /private worker/)
    assert.match(webrainToolRefusalMessage("unknown-tool"), /not available/)
  })
})
