/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */

import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { FieldValue, Timestamp } from "firebase-admin/firestore"


import {
  ANALYTICS_EVENTS,
  ANALYTICS_EVENTS_RETENTION_DAYS,
  AnalyticsEvent,
  buildAnalyticsEvent,
  Guest,
  loginHistoryInfo,
  MetricsDaily,
  toEventDate,
  toFunnelCounterKeys,
  Users,
} from "../domain"
import { db, dbName } from "../app/config"
import { redis } from "../app/cacheConfig"
import {
  ONLINE_GUESTS_KEY,
  ONLINE_USERS_KEY,
  PRESENCE_WINDOWS_MS,
  consentDecisionKey,
  trafficDailyKey,
} from "../../../src/config/redis-keys"
import { PRESENCE_WINDOW_COUNTS } from "../../../src/config/redis-scripts"
import { parseUA } from "../infrastructure/ua-parser"
import { functionsEnvJson } from "../config/env"
import { drainClientAnalyticsEvents } from "./analytics"

// ⭐ CRITICAL: Specify named database for v2 triggers
const DATABASE_NAME = dbName || "easyscrape"

// Firestore reads a dot in a dotted field path as nesting, so path-like keys are flattened.
const toFieldKey = (value: string): string => value.replace(/[.$]/g, "_").slice(0, 120)

const mapToTop = (source: Record<string, number> | undefined, key: string, limit = 10) => {
  if (!source) return [] as Array<Record<string, unknown>>
  return Object.entries(source)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, limit)
    .map(([name, count]) => ({ [key]: name, count }))
}

// ponytail: a top-15 list is all the panel renders, so keep only the head of any
// breakdown whose cardinality grows with traffic. `byIP` is the only such group, and an
// accumulated 90-day map is the one that can cross the 1 MB document limit (which would
// fail the whole `metrics_range` write, not just the IP card). Ceiling: counts past the
// cap are dropped for aggregates — move to per-(day, IP) documents queried with
// orderBy('count','desc').limit(15) if the tail is ever needed.
const IP_BREAKDOWN_CAP = 500
const capBreakdown = (breakdown: Record<string, number>, cap: number): Record<string, number> =>
  Object.keys(breakdown).length <= cap ? breakdown :
    Object.fromEntries(Object.entries(breakdown).sort((a, b) => b[1] - a[1]).slice(0, cap))

// Realtime triggers store breakdowns as flat dotted fields (byBrowser.Chrome)
// via set({merge}); scheduled readers expect nested maps. Normalize both forms.
// ponytail: read-time normalization fixes existing flat days without touching the write path.
const collectBreakdown = (
  doc: Record<string, unknown> | undefined,
  prefix: string,
): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!doc) return out

  const nested = doc[prefix]
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
      out[k] = (out[k] || 0) + Number(v || 0)
    }
  }

  for (const k of Object.keys(doc)) {
    if (k.startsWith(`${prefix}.`)) {
      const dim = k.slice(prefix.length + 1)
      out[dim] = (out[dim] || 0) + Number(doc[k] || 0)
    }
  }

  return out
}

const toLatitudeBand = (latitude?: number) => {
  if (!Number.isFinite(latitude)) return "Unknown"
  const lat = Number(latitude)
  return `${Math.floor(lat)}..${Math.floor(lat) + 1}`
}

const toLongitudeBand = (longitude?: number) => {
  if (!Number.isFinite(longitude)) return "Unknown"
  const lng = Number(longitude)
  return `${Math.floor(lng)}..${Math.floor(lng) + 1}`
}

/**
 * Geo/intel dimensions that CANNOT be known when the guest document is created.
 *
 * `guestTracker` writes every guest with placeholder geo (`country: "Unknown"`,
 * `region: "Unknown"`, `timezone: "UTC"`, `latitude: 0`) plus
 * `intelligenceStatus: "pending"`; the real values arrive later from
 * `enrichGuestGeo`. Counting these keys in `onGuestCreated` therefore banked
 * `byCountry.Unknown` for every guest, and the resolution that followed never
 * re-emitted — so the 30m/1h/24h panels, which merge `metrics_hourly`, could only
 * ever show Unknown, while 7d/30d/90d looked right because `computeRangeMetric`
 * rebuilds those from raw guest documents.
 *
 * Emitted once from the enrichment instead, into the same `createdAt` buckets the
 * guest's creation counters landed in, so the timeline stays aligned.
 */
export type GeoDimensionSource = {
  createdAt?: unknown
  country?: string
  region?: string
  location?: string
  timezone?: string
  latitude?: number | string | null
  longitude?: number | string | null
  network?: {
    asn?: string | number | null
    as?: string | null
    isp?: string | null
    domain?: string | null
    usageType?: string | null
  }
  proxy?: { isProxy?: boolean; proxyType?: string | null; threat?: string | null }
}

/** The network/proxy dimension values, in one place so both writers cannot drift.
 * @alias readNetworkDimensions
 * @param {GeoDimensionSource} guest - Guest snapshot carrying the resolved geo/network fields.
 * @return {object} - The network dimensions with fallbacks for missing values.
 */

export const readNetworkDimensions = (guest: GeoDimensionSource): {
  asn: string
  as: string
  isp: string
  usageType: string
  domain: string
  threat: string
} => {
  const network = guest.network
  const asn = network?.asn != null ? String(network.asn).trim() : ""
  const organisation = (network?.as || network?.isp || "").trim()

  return {
    asn: asn || "Unknown",
    // ipregistry returns one organisation string, so `as` and `isp` coincide there
    // and only differ under the custom geo API. Both stay exposed because the
    // dimension names mean different things to the panels that read them.
    as: organisation || asn || "Unknown",
    isp: (network?.as || network?.isp || asn || "").trim() || "Unknown",
    usageType: (network?.usageType || "").trim() || "Unknown",
    domain: (network?.domain || "").trim() || "Unknown",
    // Three distinct states: a flagged value, "none" once enrichment resolved the
    // IP clean, and "Unknown" while the guest still carries placeholder geo.
    threat: (guest.proxy?.threat || "").trim() || (guest.proxy ? "none" : "Unknown"),
  }
}

/**
 * Keys and fallbacks mirror `computeRangeMetric` and the old `onGuestCreated`
 * expressions exactly — these maps are MERGED across sources by the admin panels,
 * so one writer trimming or sanitising differently would split a single country
 * across two rows.
 *
 * @param {GeoDimensionSource} guest - Guest snapshot carrying the resolved geo/network fields.
 * @return {Record<string, FieldValue>} One dotted-path increment counter per geo dimension.
 */
export const buildGeoDimensionCounters = (
  guest: GeoDimensionSource,
): Record<string, FieldValue> => {
  const latitude = Number(guest.latitude)
  const longitude = Number(guest.longitude)
  const geoCell =
    Number.isFinite(latitude) && Number.isFinite(longitude) ?
      `${latitude.toFixed(1)},${longitude.toFixed(1)}` :
      "Unknown"
  const proxyType = guest.proxy?.isProxy ? (guest.proxy.proxyType || "proxy") : "direct"
  const dimensions = readNetworkDimensions(guest)

  return {
    [`byCountry.${guest.country || "Unknown"}`]: FieldValue.increment(1),
    [`byRegion.${guest.region || "Unknown"}`]: FieldValue.increment(1),
    [`byTimezone.${guest.timezone || "Unknown"}`]: FieldValue.increment(1),
    [`byLocation.${guest.location || "Unknown"}`]: FieldValue.increment(1),
    [`byGeoCell.${geoCell}`]: FieldValue.increment(1),
    [`byLatitudeBand.${toLatitudeBand(latitude)}`]: FieldValue.increment(1),
    [`byLongitudeBand.${toLongitudeBand(longitude)}`]: FieldValue.increment(1),
    [`byASN.${dimensions.asn}`]: FieldValue.increment(1),
    [`byAS.${dimensions.as}`]: FieldValue.increment(1),
    [`byISP.${dimensions.isp}`]: FieldValue.increment(1),
    [`byUsageType.${dimensions.usageType}`]: FieldValue.increment(1),
    [`byDomain.${dimensions.domain}`]: FieldValue.increment(1),
    [`byProxyType.${proxyType}`]: FieldValue.increment(1),
    [`byThreat.${dimensions.threat}`]: FieldValue.increment(1),
  }
}

/** The summary doc only ever mirrored this subset; keep its field names stable. */
const SUMMARY_GEO_DIMENSIONS = [
  "byCountry", "byTimezone", "byASN", "byAS", "byISP", "byUsageType", "byDomain", "byProxyType", "byThreat",
]

/**
 * Same bucketing `onGuestCreated` uses, driven by the guest's own `createdAt` so an
 * enrichment that crosses an hour/day boundary cannot strand the count in a
 * different slot than the guest's other counters.
 * ponytail: keeps that handler's UTC-date/local-hour mix for bucket parity; the
 * functions runtime is UTC, so the two agree in production.
 *
 * @param {unknown} createdAt - Guest creation time as a Date, a Firestore Timestamp or an ISO string.
 * @return {{ date: string, hourKey: string, minuteKey: string }} The UTC day key plus the hour and minute bucket keys.
 */
export const guestTimelineBuckets = (createdAt: unknown): { date: string, hourKey: string, minuteKey: string } => {
  const source = createdAt as { toDate?: () => Date } | undefined
  const date = source instanceof Date ? source :
    source && typeof source.toDate === "function" ? source.toDate() :
      new Date(String(createdAt ?? Date.now()))
  const day = date.toISOString().split("T")[0]
  const hourKey = `${day}-${date.getHours().toString().padStart(2, "0")}`
  return { date: day, hourKey, minuteKey: `${hourKey}-${date.getMinutes().toString().padStart(2, "0")}` }
}

/**
 * Count a guest's geo dimensions exactly once, where the values become known.
 * Never throws: analytics must not fail the enrichment it rode in on.
 *
 * @param {GeoDimensionSource} guest - Enriched guest snapshot whose geo fields are now real.
 * @return {Promise<void>} Resolves once the counters are committed, or the failure is logged.
 */
/**
 * emitGeoDimensions
 * @param {*} guest
 */
export async function emitGeoDimensions(guest: GeoDimensionSource): Promise<void> {
  const counters = buildGeoDimensionCounters(guest)
  const { date, hourKey, minuteKey } = guestTimelineBuckets(guest.createdAt)
  const summaryCounters = Object.fromEntries(
    Object.entries(counters).filter(([key]) =>
      SUMMARY_GEO_DIMENSIONS.some((dimension) => key.startsWith(`${dimension}.`))),
  )
  try {
    const batch = db.batch()
    batch.set(db.doc(`metrics_daily/${date}`), { ...counters, updatedAt: Timestamp.now() }, { merge: true })
    batch.set(db.doc(`metrics_hourly/${hourKey}`), { ...counters, updatedAt: Timestamp.now() }, { merge: true })
    batch.set(db.doc(`metrics_minutely/${minuteKey}`), { ...counters, updatedAt: Timestamp.now() }, { merge: true })
    batch.set(db.doc("metrics_summary/dashboard"), summaryCounters, { merge: true })
    await batch.commit()
  } catch (error) {
    console.error("❌ Error emitting geo dimensions:", error)
  }
}

type RangeSummary = {
  byCountry?: Record<string, number>
  byBrowser?: Record<string, number>
  byDevice?: Record<string, number>
  byOS?: Record<string, number>
  byProvider?: Record<string, number>
  byTimezone?: Record<string, number>
}

type RetentionCohort = {
  cohort: string
  size: number
  d1: number | null
  d7: number | null
  d14: number | null
  d30: number | null
}

// Cohort retention offsets (days) rendered in the admin grid.
const RETENTION_OFFSETS = [1, 7, 14, 30]
// ponytail: one bounded read per daily run; raise the limit when daily
// client-event volume approaches it.
const RETENTION_EVENT_LIMIT = 20000

// MetricsDailyExtended lived here to type the cast that read `byIP` and friends off a
// daily doc. Those reads now go through collectBreakdown, which takes a plain record —
// so the cast (and the type) are gone rather than kept alive for one caller.

// ============================================================================
// REAL-TIME TRIGGERS - Atomic Updates for Live Dashboard
// ============================================================================

/**
 * 🔥 CRITICAL: This trigger updates analytics in real-time when guests are created
 * Updates: metrics_daily, metrics_hourly, metrics_summary/dashboard
 */
export const onGuestCreated = onDocumentCreated(
  {
    document: "guests/{guestId}",
    database: DATABASE_NAME, // ⭐ v2 requires database parameter for named databases
  },
  /**
   * callback
   * @param {*} event
   */
  async (event) => {
    const guest = event.data?.data() as Guest
    if (!guest) return

    const now = new Date()
    const today = now.toISOString().split("T")[0]
    const hour = now.getHours()
    const hourKey = `${today}-${hour.toString().padStart(2, "0")}`
    // Per-minute bucket: the only grain that can answer a rolling 30m window, since an
    // hour bucket can only ever mean "this hour so far".
    const minuteKey = `${hourKey}-${now.getMinutes().toString().padStart(2, "0")}`
    // Geo-dependent dimensions (country, region, timezone, city, geo cell, lat/lon
    // bands, ASN, ISP, proxy type) are emitted by `emitGeoDimensions` from
    // `enrichGuestGeo` instead — at this point every one of them is a placeholder.
    const channel = guest.acquisition?.utmSource || "direct"
    const referrer = guest.acquisition?.referrer || "direct"
    const proxyType = guest.proxy?.isProxy ? (guest.proxy.proxyType || "proxy") : "direct"

    // Raw fact + per-day funnel counters (bots are counted outside the funnel).
    const guestEvent = buildAnalyticsEvent({
      name: "guest_created",
      uid: guest.uid,
      guestId: event.params.guestId,
      isBot: guest.isBot,
      botKind: guest.botKind,
      props: {
        browser: guest.browser || "Unknown",
        device: guest.device || "Unknown",
        os: guest.os || "Unknown",
        language: guest.language || "Unknown",
        country: guest.country || "Unknown",
        channel,
        proxyType,
      },
    })
    const funnelCounters: Record<string, FieldValue> = {}
    for (const key of toFunnelCounterKeys(guestEvent)) {
      funnelCounters[key] = FieldValue.increment(1)
    }

    // One counter map for BOTH time rollups. `analytics-range.service.ts` merges all
    // of these out of `metrics_hourly` for the 30m/1h/24h periods, so a
    // hand-maintained subset there silently blanked 12 panels while 7d/30d/90d
    // (read from `metrics_daily`) looked fine.
    // ponytail: bounded by construction — a day is a fresh `metrics_daily` doc and an
    // hour is a fresh `metrics_hourly` doc, so one field per unique IP/ASN/… is capped.
    // The unbounded risk is the 90-day aggregate, which capBreakdown trims.
    const dimensionCounters: Record<string, FieldValue> = {
      // A missing value interpolated into a dotted path lands as a field
      // literally named `byBrowser.undefined`, so every key needs a fallback.
      [`byBrowser.${guest.browser || "Unknown"}`]: FieldValue.increment(1),
      [`byDevice.${guest.device || "Unknown"}`]: FieldValue.increment(1),
      [`byOS.${guest.os || "Unknown"}`]: FieldValue.increment(1),
      [`byLanguage.${guest.language || "Unknown"}`]: FieldValue.increment(1),
      // The raw IP is real at creation (unlike everything enriched).
      [`byIP.${guest.ip?.raw || guest.ip?.ipv4 || "Unknown"}`]: FieldValue.increment(1),
      [`byChannel.${channel}`]: FieldValue.increment(1),
      [`byReferrer.${referrer}`]: FieldValue.increment(1),
      [`byLandingPath.${toFieldKey(guest.acquisition?.landingPath || "direct")}`]: FieldValue.increment(1),
      ...funnelCounters,
    }

    try {
    // Single batch transaction for consistency
      const batch = db.batch()

      // 1. Update daily metrics
      const dailyRef = db.doc(`metrics_daily/${today}`)
      batch.set(dailyRef, {
        date: today,
        timestamp: Timestamp.now(),
        newGuests: FieldValue.increment(1),
        totalGuests: FieldValue.increment(1),
        activeGuests: FieldValue.increment(1),
        ...dimensionCounters,
        [`guestsByHour.${hour}`]: FieldValue.increment(1),
        updatedAt: Timestamp.now(),
      }, { merge: true })

      // 2. Update hourly metrics
      const hourlyRef = db.doc(`metrics_hourly/${hourKey}`)
      batch.set(hourlyRef, {
        datetime: hourKey,
        date: today,
        hour: hour,
        timestamp: Timestamp.now(),
        newGuests: FieldValue.increment(1),
        activeGuests: FieldValue.increment(1),
        ...dimensionCounters,
        updatedAt: Timestamp.now(),
      }, { merge: true })

      // Minutely metrics — same counter map as the hourly bucket, one document per
      // minute, which is what makes 30m/1h true rolling windows instead of
      // hour-aligned ones. Read by `buildBucketedRangeMetrics`.
      const minutelyRef = db.doc(`metrics_minutely/${minuteKey}`)
      batch.set(minutelyRef, {
        datetime: minuteKey,
        date: today,
        hour: hour,
        minute: now.getMinutes(),
        timestamp: Timestamp.now(),
        newGuests: FieldValue.increment(1),
        activeGuests: FieldValue.increment(1),
        ...dimensionCounters,
        updatedAt: Timestamp.now(),
      }, { merge: true })

      // 3. Update dashboard summary (for real-time UI)
      const summaryRef = db.doc("metrics_summary/dashboard")
      batch.set(summaryRef, {
        totalGuests: FieldValue.increment(1),
        activeGuests: FieldValue.increment(1),
        [`byBrowser.${guest.browser || "Unknown"}`]: FieldValue.increment(1),
        [`byDevice.${guest.device || "Unknown"}`]: FieldValue.increment(1),
        [`byOS.${guest.os || "Unknown"}`]: FieldValue.increment(1),
        [`byLanguage.${guest.language || "Unknown"}`]: FieldValue.increment(1),
        [`byChannel.${channel}`]: FieldValue.increment(1),
        [`byReferrer.${referrer}`]: FieldValue.increment(1),
        lastUpdated: Timestamp.now(),
        computedAt: Timestamp.now(),
      }, { merge: true })

      // 4. Append the raw fact (funnel / cohort / retention queries)
      batch.set(db.collection(ANALYTICS_EVENTS).doc(), guestEvent)

      await batch.commit()
      console.log(`✅ Guest ${event.params.guestId} metrics updated successfully`)
    } catch (error) {
      console.error(`❌ Error updating guest metrics for ${event.params.guestId}:`, error)
    // Don't throw - let the guest creation succeed even if analytics fail
    }
  })

/**
 * 🔥 User registration trigger - Updates user metrics and conversion tracking
 */
export const onUserRegistered = onDocumentCreated(
  {
    document: "users/{userId}",
    database: DATABASE_NAME, // ⭐ v2 requires database parameter for named databases
  },
  /**
   * callback
   * @param {*} event
   */
  async (event) => {
    const user = event.data?.data() as Users
    if (!user) return
    const userId = event.params.userId

    const now = new Date()
    const today = now.toISOString().split("T")[0]
    const hour = now.getHours()

    try {
      const batch = db.batch()

      // Check if this was a guest conversion
      const guestId = user.loginMetricsId // Assuming this links to guest
      let isConversion = false

      if (guestId) {
      // Check if guest exists and update linkedAt
        const guestRef = db.doc(`guests/${guestId}`)
        const guestDoc = await guestRef.get()

        if (guestDoc.exists && !guestDoc.data()?.linkedAt) {
          batch.update(guestRef, {
            linkedAt: Timestamp.now(),
            uid: userId,
          })
          isConversion = true
        }
      }

      // 1. Update daily metrics
      const dailyRef = db.doc(`metrics_daily/${today}`)
      const dailyUpdate: Record<string, FieldValue | Timestamp> = {
        newUsers: FieldValue.increment(1),
        totalUsers: FieldValue.increment(1),
        activeUsers: FieldValue.increment(1),
        [`usersByHour.${hour}`]: FieldValue.increment(1),
        updatedAt: Timestamp.now(),
      }

      if (isConversion) {
        dailyUpdate.guestConversions = FieldValue.increment(1)
      }

      const userEvent = buildAnalyticsEvent({
        name: "user_registered",
        uid: userId,
        guestId: guestId || null,
        isConversion,
        props: {wasGuest: isConversion},
      })
      for (const key of toFunnelCounterKeys(userEvent)) {
        dailyUpdate[key] = FieldValue.increment(1)
      }

      batch.set(dailyRef, dailyUpdate, { merge: true })

      // 2. Update dashboard summary
      const summaryRef = db.doc("metrics_summary/dashboard")
      const summaryUpdate: Record<string, FieldValue | Timestamp> = {
        totalUsers: FieldValue.increment(1),
        activeUsers: FieldValue.increment(1),
        lastUpdated: Timestamp.now(),
        computedAt: Timestamp.now(),
      }

      if (isConversion) {
        summaryUpdate.guestConversions = FieldValue.increment(1)
      }

      batch.set(summaryRef, summaryUpdate, { merge: true })

      // 3. Initialize user login metrics
      const userMetricsRef = db.doc(`users/${userId}/login_metrics/summary`)
      batch.set(userMetricsRef, {
        userId: userId,
        totalLogins: 0,
        loginStreak: 0,
        longestStreak: 0,
        firstLogin: null,
        lastLogin: null,
        wasGuest: isConversion,
        guestId: isConversion ? guestId : null,
        linkedAt: isConversion ? Timestamp.now() : null,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      })

      // 4. Append the raw fact (funnel / cohort / retention queries)
      batch.set(db.collection(ANALYTICS_EVENTS).doc(), userEvent)

      await batch.commit()
      console.log(`✅ User ${userId} registration metrics updated (conversion: ${isConversion})`)
    } catch (error) {
      console.error(`❌ Error updating user registration metrics for ${event.params.userId}:`, error)
    }
  })

/**
 * 🔥 Login event trigger - Updates login analytics and user metrics
 */
export const onLoginEvent = onDocumentCreated(
  {
    document: "login_metrics/{userId}/login_history_Info/{loginId}",
    database: DATABASE_NAME, // ⭐ v2 requires database parameter for named databases
  },
  /**
   * callback
   * @param {*} event
   */
  async (event) => {
    const loginInfo = event.data?.data() as loginHistoryInfo
    if (!loginInfo) return

    const now = new Date()
    const today = now.toISOString().split("T")[0]
    const hour = now.getHours()

    try {
      const batch = db.batch()

      // 1. Update daily metrics
      const dailyRef = db.doc(`metrics_daily/${today}`)
      const providerKey = loginInfo.providerId || "unknown"
      const loginEvent = buildAnalyticsEvent({
        name: "login_succeeded",
        uid: event.params.userId,
        props: {provider: providerKey, connection: loginInfo.connection || ""},
      })
      const funnelCounters: Record<string, FieldValue> = {}
      for (const key of toFunnelCounterKeys(loginEvent)) {
        funnelCounters[key] = FieldValue.increment(1)
      }
      batch.set(dailyRef, {
        totalLogins: FieldValue.increment(1),
        [`loginsByHour.${hour}`]: FieldValue.increment(1),
        [`byProvider.${providerKey}`]: FieldValue.increment(1),
        ...funnelCounters,
        updatedAt: Timestamp.now(),
      }, { merge: true })

      // 2. Update hourly metrics
      const hourKey = `${today}-${hour.toString().padStart(2, "0")}`
      const hourlyRef = db.doc(`metrics_hourly/${hourKey}`)
      batch.set(hourlyRef, {
        totalLogins: FieldValue.increment(1),
        // The 30m/1h/24h reader merges `byProvider` from the hourly rows.
        [`byProvider.${providerKey}`]: FieldValue.increment(1),
        ...funnelCounters,
        updatedAt: Timestamp.now(),
      }, { merge: true })

      // 3. Update dashboard summary
      const summaryRef = db.doc("metrics_summary/dashboard")
      batch.set(summaryRef, {
        totalLogins: FieldValue.increment(1),
        [`byProvider.${providerKey}`]: FieldValue.increment(1),
        lastUpdated: Timestamp.now(),
      }, { merge: true })

      // 4. Update user login metrics
      const userMetricsRef = db.doc(`users/${event.params.userId}/login_metrics/summary`)
      batch.set(userMetricsRef, {
        totalLogins: FieldValue.increment(1),
        lastLogin: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }, { merge: true })

      // 5. Append the raw fact (funnel / cohort / retention queries)
      batch.set(db.collection(ANALYTICS_EVENTS).doc(), loginEvent)

      await batch.commit()
      console.log(`✅ Login metrics updated for user ${event.params.userId}`)
    } catch (error) {
      console.error("❌ Error updating login metrics:", error)
    }
  })

// ============================================================================
// BACKFILL - Ensure dashboard summary exists even without new events
// ============================================================================

/**
 * 🧹 Backfill dashboard summary from existing metrics
 * Runs every 30 minutes to ensure metrics_summary/dashboard exists
 */
export const backfillDashboardSummary = onSchedule({
  schedule: "*/30 * * * *",
  // Without this binding the process gets no Upstash credentials and the drain
  // below silently no-ops, so the client-event queue grows without bound.
  secrets: [functionsEnvJson],
}, async () => {
  try {
    // Drain the client-event list first so facts + per-day counters stay current.
    await drainClientAnalyticsEvents()

    const now = new Date()
    const last30Start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)
      .toISOString().split("T")[0]
    const last30StartTs = Timestamp.fromDate(new Date(`${last30Start}T00:00:00.000Z`))
    const tomorrowTs = Timestamp.fromDate(new Date(now.getTime() + 24 * 60 * 60 * 1000))

    const [latestDailySnap, rangeSnap, guestCountSnap, userCountSnap, last30DailySnap, last30LoginCount] = await Promise.all([
      db.collection("metrics_daily")
        .orderBy("date", "desc")
        .limit(1)
        .get(),
      db.doc("metrics_range/last-30d").get(),
      db.collection("guests").count().get(),
      db.collection("users").count().get(),
      db.collection("metrics_daily")
        .where("date", ">=", last30Start)
        .get(),
      db.collectionGroup("login_history_Info")
        .where("timestamp", ">=", last30StartTs)
        .where("timestamp", "<", tomorrowTs)
        .count()
        .get(),
    ])

    const latestDaily = latestDailySnap.docs[0]?.data() as MetricsDaily | undefined
    const rangeData = rangeSnap.exists ? rangeSnap.data() as RangeSummary : null

    const totalGuests = guestCountSnap.data().count || 0
    const totalUsers = userCountSnap.data().count || 0
    /**
     * callback
     * @param {*} sum
     * @param {*} doc
     * @return {*}
     */
    const totalLoginsFromDaily = last30DailySnap.docs.reduce((sum, doc) => {
      const data = doc.data() as MetricsDaily
      return sum + (data.totalLogins || 0)
    }, 0)
    const totalLogins = Math.max(totalLoginsFromDaily, last30LoginCount.data().count || 0)
    /**
     * callback
     * @param {*} sum
     * @param {*} doc
     * @return {*}
     */
    const guestConversions = last30DailySnap.docs.reduce((sum, doc) => {
      const data = doc.data() as MetricsDaily
      return sum + (data.guestConversions || 0)
    }, 0)
    const conversionRate = totalGuests > 0 ?
      Math.round((guestConversions / totalGuests) * 100) : 0

    const summaryRef = db.doc("metrics_summary/dashboard")
    const brk = (p: string): Record<string, number> =>
      collectBreakdown((rangeData ?? latestDaily) as unknown as Record<string, unknown> | undefined, p)
    await summaryRef.set({
      totalGuests: totalGuests,
      activeGuests: latestDaily?.activeGuests || 0,
      totalUsers: totalUsers,
      activeUsers: latestDaily?.activeUsers || 0,
      totalLogins: totalLogins,
      guestConversions: guestConversions,
      conversionRate: conversionRate,
      topCountries: mapToTop(brk("byCountry"), "country"),
      topBrowsers: mapToTop(brk("byBrowser"), "browser"),
      topDevices: mapToTop(brk("byDevice"), "device"),
      topOperatingSystems: mapToTop(brk("byOS"), "os"),
      byOS: brk("byOS"),
      byProvider: brk("byProvider"),
      byTimezone: brk("byTimezone"),
      topProviders: mapToTop(brk("byProvider"), "provider"),
      lastUpdated: Timestamp.now(),
      computedAt: Timestamp.now(),
    }, { merge: true })

    console.log("✅ Backfill dashboard summary completed")
  } catch (error) {
    console.error("❌ Backfill dashboard summary failed:", error)
  }
})

// ============================================================================
// SCHEDULED FUNCTIONS - Compute Aggregations & Trends
// ============================================================================

/**
 * 📊 Daily aggregation - Computes trends and optimizes daily metrics
 * Runs every day at 00:05 UTC
 */
/**
 * 5 0 * * *
 */
export const computeDailyTrends = onSchedule("5 0 * * *", async () => {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  const todayStr = today.toISOString().split("T")[0]
  const yesterdayStr = yesterday.toISOString().split("T")[0]

  try {
    // Get yesterday's and today's metrics
    const [yesterdayDoc, todayDoc] = await Promise.all([
      db.doc(`metrics_daily/${yesterdayStr}`).get(),
      db.doc(`metrics_daily/${todayStr}`).get(),
    ])

    const yesterdayData = yesterdayDoc.data() as MetricsDaily | undefined
    const todayData = todayDoc.data() as MetricsDaily | undefined

    // Calculate trends (% change from yesterday)
    const calculateGrowth = (today: number, yesterday: number): number => {
      if (yesterday === 0) return today > 0 ? 100 : 0
      return Math.round(((today - yesterday) / yesterday) * 100)
    }

    const todayGuests = todayData?.newGuests || 0
    const yesterdayGuests = yesterdayData?.newGuests || 0
    const todayUsers = todayData?.newUsers || 0
    const yesterdayUsers = yesterdayData?.newUsers || 0
    const todayLogins = todayData?.totalLogins || 0
    const yesterdayLogins = yesterdayData?.totalLogins || 0
    const todayConversion = todayData?.conversionRate || 0
    const yesterdayConversion = yesterdayData?.conversionRate || 0

    const trends = {
      guestsGrowth: calculateGrowth(todayGuests, yesterdayGuests),
      usersGrowth: calculateGrowth(todayUsers, yesterdayUsers),
      loginsGrowth: calculateGrowth(todayLogins, yesterdayLogins),
      conversionGrowth: calculateGrowth(todayConversion, yesterdayConversion),
    }

    // Update dashboard summary with trends
    await db.doc("metrics_summary/dashboard").update({
      trends: trends,
      computedAt: Timestamp.now(),
    })

    console.log(`✅ Daily trends computed: ${JSON.stringify(trends)}`)
  } catch (error) {
    console.error("❌ Error computing daily trends:", error)
  }
})

/**
 * 📈 Range metrics computation - Pre-computes common date ranges
 * Runs every day at 01:00 UTC
 */
export const computeRangeMetrics = onSchedule({
  schedule: "0 1 * * *",
}, async () => {
  const ranges = [
    { id: "last-7d", days: 7 },
    { id: "last-30d", days: 30 },
    { id: "last-90d", days: 90 },
  ]

  try {
    for (const range of ranges) {
      await computeRangeMetric(range.id, range.days)
    }
    console.log("✅ All range metrics computed successfully")
  } catch (error) {
    console.error("❌ Error computing range metrics:", error)
  }
})

/**
 * computeRangeMetric
 * @param {*} rangeId
 * @param {*} days
 */
async function computeRangeMetric(rangeId: string, days: number) {
  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
  const startTs = Timestamp.fromDate(new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
    0, 0, 0, 0,
  )))
  const endExclusiveTs = Timestamp.fromDate(new Date(Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate() + 1,
    0, 0, 0, 0,
  )))

  // Generate array of UTC day keys — must match the metrics_daily/{date} keys exactly.
  // ponytail: iterate in UTC; local setDate() drifts a day across DST/month ends.
  // The getters below must be the UTC family: mixing `getFullYear()` (local) with
  // Date.UTC() resolves to a *different day* whenever TZ is not UTC, which shifts this
  // list away from the UTC-based startTs/endExclusiveTs used for the queries below —
  // so the daily-aggregate totals and the live-query totals would cover different days.
  // Production runs UTC so it was invisible there, but a local run (or emulator) on a
  // UTC+3 machine produced a day set that disagreed with production.
  const dates: string[] = []
  const rangeStartMs = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  const rangeEndMs = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  for (let ms = rangeStartMs; ms <= rangeEndMs; ms += 24 * 60 * 60 * 1000) {
    dates.push(new Date(ms).toISOString().split("T")[0])
  }

  // Fetch all daily metrics for the range
  /**
   * callback
   * @param {*} date
   */
  const dailyMetricsPromises = dates.map((date) => db.doc(`metrics_daily/${date}`).get())
  const [dailySnapshots, loginHistorySnap, usersCreatedSnap, guestsCreatedSnap] = await Promise.all([
    Promise.all(dailyMetricsPromises),
    db.collectionGroup("login_history_Info")
      .where("timestamp", ">=", startTs)
      .where("timestamp", "<", endExclusiveTs)
      .get(),
    db.collection("users")
      .where("created_At", ">=", startTs)
      .where("created_At", "<", endExclusiveTs)
      .get(),
    db.collection("guests")
      .where("createdAt", ">=", startTs)
      .where("createdAt", "<", endExclusiveTs)
      .get(),
  ])

  const sourceLoginsByDate: Record<string, number> = {}
  const sourceUsersByDate: Record<string, number> = {}
  const sourceGuestsByDate: Record<string, number> = {}
  const sourceConversionsByDate: Record<string, number> = {}

  // Aggregate the data
  let totalGuests = 0
  let newGuests = 0
  let totalUsers = 0
  let newUsers = 0
  let totalLogins = 0
  let guestConversions = 0
  const byCountry: { [key: string]: number } = {}
  const byRegion: { [key: string]: number } = {}
  const byLocation: { [key: string]: number } = {}
  const byGeoCell: { [key: string]: number } = {}
  const byLatitudeBand: { [key: string]: number } = {}
  const byLongitudeBand: { [key: string]: number } = {}
  const byBrowser: { [key: string]: number } = {}
  const byDevice: { [key: string]: number } = {}
  const byOS: { [key: string]: number } = {}
  const byProvider: { [key: string]: number } = {}
  const byLanguage: { [key: string]: number } = {}
  const byIP: { [key: string]: number } = {}
  const byTimezone: { [key: string]: number } = {}
  const byASN: { [key: string]: number } = {}
  const byISP: { [key: string]: number } = {}
  const byChannel: { [key: string]: number } = {}
  const byReferrer: { [key: string]: number } = {}
  const byProxyType: { [key: string]: number } = {}
  const byAS: { [key: string]: number } = {}
  const byUsageType: { [key: string]: number } = {}
  const byDomain: { [key: string]: number } = {}
  const byThreat: { [key: string]: number } = {}
  const byBotKind: { [key: string]: number } = {}
  const funnel: { [key: string]: number } = {guest_created: 0, user_registered: 0, login_succeeded: 0}
  const clientEvents: { [key: string]: number } = {}
  const byPage: { [key: string]: number } = {}
  const byLandingPath: { [key: string]: number } = {}
  const revenueByCurrency: { [key: string]: number } = {}
  const paymentsByCurrency: { [key: string]: number } = {}
  const paidByPlan: { [key: string]: number } = {}
  const paidByChannel: { [key: string]: number } = {}
  let bots = 0
  let scannedBots = 0
  const scannedBotKinds: { [key: string]: number } = {}
  const dailyBreakdown: Array<{
    date: string
    newGuests: number
    newUsers: number
    totalLogins: number
    guestConversions: number
    conversionRate: number
  }> = []

  loginHistorySnap.docs.forEach((doc) => {
    const login = doc.data() as loginHistoryInfo
    const tsValue = login.timestamp as unknown as { toDate?: () => Date }
    const dateKey = tsValue?.toDate ?
      tsValue.toDate().toISOString().split("T")[0] :
      new Date(login.timestamp as unknown as string).toISOString().split("T")[0]

    sourceLoginsByDate[dateKey] = (sourceLoginsByDate[dateKey] || 0) + 1

    const provider = login.providerId || "unknown"
    byProvider[provider] = (byProvider[provider] || 0) + 1
  })

  usersCreatedSnap.docs.forEach((doc) => {
    const user = doc.data() as Users
    const tsValue = user.created_At as unknown as { toDate?: () => Date }
    const dateKey = tsValue?.toDate ?
      tsValue.toDate().toISOString().split("T")[0] :
      new Date(user.created_At as unknown as string).toISOString().split("T")[0]

    sourceUsersByDate[dateKey] = (sourceUsersByDate[dateKey] || 0) + 1

    if (user.loginMetricsId) {
      sourceConversionsByDate[dateKey] = (sourceConversionsByDate[dateKey] || 0) + 1
    }
  })

  guestsCreatedSnap.docs.forEach((doc) => {
    const guest = doc.data() as Guest

    // ponytail: guests created before bot tagging carry no flag — re-parse their stored
    // UA so historical bot share stays accurate without a migration (docs are read anyway).
    const guestAgent = guest.isBot === undefined ? parseUA(guest.userAgent || "") : null
    if (guest.isBot ?? guestAgent?.isBot) {
      scannedBots += 1
      const kind = guest.botKind || guestAgent?.botKind || "bot"
      scannedBotKinds[kind] = (scannedBotKinds[kind] || 0) + 1
    }

    const tsValue = guest.createdAt as unknown as { toDate?: () => Date }
    const dateKey = tsValue?.toDate ?
      tsValue.toDate().toISOString().split("T")[0] :
      new Date(guest.createdAt as unknown as string).toISOString().split("T")[0]

    sourceGuestsByDate[dateKey] = (sourceGuestsByDate[dateKey] || 0) + 1

    byCountry[guest.country || "Unknown"] = (byCountry[guest.country || "Unknown"] || 0) + 1
    byRegion[guest.region || "Unknown"] = (byRegion[guest.region || "Unknown"] || 0) + 1
    byLocation[guest.location || "Unknown"] = (byLocation[guest.location || "Unknown"] || 0) + 1

    const geoCell =
      Number.isFinite(guest.latitude) && Number.isFinite(guest.longitude) ?
        `${Number(guest.latitude).toFixed(1)},${Number(guest.longitude).toFixed(1)}` :
        "Unknown"

    byGeoCell[geoCell] = (byGeoCell[geoCell] || 0) + 1

    const latBand = toLatitudeBand(guest.latitude)
    const lonBand = toLongitudeBand(guest.longitude)
    byLatitudeBand[latBand] = (byLatitudeBand[latBand] || 0) + 1
    byLongitudeBand[lonBand] = (byLongitudeBand[lonBand] || 0) + 1

    byBrowser[guest.browser || "Unknown"] = (byBrowser[guest.browser || "Unknown"] || 0) + 1
    byDevice[guest.device || "Unknown"] = (byDevice[guest.device || "Unknown"] || 0) + 1
    byOS[guest.os || "Unknown"] = (byOS[guest.os || "Unknown"] || 0) + 1
    byTimezone[guest.timezone || "Unknown"] = (byTimezone[guest.timezone || "Unknown"] || 0) + 1

    // ponytail: ASN/AS/ISP/usage type/domain come from the geo `network` object
    // (ipregistry) stored on enriched guests. Read through the same helper as
    // `buildGeoDimensionCounters`, so the two writers cannot split one
    // organisation across two rows.
    const guestDimensions = readNetworkDimensions(guest)
    byASN[guestDimensions.asn] = (byASN[guestDimensions.asn] || 0) + 1
    byAS[guestDimensions.as] = (byAS[guestDimensions.as] || 0) + 1
    byISP[guestDimensions.isp] = (byISP[guestDimensions.isp] || 0) + 1
    byUsageType[guestDimensions.usageType] = (byUsageType[guestDimensions.usageType] || 0) + 1
    byDomain[guestDimensions.domain] = (byDomain[guestDimensions.domain] || 0) + 1
    byThreat[guestDimensions.threat] = (byThreat[guestDimensions.threat] || 0) + 1

    const acquisition = (guest as unknown as { acquisition?: { utmSource?: string; referrer?: string } }).acquisition
    const proxy = (guest as unknown as { proxy?: { isProxy?: boolean; proxyType?: string | null } }).proxy
    const channelKey = acquisition?.utmSource || "direct"
    const referrerKey = acquisition?.referrer || "direct"
    const proxyKey = proxy?.isProxy ? (proxy.proxyType || "proxy") : "direct"
    byChannel[channelKey] = (byChannel[channelKey] || 0) + 1
    byReferrer[referrerKey] = (byReferrer[referrerKey] || 0) + 1
    byProxyType[proxyKey] = (byProxyType[proxyKey] || 0) + 1
  })

  dailySnapshots.forEach((snapshot, index) => {
    const data = snapshot.data() as MetricsDaily | undefined
    const date = dates[index]
    const sourceNewGuests = sourceGuestsByDate[date] || 0
    const sourceNewUsers = sourceUsersByDate[date] || 0
    const sourceTotalLogins = sourceLoginsByDate[date] || 0
    const sourceConversions = sourceConversionsByDate[date] || 0

    if (data) {
      const finalNewGuests = Math.max(data.newGuests || 0, sourceNewGuests)
      const finalNewUsers = Math.max(data.newUsers || 0, sourceNewUsers)
      const finalTotalLogins = Math.max(data.totalLogins || 0, sourceTotalLogins)
      const finalConversions = Math.max(data.guestConversions || 0, sourceConversions)

      totalGuests += finalNewGuests
      newGuests += finalNewGuests
      totalUsers += finalNewUsers
      newUsers += finalNewUsers
      totalLogins += finalTotalLogins
      guestConversions += finalConversions

      // Aggregate dimensions. The triggers write every group as a flat dotted field
      // (`byIP.1.2.3.4`), so each read goes through collectBreakdown — reading
      // `data.byX` directly silently yields nothing, and the panel then falls back to
      // all-time dashboard numbers for the selected range instead of the range's own.
      const dataRecord = data as unknown as Record<string, unknown>

      Object.entries(collectBreakdown(dataRecord, "byCountry")).forEach(([country, count]) => {
        byCountry[country] = (byCountry[country] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byRegion")).forEach(([region, count]) => {
        byRegion[region] = (byRegion[region] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byLocation")).forEach(([location, count]) => {
        byLocation[location] = (byLocation[location] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byGeoCell")).forEach(([cell, count]) => {
        byGeoCell[cell] = (byGeoCell[cell] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byLatitudeBand")).forEach(([band, count]) => {
        byLatitudeBand[band] = (byLatitudeBand[band] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byLongitudeBand")).forEach(([band, count]) => {
        byLongitudeBand[band] = (byLongitudeBand[band] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byBrowser")).forEach(([browser, count]) => {
        byBrowser[browser] = (byBrowser[browser] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byDevice")).forEach(([device, count]) => {
        byDevice[device] = (byDevice[device] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byOS")).forEach(([os, count]) => {
        byOS[os] = (byOS[os] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byTimezone")).forEach(([timezone, count]) => {
        byTimezone[timezone] = (byTimezone[timezone] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byProvider")).forEach(([provider, count]) => {
        byProvider[provider] = (byProvider[provider] || 0) + count
      })

      // Bot traffic + funnel come straight off the daily rollup — no extra reads.
      bots += Number(dataRecord.bots || 0)
      Object.entries(collectBreakdown(dataRecord, "byBotKind")).forEach(([kind, count]) => {
        byBotKind[kind] = (byBotKind[kind] || 0) + count
      })
      Object.entries(collectBreakdown(dataRecord, "funnel")).forEach(([step, count]) => {
        funnel[step] = (funnel[step] || 0) + count
      })
      Object.entries(collectBreakdown(dataRecord, "clientEvents")).forEach(([name, count]) => {
        clientEvents[name] = (clientEvents[name] || 0) + count
      })
      Object.entries(collectBreakdown(dataRecord, "byPage")).forEach(([page, count]) => {
        byPage[page] = (byPage[page] || 0) + count
      })
      Object.entries(collectBreakdown(dataRecord, "byLandingPath")).forEach(([path, count]) => {
        byLandingPath[path] = (byLandingPath[path] || 0) + count
      })
      // Payment counters are written by the Stripe webhook; sums stay per currency.
      Object.entries(collectBreakdown(dataRecord, "revenueByCurrency")).forEach(([currency, amount]) => {
        revenueByCurrency[currency] = (revenueByCurrency[currency] || 0) + amount
      })
      Object.entries(collectBreakdown(dataRecord, "paymentsByCurrency")).forEach(([currency, count]) => {
        paymentsByCurrency[currency] = (paymentsByCurrency[currency] || 0) + count
      })
      Object.entries(collectBreakdown(dataRecord, "paidByPlan")).forEach(([planName, count]) => {
        paidByPlan[planName] = (paidByPlan[planName] || 0) + count
      })
      Object.entries(collectBreakdown(dataRecord, "paidByChannel")).forEach(([channel, count]) => {
        paidByChannel[channel] = (paidByChannel[channel] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byLanguage")).forEach(([lang, count]) => {
        byLanguage[lang] = (byLanguage[lang] || 0) + count
      })

      Object.entries(collectBreakdown(dataRecord, "byIP")).forEach(([ip, count]) => {
        byIP[ip] = (byIP[ip] || 0) + count
      })

      dailyBreakdown.push({
        date: date,
        newGuests: finalNewGuests,
        newUsers: finalNewUsers,
        totalLogins: finalTotalLogins,
        guestConversions: finalConversions,
        conversionRate: finalNewGuests > 0 ? Math.round((finalConversions / finalNewGuests) * 100) : 0,
      })
    } else {
      // Fill missing days with zeros
      dailyBreakdown.push({
        date: date,
        newGuests: sourceNewGuests,
        newUsers: sourceNewUsers,
        totalLogins: sourceTotalLogins,
        guestConversions: sourceConversions,
        conversionRate: sourceNewGuests > 0 ? Math.round((sourceConversions / sourceNewGuests) * 100) : 0,
      })

      totalGuests += sourceNewGuests
      newGuests += sourceNewGuests
      totalUsers += sourceNewUsers
      newUsers += sourceNewUsers
      totalLogins += sourceTotalLogins
      guestConversions += sourceConversions
    }
  })

  // Daily bot counters only exist once the facts layer is deployed; the guest scan
  // covers older days (and re-tags guests created before bot tagging shipped).
  if (bots < scannedBots) {
    bots = scannedBots
    Object.entries(scannedBotKinds).forEach(([kind, count]) => {
      byBotKind[kind] = count
    })
  }

  // Fallback: rebuild logins from raw login history if daily totals are missing
  if (totalLogins === 0) {
    const rangeStart = Timestamp.fromDate(new Date(`${startDate.toISOString().split("T")[0]}T00:00:00.000Z`))
    const rangeEndExclusiveDate = new Date(endDate)
    rangeEndExclusiveDate.setDate(rangeEndExclusiveDate.getDate() + 1)
    const rangeEndExclusive = Timestamp.fromDate(new Date(`${rangeEndExclusiveDate.toISOString().split("T")[0]}T00:00:00.000Z`))

    const loginEventsSnap = await db.collectionGroup("login_history_Info")
      .where("timestamp", ">=", rangeStart)
      .where("timestamp", "<", rangeEndExclusive)
      .get()

    loginEventsSnap.forEach((doc) => {
      const event = doc.data() as loginHistoryInfo
      const ts = event.timestamp as unknown
      const eventDateValue: Date | null =
        ts instanceof Date ? ts :
          (typeof ts === "object" && ts !== null && "toDate" in ts && typeof (ts as { toDate: () => Date }).toDate === "function") ?
            (ts as { toDate: () => Date }).toDate() : null
      if (!eventDateValue) {
        return
      }
      const eventDate = eventDateValue.toISOString().slice(0, 10)
      /**
       * callback
       * @param {*} d
       */
      const day = dailyBreakdown.find((d) => d.date === eventDate)
      if (day) {
        day.totalLogins += 1
      }
      totalLogins += 1

      const providerKey = event.providerId || "unknown"
      byProvider[providerKey] = (byProvider[providerKey] || 0) + 1
    })
  }

  // Calculate averages and trends
  const avgDailyGuests = Math.round(newGuests / days)
  const avgDailyUsers = Math.round(newUsers / days)
  const avgDailyLogins = Math.round(totalLogins / days)

  // Find peak day
  /**
   * callback
   * @param {*} peak
   * @param {*} current
   */
  const peakDay = dailyBreakdown.reduce((peak, current) =>
    current.totalLogins > peak.totalLogins ? current : peak
  )

  // Cohort retention only for the 30-day range — one bounded read, not three.
  const retention = days === 30 ? await computeRetention() : null

  // Store the computed range metrics
  await db.doc(`metrics_range/${rangeId}`).set({
    rangeId: rangeId,
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    totalGuests: totalGuests,
    newGuests: newGuests,
    totalUsers: totalUsers,
    newUsers: newUsers,
    totalLogins: totalLogins,
    guestConversions: guestConversions,
    conversionRate: newGuests > 0 ? Math.round((guestConversions / newGuests) * 100) : 0,
    byCountry: byCountry,
    byRegion: byRegion,
    byLocation: byLocation,
    byGeoCell: byGeoCell,
    byLatitudeBand: byLatitudeBand,
    byLongitudeBand: byLongitudeBand,
    byBrowser: byBrowser,
    byDevice: byDevice,
    byOS: byOS,
    byProvider: byProvider,
    byLanguage: byLanguage,
    byIP: capBreakdown(byIP, IP_BREAKDOWN_CAP),
    byTimezone: byTimezone,
    byASN: byASN,
    byAS: byAS,
    byISP: byISP,
    byUsageType: byUsageType,
    byDomain: byDomain,
    byThreat: byThreat,
    byChannel: byChannel,
    byReferrer: byReferrer,
    byProxyType: byProxyType,
    byBotKind: byBotKind,
    bots: bots,
    funnel: funnel,
    clientEvents: clientEvents,
    byPage: byPage,
    byLandingPath: byLandingPath,
    revenueByCurrency: revenueByCurrency,
    paymentsByCurrency: paymentsByCurrency,
    paidByPlan: paidByPlan,
    paidByChannel: paidByChannel,
    ...(retention ? {retention: retention} : {}),
    dailyBreakdown: dailyBreakdown,
    trends: {
      avgDailyGuests: avgDailyGuests,
      avgDailyUsers: avgDailyUsers,
      avgDailyLogins: avgDailyLogins,
      peakDay: peakDay.date,
      peakValue: peakDay.totalLogins,
    },
    computedAt: Timestamp.now(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)), // 24h TTL
  })

  console.log(`✅ Range metric ${rangeId} computed successfully`)
}

/**
 * Cohort retention from the raw facts.
 *
 * Identity = `uid || guestId`, cohort = the first day that identity was seen.
 * Bots are excluded — crawlers do not come back. A cell is `null` (not 0) while
 * its window has not elapsed yet, so the grid never fakes a retention drop.
 */
/**
 * computeRetention
 */
async function computeRetention(): Promise<RetentionCohort[]> {
  const end = new Date()
  const todayKey = toEventDate(end)
  const todayMs = Date.parse(`${todayKey}T00:00:00.000Z`)

  // ponytail: read 60 days so the oldest reported cohort can still show D30.
  const startKey = toEventDate(new Date(todayMs - 59 * 24 * 60 * 60 * 1000))
  const eventsSnap = await db.collection(ANALYTICS_EVENTS)
    .where("date", ">=", startKey)
    .where("date", "<=", todayKey)
    .limit(RETENTION_EVENT_LIMIT)
    .get()

  const daysByIdentity = new Map<string, Set<string>>()
  eventsSnap.docs.forEach((doc) => {
    const event = doc.data() as AnalyticsEvent
    if (event.isBot) return
    const identity = event.uid || event.guestId
    if (!identity) return
    const days = daysByIdentity.get(identity) || new Set<string>()
    days.add(event.date)
    daysByIdentity.set(identity, days)
  })

  const cohorts = new Map<string, { size: number, active: Map<number, number> }>()
  daysByIdentity.forEach((days) => {
    const sorted = [...days].sort()
    const cohort = sorted[0]
    const baseMs = Date.parse(`${cohort}T00:00:00.000Z`)
    const row = cohorts.get(cohort) || {size: 0, active: new Map<number, number>()}
    row.size += 1

    for (const day of sorted) {
      const offset = Math.round((Date.parse(`${day}T00:00:00.000Z`) - baseMs) / (24 * 60 * 60 * 1000))
      if (RETENTION_OFFSETS.includes(offset)) {
        row.active.set(offset, (row.active.get(offset) || 0) + 1)
      }
    }

    cohorts.set(cohort, row)
  })

  // Only cohorts inside the last 30 days are reported (the range we serve).
  const windowStartKey = toEventDate(new Date(todayMs - 29 * 24 * 60 * 60 * 1000))
  const cell = (row: { active: Map<number, number> }, cohortMs: number, offset: number): number | null =>
    cohortMs + offset * 24 * 60 * 60 * 1000 > todayMs ? null : row.active.get(offset) || 0

  return [...cohorts.entries()]
    .filter(([cohort]) => cohort >= windowStartKey && cohort <= todayKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, row]) => {
      const cohortMs = Date.parse(`${cohort}T00:00:00.000Z`)
      return {
        cohort,
        size: row.size,
        d1: cell(row, cohortMs, 1),
        d7: cell(row, cohortMs, 7),
        d14: cell(row, cohortMs, 14),
        d30: cell(row, cohortMs, 30),
      }
    })
}

/**
 * 🧹 Cleanup old analytics data
 * Runs daily at 02:00 UTC
 */
/**
 * 0 2 * * *
 */
export const cleanupOldAnalytics = onSchedule("0 2 * * *", async () => {
  try {
    // Clean up old hourly metrics (keep only 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const hourlycutoff = sevenDaysAgo.toISOString().split("T")[0]

    // Query and delete old hourly metrics
    const oldHourlyQuery = await db.collection("metrics_hourly")
      .where("date", "<=", hourlycutoff)
      .limit(100)
      .get()

    if (!oldHourlyQuery.empty) {
      const batch = db.batch()
      oldHourlyQuery.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      console.log(`🧹 Cleaned up ${oldHourlyQuery.size} old hourly metrics`)
    }

    // Minutely buckets only serve the rolling 30m/1h windows, so two days is already
    // generous overlap; without this the series grows by 1440 documents a day forever.
    const minutelyCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    const oldMinutelyQuery = await db.collection("metrics_minutely")
      .where("date", "<", minutelyCutoff)
      .limit(400)
      .get()

    if (!oldMinutelyQuery.empty) {
      const batch = db.batch()
      oldMinutelyQuery.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      console.log(`🧹 Cleaned up ${oldMinutelyQuery.size} old minutely metrics`)
    }

    // Clean up expired range metrics
    const expiredRangeQuery = await db.collection("metrics_range")
      .where("expiresAt", "<=", Timestamp.now())
      .get()

    if (!expiredRangeQuery.empty) {
      const batch = db.batch()
      expiredRangeQuery.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      console.log(`🧹 Cleaned up ${expiredRangeQuery.size} expired range metrics`)
    }

    // Clean up old daily metrics (keep 365 days; range recompute only needs <=90d)
    const dailyCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    const oldDailyQuery = await db.collection("metrics_daily")
      .where("date", "<", dailyCutoff)
      .limit(200)
      .get()

    if (!oldDailyQuery.empty) {
      const batch = db.batch()
      oldDailyQuery.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      console.log(`🧹 Cleaned up ${oldDailyQuery.size} old daily metrics`)
    }

    // Clean up raw facts (daily rollups already carry the aggregates)
    const eventsCutoff = new Date(
      Date.now() - ANALYTICS_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString().split("T")[0]
    const oldEventsQuery = await db.collection(ANALYTICS_EVENTS)
      .where("date", "<", eventsCutoff)
      .limit(400)
      .get()

    if (!oldEventsQuery.empty) {
      const batch = db.batch()
      oldEventsQuery.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      console.log(`🧹 Cleaned up ${oldEventsQuery.size} old analytics events`)
    }
  } catch (error) {
    console.error("❌ Error during cleanup:", error)
  }
})

// ============================================================================
// REAL-TIME PRESENCE — Active users in 1 min / 5 min / 30 min windows
// ============================================================================

type PresenceCounts = {
  users1m: number
  users5m: number
  users30m: number
  guests1m: number
  guests5m: number
  guests30m: number
}

/**
 * Redis presence is authoritative.
 *
 * The heartbeat (`/event/heartbeat`) and `validateSessionCookie` score every live
 * caller into `online:users` / `online:guests` with its last-seen epoch. One
 * ZCOUNT per window per population answers this in a single round-trip, versus
 * six Firestore count queries per minute — and unlike the Firestore `presence`
 * documents, a member that stops heartbeating drops out of its window
 * immediately instead of lingering.
 *
 * Returns null when Redis is unavailable, so the caller can fall back.
 */
/**
 * readPresenceCountsFromRedis
 */
async function readPresenceCountsFromRedis(): Promise<PresenceCounts | null> {
  try {
    const now = Date.now()
    const [users1m, guests1m, users5m, guests5m, users30m, guests30m] =
      await (redis as unknown as {
        eval: (script: string, keys: string[], args: number[]) => Promise<number[]>
      }).eval(
        PRESENCE_WINDOW_COUNTS,
        [ONLINE_USERS_KEY, ONLINE_GUESTS_KEY],
        [
          now - PRESENCE_WINDOWS_MS[0],
          now - PRESENCE_WINDOWS_MS[1],
          now - PRESENCE_WINDOWS_MS[2],
          now,
        ],
      )

    return {
      users1m: Number(users1m) || 0,
      users5m: Number(users5m) || 0,
      users30m: Number(users30m) || 0,
      guests1m: Number(guests1m) || 0,
      guests5m: Number(guests5m) || 0,
      guests30m: Number(guests30m) || 0,
    }
  } catch (error) {
    console.warn("Presence: Redis read failed, falling back to Firestore:", error)
    return null
  }
}

/**
 * Firestore fallback, used only when Redis is unavailable. Kept because the
 * dashboard must render something even during a cache outage.
 *
 * @param {number} now - Current epoch milliseconds, used to derive the cutoffs.
 * @return {Promise<PresenceCounts>} Presence counts for the three windows.
 */
/**
 * readPresenceCountsFromFirestore
 * @param {*} now
 */
async function readPresenceCountsFromFirestore(now: number): Promise<PresenceCounts> {
  const cutoff1m = Timestamp.fromMillis(now - PRESENCE_WINDOWS_MS[0])
  const cutoff5m = Timestamp.fromMillis(now - PRESENCE_WINDOWS_MS[1])
  const cutoff30m = Timestamp.fromMillis(now - PRESENCE_WINDOWS_MS[2])

  const [snap1m, snap5m, snap30m, gSnap1m, gSnap5m, gSnap30m] = await Promise.all([
    db.collection("presence").where("lastSeen", ">=", cutoff1m).count().get(),
    db.collection("presence").where("lastSeen", ">=", cutoff5m).count().get(),
    db.collection("presence").where("lastSeen", ">=", cutoff30m).count().get(),
    db.collection("guests").where("lastSeen", ">=", cutoff1m).count().get(),
    db.collection("guests").where("lastSeen", ">=", cutoff5m).count().get(),
    db.collection("guests").where("lastSeen", ">=", cutoff30m).count().get(),
  ])

  return {
    users1m: snap1m.data().count,
    users5m: snap5m.data().count,
    users30m: snap30m.data().count,
    guests1m: gSnap1m.data().count,
    guests5m: gSnap5m.data().count,
    guests30m: gSnap30m.data().count,
  }
}

/**
 * ⏱️ Runs every minute.
 * Counts authenticated users and guests active in the last 1 / 5 / 30 minutes
 * and writes the totals to `metrics_summary/dashboard`.
 *
 * This scheduled job is the ONLY writer of that document. The heartbeat used to
 * also write it behind a per-instance throttle, so a user with N warm function
 * instances produced up to N competing writes per minute for the same fields.
 *
 * Client-side heartbeat: call `validateSessionCookie` every 60 s to keep
 * presence fresh. Guests call `recordGuestPresence` instead.
 */
export const computeActiveUsersNow = onSchedule(
  {
    schedule: "* * * * *", // every minute
    timeZone: "UTC",
    region: "us-central1",
    // Presence reads Redis first; without credentials it falls back to six
    // Firestore count queries every minute.
    secrets: [functionsEnvJson],
  },
  /**
   * callback
   */
  async () => {
    try {
      const now = Date.now()
      const counts = (await readPresenceCountsFromRedis()) ?? (await readPresenceCountsFromFirestore(now))

      const activeUsersPerMinute = counts.users1m
      const activeUsersLast5m = counts.users5m
      const activeUsersLast30m = counts.users30m

      const activeGuestsPerMinute = counts.guests1m
      const activeGuestsLast5m = counts.guests5m
      const activeGuestsLast30m = counts.guests30m

      // Consent-free traffic level, written by the BFF counter. Guarded like the presence
      // read above: a Redis hiccup must not take the whole per-minute write down with it.
      const utcDay = new Date().toISOString().split("T")[0]
      let requestsToday = 0
      let consentGrantedToday = 0
      let consentDeclinedToday = 0
      try {
        // One pipeline, three reads: the consent-blind request level and today's two
        // consent decisions. Aggregate only — no visitor is identifiable from any of them.
        const [served, granted, declined] = (await redis.pipeline()
          .get(trafficDailyKey(utcDay))
          .get(consentDecisionKey(utcDay, "granted"))
          .get(consentDecisionKey(utcDay, "denied"))
          .exec()) as [unknown, unknown, unknown]
        requestsToday = Number(served) || 0
        consentGrantedToday = Number(granted) || 0
        consentDeclinedToday = Number(declined) || 0
      } catch (error) {
        console.warn("Traffic level: Redis read failed:", error)
      }

      await db.doc("metrics_summary/dashboard").set({
        // Authenticated users
        activeUsersPerMinute,
        activeUsersLast5m,
        activeUsersLast30m,
        // Guests
        activeGuestsPerMinute,
        activeGuestsLast5m,
        activeGuestsLast30m,
        // The two names the dashboard actually reads for its "now" tiles, with the window
        // its type documents (`DashboardSummary.activeUsersNow`: "last 5 minutes"). This job
        // is the only per-minute writer of this document since the heartbeat's copy was
        // removed, so these two were fossils `{merge: true}` never overwrote: the tiles
        // showed whatever the heartbeat last wrote instead of going blank or to zero.
        activeUsersNow: activeUsersLast5m,
        activeGuestsNow: activeGuestsLast5m,
        // Requests the BFF served today, including the visitors the consent gate is
        // required to skip — the only traffic number here that does not depend on consent.
        // A level, not a visitor count.
        requestsToday,
        // Consent decisions reported by the banner: aggregate counts of decisions, not of
        // people, and the only place a refusal is ever visible.
        consentGrantedToday,
        consentDeclinedToday,
        // Combined
        onlineNow: activeUsersPerMinute + activeGuestsPerMinute,
        onlineLast5m: activeUsersLast5m + activeGuestsLast5m,
        onlineLast30m: activeUsersLast30m + activeGuestsLast30m,
        lastUpdated: Timestamp.now(),
      }, { merge: true })

      console.log(
        `✅ Active users — 1m: ${activeUsersPerMinute}, 5m: ${activeUsersLast5m}, 30m: ${activeUsersLast30m}`,
      )
    } catch (error) {
      console.error("❌ computeActiveUsersNow failed:", error)
    }
  },
)
