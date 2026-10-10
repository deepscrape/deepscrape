/**
 * The QStash boundary.
 *
 * The URL builder and the REJECT path of the verifier are pinned here. The
 * reject path is the security-critical direction: a verifier that accepts
 * anything is the failure that matters, and it is also the one a green build
 * cannot see. If `verifyQstashDelivery` stopped checking, the worker would be
 * an open endpoint and nothing else in the suite would notice.
 *
 * Deliberately state-independent. The queue's env vars may be set (a developer
 * running `qstash-cli dev`, `.env.local` present) or unset (CI), and every
 * assertion below holds in both, so this does not go red on one machine and
 * green on another.
 *
 * The ACCEPT path cannot be tested here: constructing a valid signature means
 * reimplementing Upstash's JWS format, and a test that agrees with my own
 * guess proves nothing about theirs. It belongs in a live round trip against
 * the local dev server, where the signature is real.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"

import {
  verifyQstashDelivery,
  workerUrl,
  workerUrlFor,
} from "./qstash"

const URL_UNDER_TEST = "https://example.test/api/jobs/crawl/worker"

describe("workerUrlFor", () => {
  it("appends the worker path to a bare origin", () => {
    assert.equal(
      workerUrlFor("https://deepscrape.dev"),
      "https://deepscrape.dev/api/jobs/crawl/worker"
    )
  })

  it("collapses a trailing slash instead of doubling it", () => {
    assert.ok(!workerUrlFor("https://deepscrape.dev/").includes("//api"))
    assert.equal(
      workerUrlFor("https://deepscrape.dev/"),
      "https://deepscrape.dev/api/jobs/crawl/worker"
    )
  })

  it("collapses repeated trailing slashes", () => {
    assert.equal(
      workerUrlFor("https://deepscrape.dev///"),
      "https://deepscrape.dev/api/jobs/crawl/worker"
    )
  })

  it("keeps a port when one is present", () => {
    assert.equal(
      workerUrlFor("http://127.0.0.1:8080"),
      "http://127.0.0.1:8080/api/jobs/crawl/worker"
    )
  })
})

describe("workerUrl", () => {
  it("delegates to the builder and always names the worker path", () => {
    assert.ok(workerUrl().endsWith("/api/jobs/crawl/worker"))
    assert.ok(!workerUrl().includes("//api"))
  })
})

describe("verifyQstashDelivery — the reject path", () => {
  it("rejects a missing signature", async () => {
    assert.equal(await verifyQstashDelivery("{}", "", URL_UNDER_TEST), false)
  })

  it("rejects a signature that is not a JWT", async () => {
    assert.equal(
      await verifyQstashDelivery("{}", "not-a-jwt", URL_UNDER_TEST),
      false
    )
  })

  it("rejects a well-formed JWT with a bogus signature", async () => {
    // Three base64url segments, so it parses as a JWS and fails at the
    // HMAC rather than at the parse — the path a real forgery attempt
    // takes.
    const forged = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJVcHN0YXNoIn0.deadbeef"
    assert.equal(await verifyQstashDelivery("{}",
      forged, URL_UNDER_TEST), false)
  })

  it("rejects a signature presented for a different url", async () => {
    const forged = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJVcHN0YXNoIn0.deadbeef"
    assert.equal(
      await verifyQstashDelivery("{}", forged, "https://evil.test/x"),
      false
    )
  })

  it("rejects a body that does not match the signed one", async () => {
    // The point of taking rawBody as a string: a different body is a different
    // signature. A verifier that hashed a re-serialised object would accept
    // this.
    const forged = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJVcHN0YXNoIn0.deadbeef"
    const compact = JSON.stringify({a: 1})
    const spaced = "{\"a\": 1}"
    assert.equal(
      await verifyQstashDelivery(compact, forged, URL_UNDER_TEST),
      false
    )
    assert.equal(
      await verifyQstashDelivery(spaced, forged, URL_UNDER_TEST),
      false
    )
  })
})
