/* eslint-disable max-len */
import assert from "node:assert/strict"
import test from "node:test"

import {buildGeoDimensionCounters, guestTimelineBuckets, type GeoDimensionSource} from "./analytics-realtime"

const keysOf = (guest: GeoDimensionSource): string[] => Object.keys(buildGeoDimensionCounters(guest)).sort()

test("an enriched guest lands in the real buckets, never in Unknown", () => {
  const keys = keysOf({
    country: "Greece",
    region: "Attica",
    location: "Athens",
    timezone: "Europe/Athens",
    latitude: 37.98,
    longitude: 23.72,
    network: {asn: 12345, as: "OTE", domain: "ote.gr", usageType: "isp"},
    proxy: {isProxy: false},
  })

  assert.ok(keys.includes("byCountry.Greece"), "country must use the resolved name")
  assert.ok(keys.includes("byRegion.Attica"), "region must use the resolved name")
  assert.ok(keys.includes("byTimezone.Europe/Athens"), "timezone must use the resolved zone")
  assert.ok(keys.includes("byLocation.Athens"), "city must be counted")
  assert.ok(keys.includes("byGeoCell.38.0,23.7"), "geo cell must use the rounded coordinates")
  assert.ok(keys.includes("byASN.12345"), "ASN must come from the enriched network object")
  assert.ok(keys.includes("byAS.OTE"), "AS must expose the organisation name")
  assert.ok(keys.includes("byISP.OTE"), "ISP must prefer the AS name")
  assert.ok(keys.includes("byUsageType.isp"), "connection type separates hosting from residential")
  assert.ok(keys.includes("byDomain.ote.gr"), "the AS/company domain must be counted")
  assert.ok(keys.includes("byProxyType.direct"), "a clean connection is direct")
  assert.ok(keys.includes("byThreat.none"), "a resolved clean IP is none, not Unknown")
})

test("never-enriched guests are Unknown, so a clean IP is not mistaken for one", () => {
  // This is exactly what `guestTracker` writes before `enrichGuestGeo` runs.
  const keys = keysOf({
    country: "Unknown",
    region: "Unknown",
    location: "Unknown",
    timezone: "UTC",
    latitude: 0,
    longitude: 0,
  })

  assert.ok(keys.includes("byCountry.Unknown"))
  assert.ok(keys.includes("byRegion.Unknown"))
  assert.ok(keys.includes("byTimezone.UTC"))
  assert.ok(keys.includes("byASN.Unknown"), "ASN needs the same fallback as the other dims")
  assert.ok(keys.includes("byAS.Unknown"), "AS needs the same fallback as the other dims")
  assert.ok(keys.includes("byISP.Unknown"), "ISP needs the same fallback as the other dims")
  assert.ok(keys.includes("byThreat.Unknown"), "an unresolved IP is not a clean IP")
  assert.equal(keys.length, 14, "every geo dimension is emitted exactly once per guest")
})

test("a tor connection is counted as a proxy, not as direct", () => {
  const keys = keysOf({country: "Greece", proxy: {isProxy: true, proxyType: "tor"}})
  assert.ok(keys.includes("byProxyType.tor"))
})

test("a deliberately skipped guest gets its own region bucket", () => {
  // What session enrichment writes for a reserved address (TEST-NET-3, a private range):
  // the operator must be able to tell "not a routable visitor" from "we could not resolve
  // this one", because only the second is worth investigating. The literal is asserted on
  // purpose -- renaming the bucket breaks this test instead of silently re-merging the rows.
  const keys = keysOf({
    country: "Non-routable",
    region: "Non-routable",
    location: "Non-routable",
    timezone: "UTC",
    latitude: 0,
    longitude: 0,
  })

  assert.ok(keys.includes("byCountry.Non-routable"))
  assert.ok(keys.includes("byRegion.Non-routable"))
  assert.ok(keys.includes("byLocation.Non-routable"))
  assert.ok(!keys.includes("byCountry.Unknown"), "a skipped guest is not an unresolved one")
})

test("a threat-flagged IP is counted under its own flag", () => {
  const keys = keysOf({country: "Greece", proxy: {isProxy: true, proxyType: "vpn", threat: "is_abuser"}})
  assert.ok(keys.includes("byThreat.is_abuser"))
  assert.ok(keys.includes("byProxyType.vpn"))
})

test("the timeline bucket follows the guest's own createdAt", () => {
  const instant = new Date(Date.UTC(2026, 8, 15, 13, 5))
  const {date, hourKey, minuteKey} = guestTimelineBuckets(instant)
  const expectedHour = String(instant.getHours()).padStart(2, "0")
  const expectedMinute = String(instant.getMinutes()).padStart(2, "0")
  assert.equal(date, "2026-09-15")
  assert.equal(hourKey, `2026-09-15-${expectedHour}`)
  // The minutely key must extend the hourly one, so both land in the same timeline slot.
  assert.equal(minuteKey, `${hourKey}-${expectedMinute}`)

  // A Firestore Timestamp must bucket identically to the Date it wraps.
  const firestoreLike = {toDate: () => instant}
  assert.deepEqual(guestTimelineBuckets(firestoreLike), {date, hourKey, minuteKey})
})
