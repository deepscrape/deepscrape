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
  EXCLUSIVE_PAID_TOOLS,
  SESSION_TOOLS,
  PAID_ONLY_TOOLS,
  SHARED_POOL_TOOLS,
  SHARED_UNSAFE_TOOLS,
  VAULT_TOOLS,
  decideWebrainTool,
  isEndpointCookieCall,
  needsCallerOwnWorker,
  isSessionTool,
  needsExclusiveWorker,
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

  it("keeps payload-heavy tools out of the shared set", () => {
    // One call moves an unbounded number of bytes, so the cost is the transfer
    // rather than the concurrency a shared container can queue behind. Both sat
    // in the free set with no route exposing either, which is why moving them
    // changed no caller's answer -- the next `/api/download` added with the free
    // guard is what would have made it matter.
    for (const tool of ["webrain_download", "webrain_watch"]) {
      assert.equal(SHARED_POOL_TOOLS.includes(tool), false, `${tool} must not be shared`)
      assert.equal(PAID_ONLY_TOOLS.includes(tool), true, `${tool} must be metered`)
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

describe("needsExclusiveWorker", () => {
  it("requires a worker of the caller's own for the current-page tools", () => {
    // `extract` is "structured extraction from the CURRENT page" and
    // `pdf(op=page)` saves the current page. Neither takes a URL, so on a shared
    // process the page being read belongs to whoever called last. This is the
    // cross-tenant read that the tier sets above cannot express, because the
    // problem is the WORKER, not the plan.
    for (const tool of ["webrain_extract", "webrain_pdf"]) {
      assert.equal(needsExclusiveWorker(tool), true, tool)
    }
  })

  it("leaves both of them IN the shared set, because the axis is not a tier", () => {
    // The tempting "fix" is to move these two into PAID_ONLY_TOOLS. That is wrong
    // twice over: it would refuse a PAID caller on a leased worker, where both
    // tools are correct and the current page really is theirs, and it would
    // replace the real axis with a proxy for it. Asserted so a later reader
    // cannot simplify it back into a tier check.
    for (const tool of SHARED_UNSAFE_TOOLS) {
      assert.equal(SHARED_POOL_TOOLS.includes(tool), true, tool)
      assert.equal(PAID_ONLY_TOOLS.includes(tool), false, tool)
    }
  })

  it("asks nothing of the genuinely stateless reads", () => {
    for (const tool of ["webrain_scrape", "webrain_serp", "webrain_search"]) {
      assert.equal(needsExclusiveWorker(tool), false, tool)
    }
  })

  it("covers the PAID page tools from the second list, not the shared one", () => {
    // The subset contract above forbids putting these in `SHARED_UNSAFE_TOOLS`,
    // and a PAID caller on the single unleased worker has exactly the same
    // cross-tenant read a free one has. Both halves are asserted: that the answer
    // is true, and that it comes from the other list rather than by widening this
    // one.
    for (const tool of EXCLUSIVE_PAID_TOOLS) {
      assert.equal(needsExclusiveWorker(tool), true, tool)
      assert.equal(PAID_ONLY_TOOLS.includes(tool), true, tool)
      assert.equal(SHARED_UNSAFE_TOOLS.includes(tool), false, tool)
    }
  })

  it("leaves the free, browserless guide in neither list", () => {
    // It answers from the binary's own documentation and touches no page, so
    // requiring exclusivity for it would refuse the one tool the shared pool can
    // serve at no cost.
    assert.equal(needsExclusiveWorker("webrain_guide"), false)
    assert.equal(EXCLUSIVE_PAID_TOOLS.includes("webrain_guide"), false)
  })

  it("answers false for a name that is not a string", () => {
    // A requirement check, not a gate: the allowlist behind it already refuses an
    // uncatalogued name, so false here cannot let one through. Answering true
    // would refuse an unknown tool for the wrong reason and hide the
    // `unknown-tool` refusal that actually applies.
    for (const value of [undefined, null, 0, false, {}, []]) {
      assert.equal(needsExclusiveWorker(value), false)
    }
  })
})

describe("needsCallerOwnWorker", () => {
  it("covers every tool that touches the credential vault", () => {
    // The vault is PROCESS-GLOBAL (ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md:111),
    // so a profile written on a pooled worker outlives the lease that wrote it and
    // is readable by whoever leases that worker next. These four are the tools
    // that read or write it.
    for (const tool of [
      "webrain_profiles",
      "webrain_login",
      "webrain_launch",
      "webrain_session",
    ]) {
      assert.equal(needsCallerOwnWorker(tool), true, tool)
      assert.equal(VAULT_TOOLS.includes(tool), true, tool)
    }
  })

  it("keeps every vault tool OUT of the shared set", () => {
    // Belt for the guard in `webrainTool`: a vault tool that drifted into
    // SHARED_POOL_TOOLS would be reachable on a shared worker, where webrain's own
    // `WEBRAIN_NO_STATE` is the only thing standing between tenants. Asserted
    // here so the drift is a red test rather than a production surprise.
    for (const tool of VAULT_TOOLS) {
      assert.equal(SHARED_POOL_TOOLS.includes(tool), false, tool)
    }
  })

  it("is a DIFFERENT axis from needing an exclusive worker", () => {
    // `extract` needs a worker nobody else is IN right now; `profiles` needs one
    // that outlives the visit. A pooled lease satisfies the first and not the
    // second, which is exactly why one predicate cannot cover both.
    assert.equal(needsExclusiveWorker("webrain_profiles"), false)
    assert.equal(needsCallerOwnWorker("webrain_extract"), false)
    assert.equal(needsExclusiveWorker("webrain_extract"), true)
    assert.equal(needsCallerOwnWorker("webrain_profiles"), true)
  })

  it("answers false for a name that is not a string", () => {
    for (const value of [undefined, null, 0, false, {}, []]) {
      assert.equal(needsCallerOwnWorker(value), false)
    }
  })
})

describe("SESSION_TOOLS", () => {
  const REFUSED: readonly string[] = [
    "webrain_eval",
    "webrain_eval_in_frame",
    "webrain_download",
    "webrain_watch",
    "webrain_profiles",
    "webrain_login",
    "webrain_launch",
  ]

  it("allows the page tools and the two capacity tools", () => {
    assert.deepEqual([...SESSION_TOOLS], [
      "webrain_navigate",
      "webrain_observe",
      "webrain_interact",
      "webrain_batch",
      "webrain_crawl",
    ])
  })

  it("admits the two capacity tools, which the meter already prices", () => {
    // They were held back for being long-running. Duration is what a leased
    // machine is BILLED for -- per started 5-minute block, up to a 20-credit
    // ceiling -- so a long crawl on one tenant's own machine is an expensive
    // request rather than an unsafe one. Excluding them cost more than it
    // bought: `needsExclusiveWorker` refuses both on the unleased
    // `WEBRAIN_MCP_URL`, no pool exists, so `/api/batch` and `/api/spider` were
    // doors into a wall.
    for (const tool of ["webrain_batch", "webrain_crawl"]) {
      assert.equal(isSessionTool(tool), true, tool)
    }
  })

  it("keeps the arbitrary-JS and payload-heavy tools out", () => {
    // The route behind this list reaches a machine LEASED to one tenant, so the
    // lease is the safety boundary rather than a tier allowlist. That says nothing
    // about `eval`, which would run arbitrary JavaScript on that machine, nor
    // about the tools that move unbounded bytes and are not metered by payload.
    for (const tool of REFUSED) {
      assert.equal(isSessionTool(tool), false, tool)
    }
  })

  it("never exempts a tool the POOL would have refused", () => {
    // Every session tool is also in `EXCLUSIVE_PAID_TOOLS`, which is what makes a
    // caller who reached it through the pool require an exclusive worker. If one
    // ever stopped being there, the machine-direct route would quietly become the
    // only place it is safe -- a decision rather than a drift, so it fails here.
    for (const tool of SESSION_TOOLS) {
      assert.equal(EXCLUSIVE_PAID_TOOLS.includes(tool), true, tool)
    }
  })

  it("answers false for a name that is not a string", () => {
    for (const value of [undefined, null, 0, false, {}, []]) {
      assert.equal(isSessionTool(value), false)
    }
  })
})

describe("isEndpointCookieCall", () => {
  it("covers exactly the two payload cookie ops", () => {
    for (const op of ["cookies", "setcookies"]) {
      assert.equal(
        isEndpointCookieCall("webrain_session", {
          op,
          cdp_url: "wss://chrome.example.net",
        }),
        true,
        op,
      )
    }
  })

  it("excludes every op that opens the worker's vault", () => {
    // These five write or read `profiles_dir()/<service>/<profile>`, so an
    // endpoint does not make them safe: what they leave behind outlives the
    // lease. Listed individually so a sixth file-backed op has to be added here.
    for (const op of [
      "profiles",
      "login",
      "save_state",
      "restore_state",
      "close_launch",
    ]) {
      assert.equal(
        isEndpointCookieCall("webrain_session", {
          op,
          cdp_url: "wss://chrome.example.net",
        }),
        false,
        op,
      )
    }
  })

  it("needs an endpoint of its own, not just the right op", () => {
    for (const args of [
      {op: "cookies"},
      {op: "cookies", cdp_url: "   "},
      {op: "cookies", cdp_url: 9222},
      {op: "cookies", cdp_url: null},
    ]) {
      assert.equal(
        isEndpointCookieCall("webrain_session", args),
        false,
        JSON.stringify(args),
      )
    }
  })

  it("does not answer for another tool that also takes an op", () => {
    assert.equal(
      isEndpointCookieCall("webrain_vision", {
        op: "cookies",
        cdp_url: "wss://chrome.example.net",
      }),
      false,
    )
    assert.equal(isEndpointCookieCall("webrain_session", undefined), false)
  })
})

describe("decideWebrainTool, with a browser of the caller's own", () => {
  it("allows the cookie pair for a FREE caller", () => {
    // What the paid tier protects is the worker's process-global vault and the
    // shared pool. A cookie call with the caller's own endpoint opens neither.
    const decision = decideWebrainTool("free", "webrain_session", {
      op: "setcookies",
      cdp_url: "wss://chrome.example.net",
    })
    assert.equal(decision.allowed, true)
    assert.equal(decision.refusal, undefined)
  })

  it("still refuses that same free caller the file-backed ops", () => {
    for (const op of ["login", "save_state", "restore_state", "profiles"]) {
      const decision = decideWebrainTool("free", "webrain_session", {
        op,
        cdp_url: "wss://chrome.example.net",
      })
      assert.equal(decision.allowed, false, op)
      assert.equal(decision.refusal, "tier", op)
    }
  })

  it("still refuses the cookie pair to a free caller with NO endpoint", () => {
    // The exemption is the endpoint, so without one nothing changed.
    const decision = decideWebrainTool("free", "webrain_session", {op: "cookies"})
    assert.equal(decision.allowed, false)
    assert.equal(decision.refusal, "tier")
  })
})

describe("webrainToolRefusalMessage", () => {
  it("sends a tier refusal to the upgrade remedy, not to support", () => {
    assert.match(webrainToolRefusalMessage("tier"), /private worker/)
    assert.match(webrainToolRefusalMessage("unknown-tool"), /not available/)
  })
})
