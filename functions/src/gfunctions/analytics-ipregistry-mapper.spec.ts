/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import assert from "node:assert/strict"
import test from "node:test"
import {mapIpregistryResponse} from "./analytics"

test("mapIpregistryResponse maps an ipregistry payload into ResolvedGeoData", () => {
  const result = mapIpregistryResponse({
    ip: "203.0.113.5",
    location: {
      country: {code: "US", name: "United States"},
      region: {name: "California"},
      city: "Mountain View",
      latitude: 37.38605,
      longitude: -122.08385,
    },
    connection: {
      asn: 15169,
      domain: "example.com",
      organization: "Example Hosting LLC",
      type: "hosting",
    },
    time_zone: {id: "America/Los_Angeles"},
    security: {
      is_proxy: false,
      is_vpn: true,
      is_tor: false,
      is_threat: false,
    },
  }, "203.0.113.5")

  assert.ok(result)
  assert.equal(result!.countryShort, "US")
  assert.equal(result!.countryLong, "United States")
  assert.equal(result!.region, "California")
  assert.equal(result!.city, "Mountain View")
  assert.equal(result!.latitude, 37.38605)
  assert.equal(result!.longitude, -122.08385)
  assert.equal(result!.timeZone, "America/Los_Angeles")
  assert.equal(result!.asn, "15169")
  assert.equal(result!.as, "Example Hosting LLC")
  assert.equal(result!.isp, "Example Hosting LLC")
  assert.equal(result!.domain, "example.com")
  assert.equal(result!.usageType, "hosting")
  assert.equal(result!.proxy.isProxy, true)
  assert.equal(result!.proxy.proxyType, "vpn")
  assert.equal(result!.proxy.confidence, "open-proxy-detected")
})

test("mapIpregistryResponse returns null when country code is missing", () => {
  const result = mapIpregistryResponse({
    ip: "192.0.2.1",
    location: {region: {name: "Unknown"}},
  }, "192.0.2.1")

  assert.equal(result, null)
})

test("mapIpregistryResponse marks a tor connection as proxy with tor type", () => {
  const result = mapIpregistryResponse({
    ip: "198.51.100.7",
    location: {country: {code: "DE", name: "Germany"}},
    security: {is_tor: true},
  }, "198.51.100.7")

  assert.ok(result)
  assert.equal(result!.proxy.isProxy, true)
  assert.equal(result!.proxy.proxyType, "tor")
  assert.equal(result!.timeZone, "UTC")
})
