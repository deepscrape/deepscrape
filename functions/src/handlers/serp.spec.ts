/* eslint-disable object-curly-spacing */
/**
 * The `/serp` request mapping and its failure mapping.
 *
 * Both are pure for exactly this reason: what is worth pinning is the route's
 * permissiveness and its refusals — that a free caller's query is mapped, that
 * `proxy` is never forwarded, and that a plan refusal is not reported as an
 * outage. None of that is observable through a test that needs a live worker.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import { serpArguments, serpFailure } from "./serp"
import { type WebrainToolResult } from "../infrastructure/webrain-mcp"

/**
 * A tool result with only the fields under test set.
 *
 * `webrainTool`'s success shape is the default, because most of these assert
 * about one field and a fully-spelled literal would bury it.
 * @param {*} overrides The fields to override.
 * @return {*} A normalised result.
 */
const result = (
  overrides: Partial<WebrainToolResult>
): WebrainToolResult => ({
  ok: true,
  text: "",
  status: 200,
  ...overrides,
})

describe("serpArguments", () => {
  it("requires a query", () => {
    for (const body of [undefined, null, {}, { q: "" }, { q: "   " }]) {
      const mapped = serpArguments(body)
      assert.equal(mapped.ok, false, JSON.stringify(body))
    }
  })

  it("maps q and sends nothing else by default", () => {
    // Every extra key is an argument webrain would apply a default to anyway,
    // so sending one is a place for the two defaults to disagree.
    const mapped = serpArguments({ q: "tokio rust" })
    assert.equal(mapped.ok, true)
    assert.deepEqual(
      mapped.ok ? mapped.args : null,
      { q: "tokio rust" }
    )
  })

  it("accepts query as an alias for the worker's q", () => {
    const mapped = serpArguments({ query: "  tokio rust  " })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? mapped.args["q"] : undefined, "tokio rust")
  })

  it("refuses an engine the worker does not have", () => {
    // webrain answers an unknown engine with `{"status":"error"}`, which would
    // surface here as a 502 for what is a client typo.
    const mapped = serpArguments({ q: "x", engine: "yahoo" })
    assert.equal(mapped.ok, false)
    assert.match(mapped.ok ? "" : mapped.error, /yahoo/)
  })

  it("lower-cases the engine", () => {
    const mapped = serpArguments({ q: "x", engine: "DuckDuckGo" })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? mapped.args["engine"] : undefined, "duckduckgo")
  })

  it("clamps limit to the worker's real ceiling of 50", () => {
    const high = serpArguments({ q: "x", limit: 500 })
    const low = serpArguments({ q: "x", limit: 0 })
    assert.equal(high.ok ? high.args["limit"] : undefined, 50)
    assert.equal(low.ok ? low.args["limit"] : undefined, 1)
  })

  it("drops a limit that is not a whole number", () => {
    // A numeric string is a client bug; coercing it would hide the bug and the
    // worker would have dropped it to its default anyway.
    const mapped = serpArguments({ q: "x", limit: "10" })
    assert.equal(mapped.ok, true)
    assert.equal(
      mapped.ok ? "limit" in mapped.args : true,
      false
    )
  })

  it("keeps page non-negative and retries within the worker's range", () => {
    const negative = serpArguments({ q: "x", page: -3, retries: 99 })
    assert.equal(negative.ok ? negative.args["page"] : undefined, 0)
    assert.equal(negative.ok ? negative.args["retries"] : undefined, 5)
  })

  it("forwards safe, region and fallback when they are given", () => {
    const mapped = serpArguments({
      q: "x",
      safe: true,
      region: "gb-en",
      fallback: false,
    })
    assert.equal(mapped.ok ? mapped.args["safe"] : undefined, true)
    assert.equal(mapped.ok ? mapped.args["region"] : undefined, "gb-en")
    assert.equal(mapped.ok ? mapped.args["fallback"] : undefined, false)
  })

  it("forwards browser as a boolean, and drops non-booleans", () => {
    // Only `bing` acts on it, but this route's job is the mapping, not the
    // policy. `false` is forwarded rather than folded into "absent": the two
    // mean the same browserless path today, and collapsing them here is what
    // would make a future change to the worker's default a silent no-op.
    const on = serpArguments({ q: "x", engine: "bing", browser: true })
    const off = serpArguments({ q: "x", engine: "bing", browser: false })
    const junk = serpArguments({ q: "x", browser: "yes" })
    assert.equal(on.ok ? on.args["browser"] : undefined, true)
    assert.equal(off.ok ? off.args["browser"] : undefined, false)
    // Not coerced: the worker reads `as_bool()`, so a string would become its
    // default silently instead of being reported as the client bug it is.
    assert.equal(junk.ok ? "browser" in junk.args : true, false)
  })

  it("NEVER forwards proxy, which would let a caller pick our egress", () => {
    const mapped = serpArguments({
      q: "x",
      proxy: "http://user:pass@attacker.test:8080",
    })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? "proxy" in mapped.args : true, false)
  })
})

describe("serpFailure", () => {
  it("reports a worker that could not be reached as an outage", () => {
    const failure = serpFailure(
      result({ ok: false, transportError: true, status: 0 })
    )
    assert.equal(failure?.status, 502)
  })

  it("reports an allowlist refusal as a plan question, not an outage", () => {
    // 403, and the allowlist's own message, so a free user is told what to do
    // rather than told something broke.
    const failure = serpFailure(
      result({
        ok: false,
        toolRefused: true,
        refusal: "tier",
        error: "Needs a private worker",
      })
    )
    assert.equal(failure?.status, 403)
    assert.equal(failure?.error, "Needs a private worker")
  })

  it("names a shared worker refusing a stateful tool", () => {
    const failure = serpFailure(
      result({ ok: false, noStateRefused: true })
    )
    assert.equal(failure?.status, 502)
    assert.match(failure?.error ?? "", /private worker/)
  })

  it("reports a generic provider error with the provider's message", () => {
    const failure = serpFailure(
      result({ ok: false, error: "unknown engine 'yahoo'" })
    )
    assert.equal(failure?.status, 502)
    assert.equal(failure?.error, "unknown engine 'yahoo'")
  })

  it("is null on success, so the route answers with results", () => {
    assert.equal(serpFailure(result({})), null)
  })
})
