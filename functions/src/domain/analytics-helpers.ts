/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */

import * as admin from "firebase-admin"
import net from "node:net"
import { DimensionFilter, MetricsDaily } from "./analytics-optimized.domain"

/**
 * Whether a guest's `lastSeen` is due to be written to Firestore.
 *
 * The throttle reads the timestamp of the previous persist out of the cached guest
 * record, so the hot path never has to fetch the document just to compare against
 * its stored `lastSeen`. An unknown timestamp persists once and then tracks itself.
 *
 * @param {unknown} persistedAt Epoch ms of the last persist, as cached.
 * @param {number} nowMs Current epoch ms.
 * @param {number} intervalMs Minimum interval between persists.
 * @return {boolean} True when the write is due.
 */
export function shouldPersistGuestLastSeen(persistedAt: unknown, nowMs: number, intervalMs: number): boolean {
  // Absent, non-finite, or ahead of the clock (skew, or a poisoned cache entry):
  // persist. `persistedAt > nowMs` would otherwise read as "just persisted" and
  // the guest would stop being reported active until the clock caught up.
  if (typeof persistedAt !== "number" || !Number.isFinite(persistedAt) || persistedAt <= 0 || persistedAt > nowMs) {
    return true
  }

  return nowMs - persistedAt > intervalMs
}

/**
 * Canonicalise a UTM value for grouping.
 *
 * Raw query strings fragment one campaign across `Spring+Sale`, `spring sale`, and
 * `SPRING_SALE`, so campaign sizes would depend on each ad platform's case and
 * separator conventions. Lowercase, collapse whitespace to underscores, cap length.
 *
 * @param {unknown} value Raw query-string value.
 * @return {string | undefined} Canonical value, or undefined when empty.
 */
export function normalizeUtm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase().replace(/[\s+]+/g, "_").slice(0, 60)
  // Strip the separator we just introduced, or `?utm_source=+` writes a channel
  // literally named `_` (and `"spring "` writes `spring_`). Caught by
  // analytics-events.spec.ts, which is the only reason this case is not live.
  const bounded = normalized.replace(/^_+|_+$/g, "")
  return bounded || undefined
}

/**
 * Which identity a cookie-less visitor is adopted into.
 *
 * Precedence matters: the fingerprint is the closest thing to "this same
 * browser", the IP index is the coarser fallback that stops duplicate guest
 * documents. Callers pass the lookups they already made; this only picks the
 * winner, which keeps the rule testable without a live request.
 * @param {*} candidates
 * @return {*}
 */
export function resolveGuestIdentity(candidates: {
    fingerprintGuestId?: string | null
    ipGuestId?: string | null
}): {guestId: string | null, source: "fingerprint" | "ip" | "new"} {
  const fingerprint = candidates.fingerprintGuestId || null
  if (fingerprint) return {guestId: fingerprint, source: "fingerprint"}

  const ip = candidates.ipGuestId || null
  if (ip) return {guestId: ip, source: "ip"}

  return {guestId: null, source: "new"}
}

/**
 * Bucket for a guest whose address no provider can resolve.
 *
 * Deliberately distinct from the "Unknown" the geo mappers produce for an answered
 * request that carried no country: this one means the question was never worth asking,
 * and the admin panel's region rows are read by operators as "where is my traffic".
 * Shared so the writer (session enrichment) and the dimension keys cannot drift.
 */
export const NON_ROUTABLE_GEO_LABEL = "Non-routable"

/**
 * Whether an address can never belong to a real remote client.
 *
 * IANA special-purpose ranges (RFC 6890) are not globally routed, so no provider
 * can resolve one: ipregistry answers `203.0.113.9` with a null country, an empty
 * location, and `security.is_bogon` set -- an artefact of the range, not a fact
 * about a visitor. The list here and the one in the session enrichment covered
 * loopback and private ranges but not the documentation and reserved blocks, so a
 * lookup was still paid for, and the admin panel filed those guests under
 * "Unknown" regions next to visitors nobody could resolve.
 *
 * Also the range a caller can invent: X-Forwarded-For is attacker-influenced up to
 * the edge, so this has to be decided locally rather than asked of a provider.
 *
 * @param {string | null | undefined} ip Candidate address.
 * @return {boolean} True when no region can ever be resolved for it.
 */
export function isNonRoutableIp(ip: string | null | undefined): boolean {
  const value = String(ip || "").trim().toLowerCase()
  if (!value || value === "localhost" || net.isIP(value) === 0) return true

  // ponytail: regex heuristic, swap for an ipaddr.js range check if a range is
  // ever missed. v4-mapped addresses arrive already unwrapped by normalizePublicIp.
  if (/^(0\.|10\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.0\.0\.|192\.0\.2\.|192\.168\.|198\.(18|19)\.|198\.51\.100\.|203\.0\.113\.|2(2[4-9]|[3-9]\d)\.|(24\d|25[0-5])\.)/.test(value)) {
    return true
  }

  // Anchored per alternative on purpose: the previous unanchored `f[cd]` matched a
  // public address that merely contained those letters.
  return /^(::|f[cd]|fe80)/.test(value)
}

/**
 * Is this client IP specific enough to identify a guest by?
 *
 * Headers are attacker-influenced up to the edge, and behind an unforwarded
 * internal address (Cloud Run, a private network) every visitor shares one
 * value -- indexing those would merge unrelated guests into a single document,
 * the opposite of the intent. Exactly the inverse of non-routable, so the two
 * answers cannot drift apart.
 * @param {*} ip
 * @return {*}
 */
export function isIndexableGuestIp(ip: string | null | undefined): boolean {
  return !isNonRoutableIp(ip)
}

/**
 * Name of the consent cookie. Written by the Angular banner
 * (`src/app/core/components/cookie-consent`), read by `guestTracker`.
 *
 * ponytail: the literal is repeated in that component -- the cookie is the only
 * channel between the browser and the middleware, so there is nothing to import
 * it from. Both sides assert it, which is what catches a rename.
 */
export const CONSENT_COOKIE = "consent"

/**
 * Whether this visitor consented to analytics.
 *
 * ePrivacy Art. 5(3) requires consent before a non-essential cookie is set, and
 * `guestTracker` stores more than a cookie: `sha256(ip|user-agent|os|device)` is
 * a device fingerprint, which is personal data on its own. The privacy policy
 * already promised analytics "with your consent", so the record waits for an
 * answer instead of being created behind the visitor.
 *
 * Only an explicit `granted` counts. Absent, `denied`, a typo and a hand-edited
 * cookie all mean no -- consent is opt-in, so the conservative branch is the
 * only correct default.
 * @param {*} cookies Parsed request cookies.
 * @return {boolean} True only on an explicit grant.
 */
export function hasAnalyticsConsent(cookies: Record<string, unknown> | undefined | null): boolean {
  return String(cookies?.[CONSENT_COOKIE] ?? "").trim().toLowerCase() === "granted"
}

/**
 * Convert period shorthand to date range
 */
/**
 * periodToDateRange
 * @param {*} period
 * @return {*}
 */
export function periodToDateRange(period: string):
{ startDate: string; endDate: string } {
  const today = new Date()
  const formatDate = (date: Date) => date.toISOString().split("T")[0]

  switch (period) {
  case "today":
    return { startDate: formatDate(today), endDate: formatDate(today) }

  case "yesterday": {
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    return { startDate: formatDate(yesterday), endDate: formatDate(yesterday) }
  }

  case "last7days": {
    const sevenDaysAgo = new Date(today)
    sevenDaysAgo.setDate(today.getDate() - 7)
    return { startDate: formatDate(sevenDaysAgo), endDate: formatDate(today) }
  }

  case "last30days": {
    const thirtyDaysAgo = new Date(today)
    thirtyDaysAgo.setDate(today.getDate() - 30)
    return { startDate: formatDate(thirtyDaysAgo), endDate: formatDate(today) }
  }

  case "last90days": {
    const ninetyDaysAgo = new Date(today)
    ninetyDaysAgo.setDate(today.getDate() - 90)
    return { startDate: formatDate(ninetyDaysAgo), endDate: formatDate(today) }
  }

  case "thisMonth": {
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1)
    return { startDate: formatDate(firstDay), endDate: formatDate(today) }
  }

  case "lastMonth": {
    const firstDayLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const lastDayLastMonth = new Date(today.getFullYear(), today.getMonth(), 0)
    return { startDate: formatDate(firstDayLastMonth), endDate: formatDate(lastDayLastMonth) }
  }

  case "thisYear": {
    const firstDay = new Date(today.getFullYear(), 0, 1)
    return { startDate: formatDate(firstDay), endDate: formatDate(today) }
  }

  default:
    return { startDate: formatDate(today), endDate: formatDate(today) }
  }
}

/**
 * Filter metrics by dimension filters
 */
/**
 * filterByDimensions
 * @param {*} data
 * @param {*} filter
 * @return {*}
 */
export function filterByDimensions(data: MetricsDaily[], filter: DimensionFilter): MetricsDaily[] {
  if (!filter.country && !filter.device && !filter.browser && !filter.provider) {
    return data // No filters applied
  }

  return data.map((dayMetrics) => {
    const filtered = { ...dayMetrics }

    // Filter by country
    if (filter.country) {
      const countries = Array.isArray(filter.country) ? filter.country : [filter.country]
      filtered.byCountry = Object.fromEntries(
        Object.entries(dayMetrics.byCountry || {}).filter(([country]) =>
          countries.includes(country)
        )
      )
    }

    // Filter by device (map device types to actual device names)
    if (filter.device) {
      const deviceMap: { [key: string]: string[] } = {
        desktop: ["Windows", "Mac", "Linux", "Other"],
        mobile: ["Mobile", "iPhone", "Android"],
        tablet: ["iPad", "Tablet"],
      }
      const deviceNames = deviceMap[filter.device as keyof typeof deviceMap] || [filter.device]
      filtered.byDevice = Object.fromEntries(
        Object.entries(dayMetrics.byDevice || {}).filter(([device]) =>
          deviceNames.some((name: string) => device.toLowerCase().includes(name.toLowerCase()))
        )
      )
    }

    // Filter by browser
    if (filter.browser) {
      const browsers = Array.isArray(filter.browser) ? filter.browser : [filter.browser]
      filtered.byBrowser = Object.fromEntries(
        Object.entries(dayMetrics.byBrowser || {}).filter(([browser]) =>
          browsers.includes(browser)
        )
      )
    }

    // Filter by provider
    if (filter.provider) {
      const providerMap: { [key: string]: string[] } = {
        google: ["google.com"],
        github: ["github.com"],
        password: ["password"],
        phone: ["phone"],
      }
      const providerNames = providerMap[filter.provider as keyof typeof providerMap] || [filter.provider]
      filtered.byProvider = Object.fromEntries(
        Object.entries(dayMetrics.byProvider || {}).filter(([provider]) =>
          providerNames.includes(provider)
        )
      )
    }

    return filtered
  })
}

/**
 * Aggregate metrics by granularity (daily, weekly, monthly)
 */
/**
 * aggregateByGranularity
 * @param {*} data
 * @param {*} granularity
 * @return {*}
 */
export function aggregateByGranularity(
  data: MetricsDaily[],
  granularity: "daily" | "weekly" | "monthly"
): MetricsDaily[] {
  if (granularity === "daily") {
    return data // Already daily
  }

  // Group by week or month
  const groups = new Map<string, MetricsDaily[]>()

  data.forEach((dayMetrics) => {
    const date = new Date(dayMetrics.date)
    let key: string

    if (granularity === "weekly") {
      // Get week start (Monday)
      const dayOfWeek = date.getDay()
      const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
      const weekStart = new Date(date)
      weekStart.setDate(date.getDate() + diff)
      key = weekStart.toISOString().split("T")[0]
    } else {
      // Monthly
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`
    }

    if (!groups.has(key)) {
      groups.set(key, [])
    }
    const group = groups.get(key)
    if (group) {
      group.push(dayMetrics)
    }
  })

  // Aggregate each group
  return Array.from(groups.entries()).map(([key, metrics]) => {
    const aggregated: MetricsDaily = {
      date: key,
      timestamp: admin.firestore.Timestamp.now(),
      totalGuests: 0,
      newGuests: 0,
      activeGuests: 0,
      totalUsers: 0,
      newUsers: 0,
      activeUsers: 0,
      totalLogins: 0,
      loginsByHour: {},
      guestsByHour: {},
      usersByHour: {},
      guestConversions: 0,
      conversionRate: 0,
      byCountry: {},
      byBrowser: {},
      byDevice: {},
      byOS: {},
      byProvider: {},
      byTimezone: {},
      topCountries: [],
      topBrowsers: [],
      updatedAt: admin.firestore.Timestamp.now(),
    }

    metrics.forEach((m) => {
      aggregated.totalGuests += m.totalGuests || 0
      aggregated.newGuests += m.newGuests || 0
      aggregated.activeGuests += m.activeGuests || 0
      aggregated.totalUsers += m.totalUsers || 0
      aggregated.newUsers += m.newUsers || 0
      aggregated.activeUsers += m.activeUsers || 0
      aggregated.totalLogins += m.totalLogins || 0
      aggregated.guestConversions += m.guestConversions || 0

      // Aggregate hourly logins
      Object.entries(m.loginsByHour || {}).forEach(([k, v]) => {
        aggregated.loginsByHour[k] = (aggregated.loginsByHour[k] || 0) + v
      })

      // Aggregate by dimensions
      Object.entries(m.byCountry || {}).forEach(([k, v]) => {
        aggregated.byCountry[k] = (aggregated.byCountry[k] || 0) + v
      })
      Object.entries(m.byBrowser || {}).forEach(([k, v]) => {
        aggregated.byBrowser[k] = (aggregated.byBrowser[k] || 0) + v
      })
      Object.entries(m.byDevice || {}).forEach(([k, v]) => {
        aggregated.byDevice[k] = (aggregated.byDevice[k] || 0) + v
      })
      Object.entries(m.byOS || {}).forEach(([k, v]) => {
        aggregated.byOS[k] = (aggregated.byOS[k] || 0) + v
      })
      Object.entries(m.byProvider || {}).forEach(([k, v]) => {
        aggregated.byProvider[k] = (aggregated.byProvider[k] || 0) + v
      })
      Object.entries(m.byTimezone || {}).forEach(([k, v]) => {
        aggregated.byTimezone[k] = (aggregated.byTimezone[k] || 0) + v
      })
    })

    // Calculate conversion rate
    aggregated.conversionRate = aggregated.newGuests > 0 ?
      (aggregated.guestConversions / aggregated.newGuests) * 100 : 0

    return aggregated
  })
}

/**
 * Get top N entries from a dimension object
 */
/**
 * getTopN
 * @param {*} obj
 * @param {*} n
 * @return {*}
 */
export function getTopN<T extends Record<string, number>>(
  obj: T,
  n: number
): Array<{ key: string; value: number }> {
  return Object.entries(obj)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([key, value]) => ({ key, value }))
}
