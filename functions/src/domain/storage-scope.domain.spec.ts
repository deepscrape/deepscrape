/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The rule that fails silently if it is wrong.
 *
 * A shared-cache entry is served to everyone who asks for its URL, so it may
 * only hold the result of a fetch that carried NO caller credential. Get this
 * wrong and nothing throws: user B is simply served user A's logged-in page,
 * and the bytes look exactly like the right ones.
 *
 * So these cases are pinned rather than left to review. The default is the USER
 * tier, and the shared tier needs one positively-shaped assertion that no other
 * branch can skip.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  LIST_LIMIT,
  PRESIGN_TTL_SECONDS,
  SHARED_KEY_PREFIX,
  USERS_KEY_PREFIX,
  decideStorageScope,
  isReadableObjectKey,
  isSharedObjectKey,
  sanitizeFilename,
  userObjectKeyPrefix,
} from "./storage-scope.domain"

const URL_A = "https://example.com/article"
const URL_B = "https://example.com/other"

/** The one descriptor shape that may reach the shared tier. */
const anonymous = {
  anonymous: true,
  proxy: "platform",
  egress: "eu-west",
}

describe("an authenticated fetch is refused the shared tier", () => {
  it("refuses a fetch that sent cookies", () => {
    const decision = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "platform",
      egress: "eu-west",
      cookies: "session=abc123",
    })

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "credentialed")
    assert.ok(decision.key.startsWith(userObjectKeyPrefix("uid-1")))
  })

  it("refuses a fetch that sent an authorization header", () => {
    const decision = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "platform",
      egress: "eu-west",
      authorization: "Bearer user-a-token",
    })

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "credentialed")
  })

  it("refuses a fetch over the caller's own proxy", () => {
    // BYOP is a per-user credential: their exit, on their account, and the
    // bytes may be theirs alone.
    const decision = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "byop",
      egress: "their-exit",
    })

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "byop")
  })

  it("refuses a credential field present with any value but null", () => {
    // Including an empty string: a client that always emits the key would send
    // one, and "the field is there and I cannot read it" must not resolve to
    // "fine". Only an explicit null means none was sent.
    for (const value of ["", "   ", [], {}]) {
      const decision = decideStorageScope("uid-1", URL_A, {
        anonymous: true,
        proxy: "platform",
        egress: "eu-west",
        cookies: value,
      })

      assert.equal(decision.scope, "user", `${JSON.stringify(value)} was trusted`)
      assert.equal(decision.reason, "credentialed")
    }
  })

  it("accepts an explicit null credential field", () => {
    // `null` is the one spelling of "none was sent", so a descriptor that spells
    // it out is still fully accounted for.
    const decision = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "platform",
      egress: "eu-west",
      cookies: null,
      authorization: null,
    })

    assert.equal(decision.scope, "shared")
  })
})

describe("absence is not evidence", () => {
  it("gives the user tier when no descriptor was sent at all", () => {
    const decision = decideStorageScope("uid-1", URL_A, undefined)

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "no-descriptor")
  })

  it("gives the user tier for a non-object descriptor", () => {
    for (const value of [null, "anonymous", 42, ["anonymous"]]) {
      const decision = decideStorageScope("uid-1", URL_A, value)
      assert.equal(decision.scope, "user", `${String(value)} was trusted`)
    }
  })

  it("gives the user tier when anonymous is not literally true", () => {
    for (const value of [false, "true", 1, undefined]) {
      const decision = decideStorageScope("uid-1", URL_A, {
        ...anonymous,
        anonymous: value,
      })
      assert.equal(decision.scope, "user", `${String(value)} unlocked the cache`)
    }
  })
})

describe("the descriptor must be fully accounted for", () => {
  it("refuses an unrecognised field", () => {
    // An unknown field might be carrying a credential and this module cannot
    // tell, so the descriptor is not one it can vouch for.
    const decision = decideStorageScope("uid-1", URL_A, {
      ...anonymous,
      referer: "https://example.com/private",
    })

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "unrecognised-field")
  })

  it("refuses an unknown proxy value", () => {
    const decision = decideStorageScope("uid-1", URL_A, {
      ...anonymous,
      proxy: "someones-proxy-service",
    })

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "no-descriptor")
  })

  it("refuses when the egress identity is missing", () => {
    // Without it the key cannot be composed, and a key that is wrong in this
    // direction serves one region's page as another's.
    const decision = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "platform",
    })

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "missing-egress")
  })

  it("refuses a blank egress identity", () => {
    const decision = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "platform",
      egress: "  ",
    })

    assert.equal(decision.scope, "user")
    assert.equal(decision.reason, "missing-egress")
  })
})

describe("the shared key", () => {
  it("is the same for two callers fetching one URL through one exit", () => {
    // This IS the cache: the object is fetched and stored once for everyone.
    const first = decideStorageScope("uid-1", URL_A, anonymous)
    const second = decideStorageScope("uid-2", URL_A, anonymous)

    assert.equal(first.scope, "shared")
    assert.equal(second.scope, "shared")
    assert.equal(first.key, second.key)
  })

  it("differs when the egress identity differs", () => {
    const eu = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "platform",
      egress: "eu-west",
    })
    const us = decideStorageScope("uid-1", URL_A, {
      anonymous: true,
      proxy: "platform",
      egress: "us-east",
    })

    assert.notEqual(eu.key, us.key)
  })

  it("differs when the URL differs", () => {
    const one = decideStorageScope("uid-1", URL_A, anonymous)
    const two = decideStorageScope("uid-1", URL_B, anonymous)

    assert.notEqual(one.key, two.key)
  })

  it("contains neither the URL nor the caller", () => {
    const decision = decideStorageScope("uid-1", URL_A, anonymous)

    assert.equal(decision.key.includes("example.com"), false)
    assert.equal(decision.key.includes("uid-1"), false)
  })
})

describe("the user key", () => {
  it("is stable for one caller and one URL", () => {
    const first = decideStorageScope("uid-1", URL_A, undefined)
    const second = decideStorageScope("uid-1", URL_A, undefined)

    assert.equal(first.key, second.key)
  })

  it("differs between callers, which is the isolation", () => {
    const mine = decideStorageScope("uid-1", URL_A, undefined)
    const theirs = decideStorageScope("uid-2", URL_A, undefined)

    assert.notEqual(mine.key, theirs.key)
    assert.equal(theirs.key.startsWith(userObjectKeyPrefix("uid-1")), false)
  })

  it("contains neither the URL nor the raw caller id", () => {
    const decision = decideStorageScope("uid-1", URL_A, undefined)

    assert.equal(decision.key.includes("example.com"), false)
    assert.equal(decision.key.includes("uid-1"), false)
    assert.ok(decision.key.startsWith(USERS_KEY_PREFIX))
  })
})

describe("reading an object by key", () => {
  const sharedKey = decideStorageScope("uid-1", URL_A, anonymous).key
  const ownKey = decideStorageScope("uid-1", URL_A, undefined).key
  const otherKey = decideStorageScope("uid-2", URL_A, undefined).key

  it("lets anyone read a shared object", () => {
    assert.equal(isReadableObjectKey("uid-2", sharedKey), true)
    assert.equal(isSharedObjectKey(sharedKey), true)
  })

  it("lets the owner read their own object and nobody else", () => {
    assert.equal(isReadableObjectKey("uid-1", ownKey), true)
    assert.equal(isReadableObjectKey("uid-2", ownKey), false)
    assert.equal(isReadableObjectKey("uid-1", otherKey), false)
  })

  it("refuses a traversal key that merely starts with a known prefix", () => {
    // Prefix matching alone would accept this and walk out of the namespace.
    for (const key of [
      `${SHARED_KEY_PREFIX}../users/abc`,
      `${userObjectKeyPrefix("uid-1")}../../shared/abc`,
      "shared/",
      "users/uid-1/file",
      "",
    ]) {
      assert.equal(isReadableObjectKey("uid-1", key), false, key)
    }
  })
})

describe("filename metadata", () => {
  it("drops any path component", () => {
    assert.equal(sanitizeFilename("../../etc/passwd"), "passwd")
    assert.equal(sanitizeFilename("C:\\Users\\me\\report.pdf"), "report.pdf")
  })

  it("refuses anything that is not a usable name", () => {
    for (const value of [undefined, null, 42, "   ", "/", "///"]) {
      assert.equal(sanitizeFilename(value), undefined, String(value))
    }
  })

  it("neutralises characters that reach a response header", () => {
    const cleaned = sanitizeFilename("a\r\nContent-Type: text/html")
    assert.equal(/[\r\n]/.test(String(cleaned)), false)
  })

  it("caps the length", () => {
    const cleaned = sanitizeFilename("x".repeat(400))
    assert.equal(String(cleaned).length, 120)
  })
})

describe("the constants the routes rely on", () => {
  it("keeps the presigned lifetime short", () => {
    // A presigned URL is a bearer credential in a query string.
    assert.ok(PRESIGN_TTL_SECONDS <= 900)
    assert.ok(LIST_LIMIT > 0 && LIST_LIMIT <= 1000)
  })
})
