/* eslint-disable object-curly-spacing */
/**
 * The host policy, including the IPv6 shapes it used to miss.
 *
 * `new URL("http://[::1]/").hostname` is `"[::1]"` — brackets kept — so the
 * pattern's `::1$` alternative could not match it and the guard admitted every
 * bracketed IPv6 literal. That bypass was silent and applied to the crawl,
 * scrape, monitor and job paths, not just to a new caller.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  cdpEndpointFrom,
  isBlockedHost,
  isSafeTargetUrl,
} from "./url-guard.domain"

describe("isBlockedHost", () => {
  it("still refuses the plain IPv4 and name forms", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "172.16.0.1",
      "0.0.0.0",
      "foo.local",
      "foo.internal",
    ]) {
      assert.equal(isBlockedHost(host), true, host)
    }
  })

  it("refuses bracketed IPv6 literals the pattern could not match", () => {
    for (const host of ["[::1]", "[fd00::1]", "[fc00::1]"]) {
      assert.equal(isBlockedHost(host), true, host)
    }
  })

  it("unwraps an IPv4-mapped literal, hex form included", () => {
    // `new URL` re-encodes the IPv4 as two hex groups, so the shape the guard
    // actually receives is `::ffff:a9fe:a9fe` — not the readable dotted form.
    assert.equal(isBlockedHost("[::ffff:a9fe:a9fe]"), true)
    assert.equal(isBlockedHost("[::ffff:7f00:1]"), true)
    // The dotted form still has to work for a caller that never used `URL`.
    assert.equal(isBlockedHost("[::ffff:127.0.0.1]"), true)
    assert.equal(isBlockedHost("::ffff:169.254.169.254"), true)
  })

  it("refuses the other non-routable IPv6 families", () => {
    for (const host of ["[fe80::1]", "[febf::1]", "[ff02::1]", "[::]"]) {
      assert.equal(isBlockedHost(host), true, host)
    }
  })

  it("leaves public addresses alone", () => {
    for (const host of [
      "example.com",
      "8.8.8.8",
      "172.32.0.1",
      "[2606:4700::1111]",
      "[::ffff:8.8.8.8]",
    ]) {
      assert.equal(isBlockedHost(host), false, host)
    }
  })
})

describe("isSafeTargetUrl", () => {
  it("refuses bracketed IPv6 loopback and ULA targets", () => {
    // The end-to-end consequence of the bypass: all three were accepted.
    assert.equal(isSafeTargetUrl("http://[::1]/x"), false)
    assert.equal(isSafeTargetUrl("http://[fd00::1]/x"), false)
    assert.equal(isSafeTargetUrl("http://[::ffff:169.254.169.254]/"), false)
  })

  it("accepts an ordinary public target", () => {
    assert.equal(isSafeTargetUrl("https://example.com/a"), true)
  })
})

describe("cdpEndpointFrom", () => {
  it("accepts the spellings the hosted providers hand out", () => {
    // Browserless, Browserbase and Steel all hand out `wss:` with the token
    // in the query or the path -- which is exactly what the fetch guard
    // refuses. Trimming is included because these arrive pasted by a user.
    for (const url of [
      "wss://chrome.browserless.io?token=abc",
      "wss://connect.browserbase.com?apiKey=abc",
      "ws://chrome.example.net:9222/devtools/browser/x",
      "http://chrome.example.net:9222",
      "https://chrome.example.net/cdp",
    ]) {
      assert.equal(cdpEndpointFrom(url), url, url)
    }
    assert.equal(
      cdpEndpointFrom("  wss://chrome.example.net  "),
      "wss://chrome.example.net"
    )
  })

  it("refuses a ws endpoint that private space could serve", () => {
    // A caller-supplied endpoint is an attacker-chosen address, so it faces
    // the same host policy as a fetch target.
    for (const url of [
      "ws://localhost:9222",
      "ws://127.0.0.1:9222",
      "wss://169.254.169.254",
      "ws://10.0.0.5:9222",
      "http://[::1]:9222",
      "ws://chrome.internal:9222",
    ]) {
      assert.equal(cdpEndpointFrom(url), undefined, url)
    }
  })

  it("refuses credentials in the userinfo", () => {
    // No provider needs them, and this field is echoed in errors and kept in
    // logs, so `user:pass@` would be a credential in a log line.
    const withPass = "wss://user:pass@chrome.example.net"
    assert.equal(cdpEndpointFrom(withPass), undefined)
    assert.equal(cdpEndpointFrom("wss://tok@chrome.example.net"), undefined)
  })

  it("refuses every other scheme, and anything unparseable", () => {
    const long = `ws://chrome.example.net/${"x".repeat(2100)}`
    for (const value of [
      "file:///etc/passwd",
      "ftp://chrome.example.net",
      "javascript:alert(1)",
      "chrome.example.net:9222",
      "",
      "   ",
      "ws://",
      long,
    ]) {
      assert.equal(cdpEndpointFrom(value), undefined, value)
    }
    assert.equal(cdpEndpointFrom(9222), undefined)
    assert.equal(cdpEndpointFrom(null), undefined)
  })

  it("is a sibling of isSafeTargetUrl, not a widening of it", () => {
    const ws = "wss://chrome.browserless.io?token=abc"
    // The reason it is a separate predicate: widening the fetch guard would
    // change the answer for every existing caller of it.
    assert.equal(isSafeTargetUrl(ws), false)
    assert.equal(cdpEndpointFrom(ws), ws)
  })
})
