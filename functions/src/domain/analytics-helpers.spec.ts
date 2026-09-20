/* eslint-disable max-len */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  filterByDimensions,
  getTopN,
  hasAnalyticsConsent,
  isIndexableGuestIp,
  isNonRoutableIp,
  periodToDateRange,
  resolveGuestIdentity,
  shouldPersistGuestLastSeen,
} from "./analytics-helpers"

describe("analytics-helpers", () => {
  it("shouldPersistGuestLastSeen throttles from the cached timestamp alone", () => {
    const now = 1_800_000_000_000
    const interval = 5 * 60 * 1000

    assert.equal(shouldPersistGuestLastSeen(now - interval - 1, now, interval), true, "just past the interval")
    assert.equal(shouldPersistGuestLastSeen(now - interval, now, interval), false, "exactly at the interval")
    assert.equal(shouldPersistGuestLastSeen(now - 1000, now, interval), false, "recently persisted")
  })

  it("hasAnalyticsConsent only accepts an explicit grant", () => {
    assert.equal(hasAnalyticsConsent({consent: "granted"}), true, "explicit grant")
    assert.equal(hasAnalyticsConsent({consent: "GRANTED"}), true, "case-insensitive")
    assert.equal(hasAnalyticsConsent({consent: " granted "}), true, "surrounding whitespace tolerated")
  })

  it("hasAnalyticsConsent treats everything else as no", () => {
    // The regression this guards: guestTracker minted a one-year `gid` cookie and
    // a guest document on every anonymous request, with no consent at all.
    assert.equal(hasAnalyticsConsent(undefined), false, "no cookie header")
    assert.equal(hasAnalyticsConsent({}), false, "consent cookie absent")
    assert.equal(hasAnalyticsConsent({consent: "denied"}), false, "declined")
    assert.equal(hasAnalyticsConsent({consent: ""}), false, "empty value")
    assert.equal(hasAnalyticsConsent({consent: 1}), false, "non-string value")
    assert.equal(hasAnalyticsConsent({consent: "true"}), false, "truthy is not the token")
    assert.equal(hasAnalyticsConsent({consent: "granted.nope"}), false, "suffix does not match")
  })

  it("shouldPersistGuestLastSeen persists when the cache cannot answer", () => {
    const now = 1_800_000_000_000

    for (const unknown of [undefined, null, 0, -1, NaN, "1800000000000"]) {
      assert.equal(shouldPersistGuestLastSeen(unknown, now, 5 * 60 * 1000), true, `${String(unknown)} must persist`)
    }

    // A timestamp ahead of the clock must not read as "just persisted".
    assert.equal(shouldPersistGuestLastSeen(now + 1, now, 5 * 60 * 1000), true)
  })

  it("resolveGuestIdentity prefers the fingerprint, then the IP index", () => {
    const both = resolveGuestIdentity({fingerprintGuestId: "g-fp", ipGuestId: "g-ip"})
    assert.deepEqual(both, {guestId: "g-fp", source: "fingerprint"})

    const ipOnly = resolveGuestIdentity({fingerprintGuestId: null, ipGuestId: "g-ip"})
    assert.deepEqual(ipOnly, {guestId: "g-ip", source: "ip"})
  })

  it("resolveGuestIdentity reports a new visitor rather than adopting an empty id", () => {
    // The regression this guards: an empty-string cache hit read as a value would
    // either adopt a guest that does not exist or mint a duplicate document.
    assert.deepEqual(resolveGuestIdentity({}), {guestId: null, source: "new"})
    assert.deepEqual(resolveGuestIdentity({fingerprintGuestId: "", ipGuestId: ""}), {
      guestId: null,
      source: "new",
    })
  })

  it("isIndexableGuestIp rejects addresses that identify nobody", () => {
    // Every visitor behind these shares one value, so indexing any of them would
    // merge unrelated guests into a single document -- the opposite of the intent.
    const shared = ["", "unknown", "127.0.0.1", "::1", "10.1.2.3", "192.168.0.4", "172.16.5.9",
      "169.254.1.1", "100.64.0.1", "fd00::1", "fe80::1", "not-an-ip"]

    for (const value of shared) {
      assert.equal(isIndexableGuestIp(value), false, `${value} must not index`)
    }

    // Public client addresses do index, including the edges of the ranges above.
    const publicIps = ["79.166.58.202", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2a00:1450:4001::200e"]

    for (const value of publicIps) {
      assert.equal(isIndexableGuestIp(value), true, `${value} must index`)
    }
  })

  it("isNonRoutableIp covers the documentation and reserved blocks", () => {
    // The live symptom: ipregistry answers 203.0.113.9 (TEST-NET-3, RFC 5737) with a
    // null country and `security.is_bogon`. No provider can resolve it, so the lookup
    // was spent for nothing and the guest sat in the panel's "Unknown" region bucket
    // next to visitors that had merely not been enriched yet.
    const reserved = ["203.0.113.9", "198.51.100.7", "192.0.2.1", "0.0.0.0", "224.0.0.1",
      "255.255.255.255", "localhost"]

    for (const value of reserved) {
      assert.equal(isNonRoutableIp(value), true, `${value} is not globally routable`)
    }

    // The edges of those ranges, so a widened regex cannot swallow the neighbours.
    const routable = ["203.0.114.9", "198.51.101.1", "192.0.3.1", "223.255.255.255", "172.32.0.1"]

    for (const value of routable) {
      assert.equal(isNonRoutableIp(value), false, `${value} is globally routable`)
    }
  })

  it("periodToDateRange returns same day for today and yesterday shapes", () => {
    const today = periodToDateRange("today")
    const yesterday = periodToDateRange("yesterday")

    assert.match(today.startDate, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(today.startDate, today.endDate)
    assert.match(yesterday.startDate, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(yesterday.startDate, yesterday.endDate)
  })

  it("periodToDateRange falls back safely for unknown period", () => {
    const fallback = periodToDateRange("not-a-period")
    assert.match(fallback.startDate, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(fallback.startDate, fallback.endDate)
  })

  it("filterByDimensions applies country and browser filters", () => {
    const input = [{
      date: "2026-03-19",
      byCountry: {GR: 5, US: 4},
      byBrowser: {Chrome: 8, Firefox: 1},
      byDevice: {Mobile: 3, Windows: 6},
      byProvider: {"google.com": 7, "password": 2},
    }]

    const filtered = filterByDimensions(input as never, {
      country: ["GR"],
      browser: "Chrome",
    }) as Array<{
      byCountry: Record<string, number>
      byBrowser: Record<string, number>
    }>

    assert.deepEqual(filtered[0].byCountry, {GR: 5})
    assert.deepEqual(filtered[0].byBrowser, {Chrome: 8})
  })

  it("filterByDimensions maps provider and device aliases", () => {
    const input = [{
      date: "2026-03-19",
      byCountry: {GR: 5},
      byBrowser: {Chrome: 8},
      byDevice: {Mobile: 3, iPhone: 2, Windows: 6},
      byProvider: {"google.com": 7, "password": 2},
    }]

    const providerFiltered = filterByDimensions(input as never, {
      provider: "google",
    }) as Array<{ byProvider: Record<string, number> }>

    const deviceFiltered = filterByDimensions(input as never, {
      device: "mobile",
    }) as Array<{ byDevice: Record<string, number> }>

    assert.deepEqual(providerFiltered[0].byProvider, {"google.com": 7})
    assert.deepEqual(deviceFiltered[0].byDevice, {Mobile: 3, iPhone: 2})
  })

  it("getTopN sorts descending and limits entries", () => {
    const result = getTopN({A: 10, C: 3, B: 7}, 2)

    assert.deepEqual(result, [
      {key: "A", value: 10},
      {key: "B", value: 7},
    ])
  })
})
