/* eslint-disable object-curly-spacing */
/**
 * Pins the tier model and the lease decision.
 *
 * The caps are asserted as literal data on purpose: they are the price list. A
 * test that merely re-read `SESSION_CAPS` would pass after someone changed a
 * number, which is the one change that must never be silent.
 */

import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  BROWSER_KINDS,
  SESSION_CAPS,
  cdpSecretId,
  countLiveForMode,
  decideCdpUrl,
  decideLease,
  frameIntervalMs,
  frameTooSoon,
  idleDeadlineForTier,
  idleDeadlineFrom,
  initialStateFor,
  toPublicSession,
  type BrowserKind,
  type BrowserSessionRecord,
  type LeaseRequest,
} from "./browser-session.domain"

/** A mid-tier dedicated lease, overridden per case.
 * @param {Partial<LeaseRequest>} overrides The fields this case cares about.
 * @return {LeaseRequest} The request.
 */
const lease = (overrides: Partial<LeaseRequest>): LeaseRequest => ({
  tier: "paid",
  mode: "dedicated",
  kind: "chrome",
  liveSessions: 0,
  byoConfigured: false,
  ...overrides,
})

/** The refusal reason, or undefined when the lease was allowed.
 * @param {LeaseRequest} request The request under test.
 * @return {string | undefined} The reason, if any.
 */
const reasonOf = (request: LeaseRequest): string | undefined => {
  const decision = decideLease(request)
  return decision.ok ? undefined : decision.reason
}

describe("SESSION_CAPS", () => {
  it("pins the tier model as data", () => {
    assert.deepEqual(SESSION_CAPS.free, {
      dedicated: 0,
      byo: 0,
      fps: 0,
      idleTtlMs: 0,
    })
    assert.deepEqual(SESSION_CAPS.paid, {
      dedicated: 1,
      byo: 3,
      fps: 1,
      idleTtlMs: 15 * 60 * 1000,
    })
    assert.equal(SESSION_CAPS.admin.fps, 4)
    assert.equal(SESSION_CAPS.admin.dedicated, Number.POSITIVE_INFINITY)
    assert.equal(SESSION_CAPS.admin.byo, Number.POSITIVE_INFINITY)
  })

  it("gives an idle expiry to exactly one tier", () => {
    // Guards the `idleDeadlineFrom` footgun: a zero TTL must mean "no expiry".
    assert.ok(SESSION_CAPS.paid.idleTtlMs > 0)
    assert.equal(SESSION_CAPS.free.idleTtlMs, 0)
    assert.equal(SESSION_CAPS.admin.idleTtlMs, 0)
  })
})

describe("decideLease", () => {
  it("refuses free for every mode and kind, as quota", () => {
    // Free gets no browser; none of its six tools needs one. `quota` rather
    // than `byo-not-allowed` because there is no allowance to spend at all.
    for (const mode of ["dedicated", "byo"] as const) {
      for (const kind of BROWSER_KINDS) {
        const request = lease({tier: "free", mode, kind})
        assert.equal(reasonOf(request), "quota", `free/${mode}/${kind}`)
      }
    }
  })

  it("allows paid dedicated below the cap and refuses at it", () => {
    assert.equal(reasonOf(lease({})), undefined)
    const atCap = SESSION_CAPS.paid.dedicated
    assert.equal(reasonOf(lease({liveSessions: atCap})), "quota")
  })

  it("refuses a zero BYO cap before weighing configuration", () => {
    const configured = lease({
      tier: "free",
      mode: "byo",
      byoConfigured: true,
    })
    assert.equal(reasonOf(configured), "quota")
  })

  it("refuses BYO with no endpoint configured, on every tier", () => {
    const unconfigured = lease({mode: "byo", byoConfigured: false})
    assert.equal(reasonOf(unconfigured), "byo-not-allowed")

    // Including admin: uncapped in *number*, and an endpoint that does not
    // exist cannot be attached to.
    const adminUnconfigured = lease({
      tier: "admin",
      mode: "byo",
      byoConfigured: false,
    })
    assert.equal(reasonOf(adminUnconfigured), "byo-not-allowed")

    const configured = lease({mode: "byo", byoConfigured: true})
    assert.equal(reasonOf(configured), undefined)
  })

  it("refuses BYO above its own cap", () => {
    const atCap = lease({
      mode: "byo",
      byoConfigured: true,
      liveSessions: SESSION_CAPS.paid.byo,
    })
    assert.equal(reasonOf(atCap), "quota")
  })

  it("refuses an engine we cannot drive before asking about quota", () => {
    // Untyped input reaches this from HTTP, so the runtime list is what
    // protects it.
    const unknown = "webkit" as unknown as BrowserKind
    assert.equal(reasonOf(lease({kind: unknown})), "unsupported-kind")

    const adminUnknown = lease({
      kind: unknown,
      liveSessions: 99,
      tier: "admin",
    })
    assert.equal(reasonOf(adminUnknown), "unsupported-kind")
  })

  it("never refuses admin for count", () => {
    const many = lease({tier: "admin", liveSessions: 10_000})
    assert.equal(reasonOf(many), undefined)

    const manyByo = lease({
      tier: "admin",
      mode: "byo",
      byoConfigured: true,
      liveSessions: 10_000,
    })
    assert.equal(reasonOf(manyByo), undefined)
  })
})

describe("idleDeadlineFrom", () => {
  it("adds the ttl to the last activity", () => {
    assert.equal(idleDeadlineFrom(1_000_000, 900_000), 1_900_000)
  })
})

describe("decideCdpUrl", () => {
  it("accepts ws, wss and http discovery endpoints", () => {
    for (const url of [
      "wss://browser.example.com/devtools/browser/abc",
      "ws://browser.example.com:9222/devtools",
      "https://browser.example.com/json/version",
    ]) {
      assert.equal(decideCdpUrl(url).ok, true, url)
    }
  })

  it("refuses every address the worker must never dial", () => {
    // The Phase 0.4 hole: a BYO URL is dialled from a worker, so naming
    // loopback, cloud metadata, or a Fly internal host makes the caller an
    // SSRF probe.
    for (const url of [
      "ws://169.254.169.254/",
      "ws://127.0.0.1:9222/devtools",
      "ws://localhost:9222/devtools",
      "wss://_api.internal:4280/",
      "ws://10.0.0.5:9222/devtools",
      "wss://foo.internal/devtools",
      "ws://[::1]:9222/devtools",
    ]) {
      assert.equal(decideCdpUrl(url).ok, false, url)
    }
  })

  it("refuses other schemes, bad values, and over-long values", () => {
    const values: unknown[] = [
      "ftp://example.com/",
      "file:///etc/passwd",
      "not a url",
      "",
      "   ",
      undefined,
      7,
      {},
    ]
    for (const value of values) {
      assert.equal(decideCdpUrl(value).ok, false, String(value))
    }

    const long = `wss://example.com/${"a".repeat(4096)}`
    assert.equal(decideCdpUrl(long).ok, false)
  })

  it("returns the trimmed url so no padding is stored", () => {
    const decision = decideCdpUrl("  wss://browser.example.com/devtools  ")
    assert.equal(decision.ok, true)
    if (decision.ok) {
      assert.equal(decision.url, "wss://browser.example.com/devtools")
    }
  })
})

/** A stored record carrying both fields that must never be projected.
 * @param {Partial<BrowserSessionRecord>} overrides Fields for this case.
 * @return {BrowserSessionRecord} The record.
 */
const stored = (
  overrides: Partial<BrowserSessionRecord> = {},
): BrowserSessionRecord => {
  const base: BrowserSessionRecord = {
    id: "s1",
    mode: "dedicated",
    kind: "chrome",
    state: "starting",
    tier: "paid",
    machineId: "fly-machine-1234",
    cdpSecretPath: "projects/p/secrets/browser-cdp-u1",
    createdAt: 1_000,
    lastUsedAt: 1_000,
    idleDeadline: 1_900_000,
    minutesBilled: 0,
  }
  return {...base, ...overrides}
}

describe("toPublicSession", () => {
  it("drops the machine id and the secret pointer", () => {
    const projected = toPublicSession(stored())
    assert.deepEqual(Object.keys(projected).sort(), [
      "createdAt",
      "expiresAt",
      "id",
      "kind",
      "mode",
      "state",
    ])
  })

  it("names the idle deadline expiresAt", () => {
    assert.equal(toPublicSession(stored()).expiresAt, 1_900_000)
  })

  it("omits expiresAt for a tier that has no idle expiry", () => {
    // Written without the field at all: a zero TTL must not become a past date.
    const noDeadline: BrowserSessionRecord = {
      id: "s2",
      mode: "byo",
      kind: "obscura",
      state: "ready",
      tier: "admin",
      createdAt: 1_000,
      lastUsedAt: 1_000,
      minutesBilled: 0,
    }
    assert.equal(toPublicSession(noDeadline).expiresAt, undefined)
  })
})

describe("idleDeadlineForTier", () => {
  it("gives the paid tier a deadline and the others none", () => {
    assert.equal(idleDeadlineForTier("paid", 1_000), 1_000 + 15 * 60 * 1000)
    assert.equal(idleDeadlineForTier("free", 1_000), undefined)
    assert.equal(idleDeadlineForTier("admin", 1_000), undefined)
  })
})

describe("initialStateFor", () => {
  it("starts a byo session ready and a dedicated one starting", () => {
    assert.equal(initialStateFor("byo"), "ready")
    assert.equal(initialStateFor("dedicated"), "starting")
  })
})

describe("cdpSecretId", () => {
  it("is deterministic per uid and does not collide across uids", () => {
    assert.equal(cdpSecretId("u1"), cdpSecretId("u1"))
    assert.notEqual(cdpSecretId("u1"), cdpSecretId("u2"))
  })
})

/**
 * The frame pace.
 *
 * The arithmetic is pinned rather than inferred from `fps`: a cap that quietly
 * halved or doubled would be invisible in every other test here, because
 * nothing else reads `SESSION_CAPS.fps` at all.
 */
describe("frameIntervalMs", () => {
  it("turns each tier's fps into the matching pause", () => {
    // paid is one per second, admin four — so 1000ms and 250ms.
    assert.equal(frameIntervalMs("paid"), 1000)
    assert.equal(frameIntervalMs("admin"), 250)
  })

  it("is infinite for a tier with no browser", () => {
    // Not zero and not a large number: `frameTooSoon` compares against this, so
    // a finite value would let a frame through.
    assert.equal(frameIntervalMs("free"), Number.POSITIVE_INFINITY)
  })
})

describe("frameTooSoon", () => {
  it("lets the first frame through, so the view paints at once", () => {
    // Waiting out an interval for an image that has not been shown yet would
    // make opening the view feel broken rather than paced.
    assert.equal(frameTooSoon("paid", null), false)
    assert.equal(frameTooSoon("admin", null), false)
  })

  it("paces the frames that follow, per tier", () => {
    assert.equal(frameTooSoon("paid", 1000), false)
    assert.equal(frameTooSoon("paid", 900), true)
    // Admin is allowed four times as often.
    assert.equal(frameTooSoon("admin", 250), false)
    assert.equal(frameTooSoon("admin", 249), true)
    // A paid pace is slower than an admin one, so it is never too soon there.
    assert.equal(frameTooSoon("admin", 1000), false)
  })

  it("refuses every frame for a tier with no browser", () => {
    // The one mistake this predicate could make: reading "no browser" as a pace
    // and serving the opening frame anyway.
    assert.equal(frameTooSoon("free", null), true)
    assert.equal(frameTooSoon("free", 10_000), true)
  })

  it("treats the interval itself as allowed", () => {
    // An off-by-one here would halve or double the real cap.
    assert.equal(frameTooSoon("paid", frameIntervalMs("paid")), false)
    assert.equal(frameTooSoon("paid", frameIntervalMs("paid") - 1), true)
  })
})

describe("countLiveForMode", () => {
  const session = (
    mode: "byo" | "dedicated",
    state: "starting" | "ready" | "suspended" | "closed" = "ready",
  ) => ({mode, state})

  it("does not let one mode's sessions block the other mode's cap", () => {
    // The defect this guards: three BYO sessions refused the dedicated machine
    // the caller pays for, because the pre-flight counted both modes together.
    const sessions = [session("byo"), session("byo"), session("byo")]

    assert.equal(countLiveForMode(sessions, "byo"), 3)
    assert.equal(countLiveForMode(sessions, "dedicated"), 0)
  })

  it("ignores a closed session in either mode", () => {
    const sessions = [
      session("dedicated"),
      session("dedicated", "closed"),
      session("byo", "closed"),
    ]

    assert.equal(countLiveForMode(sessions, "dedicated"), 1)
    assert.equal(countLiveForMode(sessions, "byo"), 0)
  })
})
