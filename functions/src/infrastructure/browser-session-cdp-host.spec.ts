/* eslint-disable max-len */
/**
 * A BYO CDP name must not resolve to a private address.
 *
 * `decideCdpUrl` refuses the literal spellings — `wss://127.0.0.1:9222`, `wss://169.254.169.254`
 * — but the same request written as a NAME passed straight through, and the worker dials
 * whatever we stored. That is the whole reason `cdpResolvesPublic` exists, so the two cases
 * that make it worth writing are: a name that resolves inward is refused, and a literal is
 * not looked up at all.
 *
 * The third case is the one with a real cost: DNS failing must refuse rather than pass. A
 * name that does not resolve cannot be connected to, so storing it buys a session that fails
 * later, in the worker, far from the caller who typed it.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {cdpResolvesPublic} from "./browser-session.store"

const resolvesTo = (...addresses: string[]) =>
  async () => addresses.map((address) => ({address}))

describe("cdpResolvesPublic", () => {
  it("refuses a name that resolves to loopback", async () => {
    assert.equal(await cdpResolvesPublic("wss://metadata.example.com", resolvesTo("127.0.0.1")), false)
  })

  it("refuses a name that resolves to the cloud metadata address", async () => {
    assert.equal(await cdpResolvesPublic("wss://metadata.example.com", resolvesTo("169.254.169.254")), false)
  })

  it("refuses when ANY answer is private, not just the first", async () => {
    // A round-robin or dual-stack name can answer public and private together. Taking the
    // first answer would make the verdict depend on resolver ordering.
    assert.equal(
      await cdpResolvesPublic("wss://mixed.example.com", resolvesTo("93.184.216.34", "10.0.0.7")),
      false,
    )
  })

  it("accepts a name whose every answer is public", async () => {
    assert.equal(await cdpResolvesPublic("wss://chrome.example.com", resolvesTo("93.184.216.34")), true)
  })

  it("does not resolve a literal address, which was already vetted", async () => {
    let asked = false
    const spy = async () => {
      asked = true
      return [{address: "127.0.0.1"}]
    }

    assert.equal(await cdpResolvesPublic("wss://93.184.216.34:9222", spy), true)
    assert.equal(asked, false)
  })

  it("refuses when the name does not resolve", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND")
    }

    assert.equal(await cdpResolvesPublic("wss://typo.example.com", failing), false)
  })

  it("refuses an empty answer, which is not a public one", async () => {
    assert.equal(await cdpResolvesPublic("wss://empty.example.com", resolvesTo()), false)
  })

  it("resolves a hex-only NAME instead of mistaking it for an address", async () => {
    // `cafe.de` is made only of characters in [0-9a-f.], which is what the first version
    // used as its "is a literal" test. It was read as an address, the lookup was skipped,
    // and a name like this one walked past the guard.
    let asked = false
    const spy = async () => {
      asked = true
      return [{address: "169.254.169.254"}]
    }

    assert.equal(await cdpResolvesPublic("wss://cafe.de:9222", spy), false)
    assert.equal(asked, true)
  })

  it("reads a bracketed IPv6 literal as a literal, not a name", async () => {
    let asked = false
    const spy = async () => {
      asked = true
      return []
    }

    assert.equal(await cdpResolvesPublic("wss://[2606:4700::1111]:9222", spy), true)
    assert.equal(asked, false)
  })
})
