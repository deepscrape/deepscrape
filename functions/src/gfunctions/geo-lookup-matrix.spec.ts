/* eslint-disable max-len */
import assert from "node:assert/strict"
import test from "node:test"

type LookupSuccessResponse = {
  data?: {
    lookup?: {
      ip?: string
      location?: {
        countryCode?: string | null
      }
      coverage?: {
        geo?: boolean
        proxy?: boolean
      }
    }
  }
}

type CallResult = {
  status: number
  bodyText: string
  json: unknown
}

const BASE_URL = (process.env["GEO_LOOKUP_BASE_URL"] || "https://ip.deepscrape.dev").replace(/\/+$/, "")
const USER_ID = process.env["GEO_LOOKUP_USER_ID"] || "dev-user-1"
// Live-integration suite: only runs when explicitly opted in (see scripts/geo-lookup-prod-matrix.ps1).
const RUN_LIVE_GEO = (process.env["GEO_RUN_LIVE_TESTS"] || "").toLowerCase() === "true"

/**
 * endpoint
 * @param {*} path
 * @return {*}
 */
function endpoint(path: string): string {
  return `${BASE_URL}${path}`
}

/**
 * callGeoLookup
 * @param {*} path
 * @param {*} headers
 */
async function callGeoLookup(path: string, headers: Record<string, string> = {}): Promise<CallResult> {
  const response = await fetch(endpoint(path), {
    method: "GET",
    headers,
  })

  const bodyText = await response.text()
  let json: unknown = null

  try {
    json = bodyText ? JSON.parse(bodyText) : null
  } catch {
    json = null
  }

  return {
    status: response.status,
    bodyText,
    json,
  }
}

/**
 * getResolvedIp
 * @param {*} result
 * @return {*}
 */
function getResolvedIp(result: CallResult): string | undefined {
  const parsed = result.json as LookupSuccessResponse
  return parsed?.data?.lookup?.ip
}

/**
 * assertStatus
 * @param {*} result
 * @param {*} expected
 * @param {*} message
 */
function assertStatus(result: CallResult, expected: number, message: string): void {
  assert.equal(
    result.status,
    expected,
    `${message}. expected=${expected} actual=${result.status} body=${result.bodyText}`
  )
}

test("geo lookup matrix: explicit IPv4 returns 200 and exact IP", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup?ip=8.8.8.8", {
    "x-user-id": USER_ID,
  })

  assertStatus(result, 200, "explicit IPv4 should succeed")
  assert.equal(getResolvedIp(result), "8.8.8.8", `explicit IPv4 must resolve exact IP. body=${result.bodyText}`)
})

test("geo lookup matrix: explicit IPv6 returns 200 and exact IP", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup?ip=2001:4860:4860::8888", {
    "x-user-id": USER_ID,
  })

  assertStatus(result, 200, "explicit IPv6 should succeed")
  assert.equal(getResolvedIp(result), "2001:4860:4860::8888", `explicit IPv6 must resolve exact IP. body=${result.bodyText}`)
})

test("geo lookup matrix: invalid IP returns 400", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup?ip=not-an-ip", {
    "x-user-id": USER_ID,
  })

  assertStatus(result, 400, "invalid IP should return 400")
})

test("geo lookup matrix: missing auth returns 401", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup?ip=8.8.8.8")

  assertStatus(result, 401, "missing auth should return 401")
})

test("geo lookup matrix: private localhost IP is accepted format", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup?ip=127.0.0.1", {
    "x-user-id": USER_ID,
  })

  assertStatus(result, 200, "private localhost IP should be accepted")
  assert.equal(getResolvedIp(result), "127.0.0.1", `private IP should echo resolved IP. body=${result.bodyText}`)
})

test("geo lookup priority: query ip overrides forwarding headers", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup?ip=8.8.4.4", {
    "x-user-id": USER_ID,
    "cf-connecting-ip": "1.1.1.1",
    "x-forwarded-for": "9.9.9.9, 10.0.0.2",
    "x-real-ip": "8.8.8.8",
  })

  assertStatus(result, 200, "query ip override test should succeed")
  assert.equal(getResolvedIp(result), "8.8.4.4", `query ip must take precedence. body=${result.bodyText}`)
})

test("geo lookup priority: cf-connecting-ip overrides x-forwarded-for and x-real-ip", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup", {
    "x-user-id": USER_ID,
    "cf-connecting-ip": "1.1.1.1",
    "x-forwarded-for": "9.9.9.9, 10.0.0.2",
    "x-real-ip": "8.8.8.8",
  })

  assertStatus(result, 200, "cf-connecting-ip precedence test should succeed")
  assert.equal(getResolvedIp(result), "1.1.1.1", `cf-connecting-ip must take precedence. body=${result.bodyText}`)
})

test("geo lookup priority: x-forwarded-for first value overrides x-real-ip", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup", {
    "x-user-id": USER_ID,
    "x-forwarded-for": "9.9.9.9, 10.0.0.2",
    "x-real-ip": "8.8.8.8",
  })

  assertStatus(result, 200, "x-forwarded-for precedence test should succeed")
  assert.equal(getResolvedIp(result), "9.9.9.9", `x-forwarded-for first value must take precedence. body=${result.bodyText}`)
})

test("geo lookup priority: x-real-ip is used when query/cf/xff are absent", {skip: !RUN_LIVE_GEO}, async () => {
  const result = await callGeoLookup("/api/geo/lookup", {
    "x-user-id": USER_ID,
    "x-real-ip": "8.8.8.8",
  })

  assertStatus(result, 200, "x-real-ip fallback test should succeed")
  assert.equal(getResolvedIp(result), "8.8.8.8", `x-real-ip must be used as fallback. body=${result.bodyText}`)
})
