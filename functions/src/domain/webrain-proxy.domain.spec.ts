/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Egress is platform-owned, and the failure of losing that is silent.
 *
 * A caller who can choose the proxy chooses where our request is made from:
 * they read everything crossing it, and any abuse lands on an endpoint they
 * control. Nothing errors, nothing logs -- the fetch simply succeeds from the
 * wrong place.
 *
 * These are behavioural tests, not source-shape ones. That is the reason the
 * logic lives in `domain/` rather than inline in `webrain-mcp.ts`: this module
 * imports only the tier resolver, so a spec can import it, whereas the caller
 * drags in the Firebase Admin app and a Secret Manager client at module load.
 *
 * The pool is now an ARGUMENT rather than an env read, because the store that
 * resolves it (Secret Manager, plus an env fallback) cannot be imported here
 * without pulling in that same client. Passing it keeps these tests
 * behavioural and keeps resolution out of the domain, which is the point of
 * the signature.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  pickProxy,
  proxyCapable,
  withPlatformProxy,
  type ProxyEntry,
} from "./webrain-proxy.domain"

const POOL: ProxyEntry[] = [
  { label: "one", url: "http://a:1@one:8080" },
  { label: "two", url: "http://b:2@two:8080" },
  { label: "three", url: "http://c:3@three:8080" },
]
const EMPTY: ProxyEntry[] = []

describe("which tools may be handed a proxy", () => {
  it("accepts the tools whose schema declares one", () => {
    assert.equal(proxyCapable("webrain_serp"), true)
    assert.equal(proxyCapable("webrain_search"), true)
  })

  it("refuses a tool that does not declare one", () => {
    // An undeclared argument is at best ignored and at worst a rejected call,
    // so the allowlist has to be a real gate rather than a formality.
    assert.equal(proxyCapable("webrain_scrape"), false)
    assert.equal(proxyCapable("webrain_eval"), false)
  })
})

describe("pool selection", () => {
  it("returns nothing when the pool is empty", () => {
    assert.equal(pickProxy("plan", EMPTY), undefined)
  })

  it("pins a free caller to the first entry", () => {
    // The ceiling is the cost control: a free caller must not spread across the
    // pool, or the tier boundary costs nothing to ignore.
    for (let i = 0; i < 50; i += 1) {
      assert.equal(pickProxy("free", POOL), POOL[0])
      assert.equal(pickProxy(undefined, POOL), POOL[0])
    }
  })

  it("lets a paid caller reach the whole pool", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const picked = pickProxy("plan", POOL)
      assert.ok(picked && POOL.includes(picked), `picked outside the pool: ${picked?.url}`)
      seen.add((picked as ProxyEntry).url)
    }
    // With three entries, missing one across 200 draws is (1/3)^199.
    assert.ok(seen.size > 1, "a paid caller never left the first entry")
  })
})

describe("a caller-supplied proxy is never forwarded", () => {
  it("drops it for a capable tool and attaches ours instead", () => {
    const result = withPlatformProxy("webrain_serp", "free", {
      q: "x",
      proxy: "http://attacker@evil:8080",
    }, POOL)
    assert.equal(result["proxy"], POOL[0].url)
    assert.equal(result["proxy"] === "http://attacker@evil:8080", false)
    assert.equal(result["q"], "x", "other arguments must survive")
  })

  it("drops it for a non-capable tool too", () => {
    // Previously this returned `args` untouched, which left the rule dependent
    // on knowing which tools declare `proxy` -- and would have quietly passed a
    // caller's egress to any future tool that gained support for one.
    const result = withPlatformProxy("webrain_scrape", "plan", {
      url: "https://example.com",
      proxy: "http://attacker@evil:8080",
    }, POOL)
    assert.equal("proxy" in result, false)
    assert.equal(result["url"], "https://example.com")
  })

  it("attaches no proxy at all when the pool is empty", () => {
    const result = withPlatformProxy("webrain_serp", "plan", {
      q: "x",
      proxy: "http://attacker@evil:8080",
    }, EMPTY)
    assert.equal("proxy" in result, false, "an unconfigured pool must not forward the caller's")
  })

  it("leaves a call with no proxy untouched for a non-capable tool", () => {
    const args = { url: "https://example.com" }
    const result = withPlatformProxy("webrain_scrape", "plan", args, POOL)
    assert.deepEqual(result, args)
  })
})
