/* eslint-disable object-curly-spacing */
/**
 * The admin projection, because a wrong transform here is a credential leak.
 *
 * Two rules are pinned rather than described: nothing the GET payload builds
 * may contain the token, and nothing it builds may contain a full proxy URL.
 * The masking helper is asserted against a URL that carries `user:pass`, since
 * that is the shape a real pool entry has and the case a naive implementation
 * (`url.split("@")[1]`, say) gets wrong on the scheme.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  UNPARSEABLE_HOST,
  generateMcpToken,
  maskProxyHost,
  resolveTokenUpdate,
  toPublicConfig,
  validateProxyInput,
} from "./webrain-config-admin.domain"

describe("maskProxyHost", () => {
  it("keeps host and port and drops the credentials", () => {
    const masked = maskProxyHost("http://user:secret@one.example:8080")

    assert.equal(masked, "one.example:8080")
    assert.equal(masked.includes("user"), false)
    assert.equal(masked.includes("secret"), false)
    assert.equal(masked.includes("@"), false)
  })

  it("omits the port when the URL has none", () => {
    const masked = maskProxyHost("https://user:secret@proxy.example")

    assert.equal(masked, "proxy.example")
    assert.equal(masked.includes("secret"), false)
  })

  it("accepts a socks5 authority", () => {
    const masked = maskProxyHost("socks5://u:p@10.0.0.1:1080")

    assert.equal(masked, "10.0.0.1:1080")
  })

  it("never echoes an unparseable value", () => {
    const masked = maskProxyHost("not-a-url with secret")

    assert.equal(masked, UNPARSEABLE_HOST)
    assert.equal(masked.includes("secret"), false)
  })
})

describe("toPublicConfig", () => {
  it("carries no token field and no full URL", () => {
    const body = toPublicConfig({
      mcpToken: "super-secret-token",
      proxies: [
        { label: "one", url: "http://user:secret@one.example:8080" },
      ],
      source: "secret",
    })

    const serialized = JSON.stringify(body)

    assert.equal(body.hasToken, true)
    assert.equal(body.poolSize, 1)
    assert.equal(body.source, "secret")
    assert.deepEqual(body.proxies, [
      { label: "one", host: "one.example:8080" },
    ])
    assert.equal(serialized.includes("super-secret-token"), false)
    assert.equal(serialized.includes("user:secret"), false)
    assert.equal(serialized.includes("http://"), false)
    assert.equal("token" in body, false)
  })

  it("reports a blank token as absent", () => {
    const body = toPublicConfig({
      mcpToken: "   ",
      proxies: [],
      source: "env",
    })

    assert.equal(body.hasToken, false)
    assert.equal(body.poolSize, 0)
  })
})

describe("validateProxyInput", () => {
  it("accepts a well-formed pool", () => {
    const result = validateProxyInput({
      proxies: [{ label: "one", url: "http://user:secret@one:8080" }],
    })

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.proxies, [
        { label: "one", url: "http://user:secret@one:8080" },
      ])
    }
  })

  it("rejects an empty label at the offending index", () => {
    const result = validateProxyInput({
      proxies: [
        { label: "one", url: "http://one:8080" },
        { label: "  ", url: "http://two:8080" },
      ],
    })

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.index, 1)
      assert.equal(result.reason, "label is required")
    }
  })

  it("rejects a disallowed scheme without echoing the URL", () => {
    const result = validateProxyInput({
      proxies: [{ label: "one", url: "ftp://user:secret@one:21" }],
    })

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.index, 0)
      assert.equal(result.reason.includes("secret"), false)
      assert.equal(result.reason.includes("ftp"), false)
    }
  })

  it("rejects a missing pool", () => {
    assert.deepEqual(validateProxyInput({}), {
      ok: false,
      index: -1,
      reason: "proxies must be a non-empty array",
    })
  })
})

describe("resolveTokenUpdate", () => {
  it("stores a supplied token without marking it generated", () => {
    assert.deepEqual(resolveTokenUpdate({ token: "given-token" }), {
      token: "given-token",
      generated: false,
    })
  })

  it("mints a URL-safe token when none is supplied", () => {
    const first = resolveTokenUpdate({})
    const second = resolveTokenUpdate({ token: "  " })

    assert.equal(first.generated, true)
    assert.equal(second.generated, true)
    assert.match(first.token, /^[A-Za-z0-9_-]{32,}$/)
    assert.notEqual(first.token, second.token)
  })
})

describe("generateMcpToken", () => {
  it("returns a fresh URL-safe value on every call", () => {
    const first = generateMcpToken()

    assert.match(first, /^[A-Za-z0-9_-]{32,}$/)
    assert.notEqual(first, generateMcpToken())
  })
})
