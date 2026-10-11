/* eslint-disable max-len */
/**
 * The Upstash URL normalizer.
 *
 * Production's `UPSTASH_REDIS_REST_URL` is malformed (`...upstash.io.upstash.io`)
 * and only works because the dedupe below repairs it at startup. These cases are
 * what make that repair deliberate rather than a leftover: the doubled suffix
 * collapses, a usable URL is left exactly as it is, and a foreign host is never
 * rewritten -- a repair that rewrites hosts is a repair that can redirect a
 * database.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {sanitizeUpstashRestUrl} from "./cacheConfig"

/**
 * cacheConfig
 */
describe("sanitizeUpstashRestUrl", () => {
  /**
   * collapses the duplicated host suffix prod carries
   */
  it("collapses the duplicated host suffix prod carries", () => {
    assert.equal(
      sanitizeUpstashRestUrl("https://close-quail-39715.upstash.io.upstash.io"),
      "https://close-quail-39715.upstash.io",
    )
    assert.equal(
      sanitizeUpstashRestUrl("https://close-quail-39715.upstash.io.upstash.io/"),
      "https://close-quail-39715.upstash.io",
    )
  })

  /**
   * leaves a usable value alone
   */
  it("leaves a usable value alone", () => {
    assert.equal(
      sanitizeUpstashRestUrl("https://close-quail-39715.upstash.io"),
      "https://close-quail-39715.upstash.io",
    )
    assert.equal(
      sanitizeUpstashRestUrl("  https://close-quail-39715.upstash.io///  "),
      "https://close-quail-39715.upstash.io",
      "whitespace and trailing slashes are trimmed, not rewritten",
    )
  })

  /**
   * never rewrites a foreign host
   */
  it("never rewrites a foreign host", () => {
    // The suffix must be followed by a path or the end of the string, so a host
    // that merely CONTAINS it is left for the connection to fail on.
    assert.equal(
      sanitizeUpstashRestUrl("https://evil.example/upstash.io.upstash.io"),
      "https://evil.example/upstash.io.upstash.io",
    )
    assert.equal(
      sanitizeUpstashRestUrl("https://x.upstash.io.upstash.io.attacker.test"),
      "https://x.upstash.io.upstash.io.attacker.test",
    )
  })

  /**
   * adds the scheme a bare host is missing
   */
  it("adds the scheme a bare host is missing", () => {
    assert.equal(
      sanitizeUpstashRestUrl("close-quail-39715.upstash.io"),
      "https://close-quail-39715.upstash.io",
    )
    assert.equal(sanitizeUpstashRestUrl(""), "", "an unset value stays unset")
  })
})
