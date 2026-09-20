/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
/* eslint-disable linebreak-style */
import { Request, Response, NextFunction } from "express"
import { getClientIp } from "request-ip"
import { parseUA } from "../infrastructure/ua-parser"
import { ANALYTICS_EVENTS, buildAnalyticsEvent, Guest, hasAnalyticsConsent, isIndexableGuestIp, isNonRoutableIp, normalizeUtm, resolveGuestIdentity, shouldPersistGuestLastSeen, toEventHour } from "../domain"
import { normalizeClientAnalyticsEvent, UNKNOWN_CLIENT_ANALYTICS_EVENT } from "../../../src/config/analytics-events"
import { isRedisEnabled, parseCachedJson, redis } from "../app/cacheConfig"
import {
  ANALYTICS_EVENTS_KEY,
  CLIENT_EVENT_LIST_MAX,
  CLIENT_EVENT_MAX,
  DRAIN_CHUNKS_PER_RUN,
  CLIENT_EVENT_PROP_MAX,
  GEO_CACHE_FAILURE_TTL_SECONDS,
  GEO_CACHE_TTL_SECONDS,
  GUEST_FINGERPRINT_TTL_SECONDS,
  GUEST_IP_TTL_SECONDS,
  GUEST_LAST_SEEN_WRITE_INTERVAL_MS,
  PRESENCE_TTL_SECONDS,
  geoCacheKey,
  guestFingerprintKey,
  guestIpKey,
  presenceGuestKey,
} from "../../../src/config/redis-keys"
import { db } from "../app/config"
import { FieldValue } from "firebase-admin/firestore"
import net from "node:net"
import crypto from "crypto"
import { env } from "../config/env"

// Determine if running in production based on environment variable
const isProduction = env.IS_PRODUCTION

export type ResolvedNetworkData = {
  asn: string | null
  as: string | null
  isp: string | null
  domain: string | null
  usageType: string | null
}

export type ResolvedProxyData = {
  isProxy: boolean
  proxyType: string | null
  threat: string | null
  lastSeenDays: number | null
  provider: string | null
  fraudScore: number | null
  confidence: "none" | "open-proxy-detected" | "unknown"
}

const geoApiBaseUrl = (env.IP_GEO_API_URL || "https://ip.deepscrape.dev/api/geo/lookup").trim().replace(/\/+$/, "")
// When IPREGISTRY_API_KEY is set, lookups go to ipregistry instead of the custom geo API.
const ipregistryApiKey = env.IPREGISTRY_API_KEY.trim()
const geoCacheTtlSeconds = GEO_CACHE_TTL_SECONDS
// A failed lookup is cached too, but for far less time: see redis-keys.ts.
const geoFailureCacheTtlSeconds = GEO_CACHE_FAILURE_TTL_SECONDS

// ponytail: coalesce concurrent cold-miss lookups for the same IP (rate limiter +
// guest/session enrichment on one first-seen visitor) into a single provider call.
// Instance-local only; Redis cache dedupes across instances and over time.
const inflightGeoLookups = new Map<string, Promise<ResolvedGeoData | null>>()

export type ResolvedGeoData = {
  ip: string
  countryShort: string
  countryLong: string
  region: string
  city: string
  latitude: number | null
  longitude: number | null
  timeZone: string
  asn: string | null
  as: string | null
  isp: string | null
  domain: string | null
  usageType: string | null
  network: ResolvedNetworkData
  proxy: ResolvedProxyData
}

type CachedGeoLookup = {
  hit: boolean
  data: ResolvedGeoData | null
}

type GeoLookupApiLocation = {
  countryCode?: string | null
  countryName?: string | null
  region?: string | null
  city?: string | null
  postalCode?: string | null
  latitude?: number | string | null
  longitude?: number | string | null
  timeZoneOffset?: string | null
  timeZoneName?: string | null
}

type GeoLookupApiNetwork = {
  asn?: string | number | null
  asName?: string | null
  isp?: string | null
  domain?: string | null
  usageType?: string | null
}

type GeoLookupApiProxy = {
  isProxy?: boolean | number | string | null
  proxyType?: string | null
  threat?: string | null
  lastSeenDays?: number | string | null
  provider?: string | null
  fraudScore?: number | string | null
}

type GeoLookupApiCoverage = {
  geo?: boolean
  asn?: boolean
  proxy?: boolean
}

type GeoLookupApiEnvelope = {
  lookup?: GeoLookupApiResponse | null
}

type GeoLookupApiResponse = {
  ip?: string | null
  requestedAt?: string | null
  expectedProxy?: boolean | null
  location?: GeoLookupApiLocation | null
  network?: GeoLookupApiNetwork | null
  proxy?: GeoLookupApiProxy | null
  coverage?: GeoLookupApiCoverage | null
  data?: GeoLookupApiEnvelope | null
  countryCode?: string | null
  countryName?: string | null
  countryShort?: string | null
  countryLong?: string | null
  region?: string | null
  city?: string | null
  latitude?: number | string | null
  longitude?: number | string | null
  timeZoneOffset?: string | null
  timeZoneName?: string | null
  timezone?: string | null
  asn?: string | number | null
  asName?: string | null
  as?: string | null
  isp?: string | null
  domain?: string | null
  usageType?: string | null
  isProxy?: boolean | number | string | null
  proxyType?: string | null
  threat?: string | null
  lastSeenDays?: number | string | null
  provider?: string | null
  fraudScore?: number | string | null
}

export type GeoLookupRequestContext = {
  firebaseUid?: string | null
  userRoles?: string | string[] | null
  requestId?: string | null
  forwardedFor?: string | null
}

/**
 * normalizeGeoLookupRoles
 * @param {*} values
 * @return {*}
 */
export function normalizeGeoLookupRoles(...values: unknown[]): string[] {
  const roles: string[] = []

  const appendRoleValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        appendRoleValue(entry)
      }
      return
    }

    const text = String(value ?? "").trim()
    if (!text) {
      return
    }

    for (const part of text.split(",")) {
      const role = part.trim().toLowerCase()
      if (role) {
        roles.push(role)
      }
    }
  }

  for (const value of values) {
    appendRoleValue(value)
  }

  return Array.from(new Set(roles))
}

/**
 * compactRoleHeader
 * @param {*} value
 * @return {*}
 */
function compactRoleHeader(value: GeoLookupRequestContext["userRoles"]): string {
  return normalizeGeoLookupRoles(value).join(",")
}

/**
 * createGeoRequestId
 * @param {*} input
 * @return {*}
 */
function createGeoRequestId(input: string | null | undefined): string {
  const requestId = String(input || "").trim()
  if (requestId) {
    return requestId
  }

  return `geo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * buildGeoLookupHeaders
 * @param {*} ip
 * @param {*} context
 * @return {*}
 */
function buildGeoLookupHeaders(
  ip: string,
  context?: GeoLookupRequestContext
): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "x-firebase-uid": String(context?.firebaseUid || "functions-system").trim() || "functions-system",
    "x-user-roles": compactRoleHeader(context?.userRoles) || "guest",
    "x-request-id": createGeoRequestId(context?.requestId),
  }

  const normalizedForwarded = normalizePublicIp(context?.forwardedFor || ip)
  if (normalizedForwarded) {
    headers["x-forwarded-for"] = normalizedForwarded
  }

  return headers
}

/**
 * normalizePublicIp
 * @param {*} value
 * @return {*}
 */
export function normalizePublicIp(value: string | null | undefined): string {
  const raw = String(value || "").trim()
  if (!raw) {
    return ""
  }

  const first = raw.split(",")[0]?.trim() || ""
  if (first.startsWith("::ffff:")) {
    return first.substring(7)
  }

  return first
}

/**
 * buildGeoLookupUrl
 * @param {*} ip
 * @return {*}
 */
function buildGeoLookupUrl(ip: string): string {
  const url = new URL(geoApiBaseUrl)
  if (ip) {
    url.searchParams.set("ip", ip)
  }
  return url.toString()
}

/**
 * sanitizeText
 * @param {*} value
 * @return {*}
 */
function sanitizeText(value: unknown): string | null {
  const text = String(value || "").trim()
  if (!text || text === "-") {
    return null
  }

  const normalized = text.toLowerCase()
  if (normalized === "null" || normalized === "undefined" || normalized === "n/a") {
    return null
  }

  return text
}

/**
 * parseNullableNumber
 * @param {*} value
 * @return {*}
 */
function parseNullableNumber(value: unknown): number | null {
  const text = sanitizeText(value)
  if (!text) {
    return null
  }

  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

/**
 * resolveProxyConfidence
 * @param {*} args
 * @return {*}
 */
function resolveProxyConfidence(args: {
  isProxy: boolean
  coverage: GeoLookupApiCoverage | null | undefined
}): ResolvedProxyData["confidence"] {
  if (args.isProxy) {
    return "open-proxy-detected"
  }

  return args.coverage?.proxy === true ? "none" : "unknown"
}

/**
 * mapGeoLookupResponse
 * @param {*} payload
 * @param {*} fallbackIp
 * @return {*}
 */
function mapGeoLookupResponse(payload: GeoLookupApiResponse, fallbackIp: string): ResolvedGeoData | null {
  const lookupPayload = payload.data?.lookup && typeof payload.data.lookup === "object" ? payload.data.lookup : payload

  const location = lookupPayload.location || {
    countryCode: lookupPayload.countryCode || lookupPayload.countryShort || null,
    countryName: lookupPayload.countryName || lookupPayload.countryLong || null,
    region: lookupPayload.region || null,
    city: lookupPayload.city || null,
    latitude: lookupPayload.latitude ?? null,
    longitude: lookupPayload.longitude ?? null,
    timeZoneOffset: lookupPayload.timeZoneOffset || lookupPayload.timezone || null,
    timeZoneName: lookupPayload.timeZoneName || lookupPayload.timezone || null,
  }

  const network = lookupPayload.network || {
    asn: lookupPayload.asn ?? null,
    asName: lookupPayload.asName || lookupPayload.as || null,
    isp: lookupPayload.isp || null,
    domain: lookupPayload.domain || null,
    usageType: lookupPayload.usageType || null,
  }

  const proxy = lookupPayload.proxy || {
    isProxy: lookupPayload.isProxy ?? null,
    proxyType: lookupPayload.proxyType || null,
    threat: lookupPayload.threat || null,
    lastSeenDays: lookupPayload.lastSeenDays ?? null,
    provider: lookupPayload.provider || null,
    fraudScore: lookupPayload.fraudScore ?? null,
  }

  const coverage = lookupPayload.coverage || payload.coverage

  const countryShort = sanitizeText(location.countryCode)
  if (!countryShort) {
    return null
  }

  const countryLong = sanitizeText(location.countryName) || "Unknown"
  const region = sanitizeText(location.region) || "Unknown"
  const city = sanitizeText(location.city) || "Unknown"
  const latitude = parseNullableNumber(location.latitude)
  const longitude = parseNullableNumber(location.longitude)
  const timeZone = sanitizeText(location.timeZoneName) || sanitizeText(location.timeZoneOffset) || "UTC"

  const asn = sanitizeText(network.asn)
  const asName = sanitizeText(network.asName)
  const isp = sanitizeText(network.isp)
  const domain = sanitizeText(network.domain)
  const usageType = sanitizeText(network.usageType)
  const isProxy = proxy.isProxy === true || proxy.isProxy === 1 || proxy.isProxy === "1" || proxy.isProxy === "true"

  const proxyData: ResolvedProxyData = {
    isProxy,
    proxyType: sanitizeText(proxy.proxyType),
    threat: sanitizeText(proxy.threat),
    lastSeenDays: parseNullableNumber(proxy.lastSeenDays),
    provider: sanitizeText(proxy.provider),
    fraudScore: parseNullableNumber(proxy.fraudScore),
    confidence: resolveProxyConfidence({ isProxy, coverage }),
  }

  const resolvedIp = sanitizeText(lookupPayload.ip) || sanitizeText(payload.ip) || fallbackIp
  if (!resolvedIp) {
    return null
  }

  const networkData: ResolvedNetworkData = {
    asn,
    as: asName,
    isp,
    domain,
    usageType,
  }

  return {
    ip: resolvedIp,
    countryShort,
    countryLong,
    region,
    city,
    latitude,
    longitude,
    timeZone,
    asn,
    as: asName,
    isp,
    domain,
    usageType,
    network: networkData,
    proxy: proxyData,
  }
}

type IpregistryPayload = {
  ip?: unknown
  location?: {
    country?: { code?: unknown; name?: unknown }
    region?: { name?: unknown }
    city?: unknown
    latitude?: unknown
    longitude?: unknown
  }
  connection?: {
    asn?: unknown
    domain?: unknown
    organization?: unknown
    type?: unknown
  }
  company?: {
    domain?: unknown
    type?: unknown
  }
  time_zone?: {
    id?: unknown
  }
  security?: {
    is_proxy?: unknown
    is_vpn?: unknown
    is_tor?: unknown
    is_threat?: unknown
    is_abuser?: unknown
    is_attacker?: unknown
  }
}

/**
 * mapIpregistryResponse
 * @param {*} payload
 * @param {*} fallbackIp
 * @return {*}
 */
export function mapIpregistryResponse(
  payload: IpregistryPayload,
  fallbackIp: string
): ResolvedGeoData | null {
  const location = payload.location || {}
  const connection = payload.connection || {}
  const company = payload.company || {}
  const security = payload.security || {}

  const countryShort = sanitizeText(location.country?.code)
  if (!countryShort) {
    return null
  }

  const countryLong = sanitizeText(location.country?.name) || "Unknown"
  const region = sanitizeText(location.region?.name) || "Unknown"
  const city = sanitizeText(location.city) || "Unknown"
  const latitude = parseNullableNumber(location.latitude)
  const longitude = parseNullableNumber(location.longitude)
  const timeZone = sanitizeText(payload.time_zone?.id) || "UTC"

  const asn = sanitizeText(connection.asn)
  // ponytail: ipregistry has no isp/proxy_type/fraud fields. isp=AS org, proxyType derived from flags.
  const asName = sanitizeText(connection.organization)
  const domain = sanitizeText(connection.domain) || sanitizeText(company.domain)
  const usageType = sanitizeText(connection.type) || sanitizeText(company.type)

  const isProxy = security.is_proxy === true || security.is_vpn === true || security.is_tor === true
  const proxyType = security.is_tor === true ? "tor" : security.is_vpn === true ? "vpn" : security.is_proxy === true ? "proxy" : null
  const threat = security.is_threat === true ? "is_threat" :
    security.is_abuser === true ? "is_abuser" :
      security.is_attacker === true ? "is_attacker" : null

  const proxyData: ResolvedProxyData = {
    isProxy,
    proxyType,
    threat,
    lastSeenDays: null,
    provider: null,
    fraudScore: null,
    confidence: isProxy ? "open-proxy-detected" : "none",
  }

  const networkData: ResolvedNetworkData = {
    asn,
    as: asName,
    isp: asName,
    domain,
    usageType,
  }

  return {
    ip: sanitizeText(payload.ip) || fallbackIp,
    countryShort,
    countryLong,
    region,
    city,
    latitude,
    longitude,
    timeZone,
    asn,
    as: asName,
    isp: asName,
    domain,
    usageType,
    network: networkData,
    proxy: proxyData,
  }
}

/**
 * fetchIpregistryLookup
 * @param {*} ip
 */
async function fetchIpregistryLookup(ip: string): Promise<ResolvedGeoData | null> {
  const controller = new AbortController()
  /**
   * callback
   */
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const url = `https://api.ipregistry.co/${encodeURIComponent(ip)}?key=${encodeURIComponent(ipregistryApiKey)}`
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      if (response.status === 404) {
        return null
      }

      throw new Error(`Ipregistry lookup returned ${response.status}`)
    }

    const payload = await response.json() as IpregistryPayload
    return mapIpregistryResponse(payload, ip)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * fetchGeoLookup
 * @param {*} ip
 * @param {*} context
 */
async function fetchGeoLookup(
  ip: string,
  context?: GeoLookupRequestContext
): Promise<ResolvedGeoData | null> {
  const controller = new AbortController()
  /**
   * callback
   */
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch(buildGeoLookupUrl(ip), {
      method: "GET",
      headers: buildGeoLookupHeaders(ip, context),
      signal: controller.signal,
    })

    if (!response.ok) {
      if (response.status === 404 || response.status === 204) {
        return null
      }

      throw new Error(`Geo lookup API returned ${response.status}`)
    }

    const payload = await response.json() as GeoLookupApiResponse
    return mapGeoLookupResponse(payload, ip)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * buildGeoCacheKey
 * @param {*} ip
 * @return {*}
 */
function buildGeoCacheKey(ip: string): string {
  const digest = crypto.createHash("sha256").update(ip).digest("hex")
  return geoCacheKey(digest)
}

/**
 * readCachedGeoLookup
 * @param {*} ip
 */
async function readCachedGeoLookup(ip: string): Promise<CachedGeoLookup> {
  try {
    const cached = await redis.get(buildGeoCacheKey(ip))
    const parsed = parseCachedJson<{ miss?: boolean; data?: ResolvedGeoData | null }>(cached)
    if (!parsed) {
      return { hit: false, data: null }
    }
    if (parsed?.miss) {
      return { hit: true, data: null }
    }

    return { hit: true, data: parsed?.data || null }
  } catch (error) {
    console.warn("Failed to read IP intelligence cache:", error)
    return { hit: false, data: null }
  }
}

/**
 * writeCachedGeoLookup
 * @param {*} ip
 * @param {*} data
 */
async function writeCachedGeoLookup(ip: string, data: ResolvedGeoData | null): Promise<void> {
  try {
    const payload = data ? { data } : { miss: true }
    // Negative entries get the shorter TTL so a provider outage is retried sooner
    // than a legitimate no-match result.
    const ttlSeconds = data ? geoCacheTtlSeconds : geoFailureCacheTtlSeconds
    await redis.setex(buildGeoCacheKey(ip), ttlSeconds, JSON.stringify(payload))
  } catch (error) {
    console.warn("Failed to write IP intelligence cache:", error)
  }
}

/**
 * lookupGeoByIp
 * @param {*} ipInput
 * @param {*} context
 */
export async function lookupGeoByIp(
  ipInput: string | null | undefined,
  context?: GeoLookupRequestContext
): Promise<ResolvedGeoData | null> {
  const ip = normalizePublicIp(ipInput)
  if (!ip) {
    return null
  }

  // A reserved or private address has no country in any database, so the provider can
  // only answer nulls -- and bills for it. Refusing it here covers every caller at once
  // (session enrichment, the rate limiter, checkout's currency choice) rather than each
  // one paying for the same impossible answer.
  if (isNonRoutableIp(ip)) {
    return null
  }

  const cachedLookup = await readCachedGeoLookup(ip)
  if (cachedLookup.hit) {
    return cachedLookup.data
  }

  // A disabled Redis client answers every GET with null and swallows every SET, so the
  // cache reports a miss forever: EVERY lookup becomes a paid provider call, once per
  // request, silently, for as long as the function is missing its FUNCTIONS_ENV_JSON
  // binding. The client-event drain already guards exactly this; the geo path did not,
  // which is how "one lookup per 24h" becomes "one lookup per request".
  if (!isRedisEnabled) {
    console.warn(
      "[geo] Upstash Redis disabled in this process - the geo cache is inert and every " +
      "IP lookup will call the provider. FUNCTIONS_ENV_JSON is not bound to this function.",
    )
  }

  // Single-flight: if a sibling path (rate limiter, guest/session enrichment) is
  // already resolving this cold IP, join that call instead of starting a second.
  const inFlight = inflightGeoLookups.get(ip)
  if (inFlight) {
    return inFlight
  }

  const lookup = (async (): Promise<ResolvedGeoData | null> => {
    try {
      const resolvedData = ipregistryApiKey ? await fetchIpregistryLookup(ip) : await fetchGeoLookup(ip, context)
      await writeCachedGeoLookup(ip, resolvedData)
      return resolvedData
    } catch (error) {
      console.warn("Failed to resolve IP intelligence from geo API:", error)
      // ponytail: cache the failure so heartbeat-triggered re-enrichment stops hammering a down provider on every write.
      await writeCachedGeoLookup(ip, null).catch(() => undefined)
      return null
    } finally {
      inflightGeoLookups.delete(ip)
    }
  })()

  inflightGeoLookups.set(ip, lookup)
  return lookup
}

// Geo lookup uses the remote ip.deepscrape.dev API.
/* eslint-disable @typescript-eslint/ban-types */
// ponytail: first-touch acquisition captured once at guest creation; no UTM infra needed.
/**
 * buildGuestAcquisition
 * @param {*} req
 * @return {*}
 */
function buildGuestAcquisition(req: Request): Guest["acquisition"] {
  // The request object here is built by the functions-framework's Express 5 app and
  // then handed to our Express 4 app, so Express 4's lazy `query` getter is not on the
  // prototype and `req.query` can be undefined. server.ts:211 already guards its read
  // (`req.query?._csrf`); this one did not, and threw on every anonymous request —
  // i.e. a 500 for every visitor without a `gid`/`aid` cookie.
  const query = (req.query ?? {}) as Record<string, unknown>
  const toText = (value: unknown): string | undefined => {
    const raw = Array.isArray(value) ? value[0] : value
    const text = String(raw ?? "").trim().toLowerCase()
    return text ? text.slice(0, 120) : undefined
  }

  const toHost = (value: unknown): string | undefined => {
    const text = toText(value)
    if (!text) {
      return undefined
    }
    try {
      return new URL(text).hostname || undefined
    } catch {
      return text.slice(0, 120)
    }
  }

  // UTM values are untrusted query text that ends up in counter keys
  // (`byChannel.<source>`), so normalise at capture rather than store raw: "Google",
  // "google " and "google+ads" otherwise minted three channels for one source. The
  // canonicaliser now lives in domain/analytics-helpers so it is unit tested; the
  // closure it replaced was unreachable from any test.
  const acquisition = {
    utmSource: normalizeUtm(toText(query["utm_source"])),
    utmMedium: normalizeUtm(toText(query["utm_medium"])),
    utmCampaign: normalizeUtm(toText(query["utm_campaign"])),
    utmTerm: normalizeUtm(toText(query["utm_term"])),
    utmContent: normalizeUtm(toText(query["utm_content"])),
    referrer: toHost(req.headers.referer || req.headers.referrer),
    landingPath: String(req.path || "").slice(0, 200) || undefined,
  }

  // Firestore rejects a document containing `undefined` outright, so absent
  // fields have to be dropped rather than carried. Without this, any visit with
  // no UTM params produced `{utmSource: undefined, ...}` and the whole guest
  // write failed (`Cannot use "undefined" as a Firestore value`), swallowed by
  // the caller's try/catch. `ignoreUndefinedProperties` would also fix this but
  // globally, hiding the next genuinely-wrong `undefined` instead of throwing.
  const present = Object.entries(acquisition).filter(
    ([, value]) => value !== undefined,
  )

  return present.length ? (Object.fromEntries(present) as Guest["acquisition"]) : undefined
}

// Guest tracking middleware for Express
// Ensures unique guest analytics using fingerprinting and Redis/Firestore

/** Shape of the cached guest liveness record written by `guestTracker`. */
type GuestLastSeenCache = {
  lastSeen?: string
  signedAt?: number
  /**
   * Epoch ms of the last Firestore `lastSeen` persist. Tracked here so the write
   * throttle is decided from the cache instead of reading the guest document.
   */
  persistedAt?: number
}

/**
 * Whether the cached guest record is recent enough to skip both the Redis
 * refresh and the Firestore read. A record written before `signedAt` existed
 * fails this check, so the first request after deploy writes one and every
 * request after that is a pure cache hit.
 * @param {*} cached
 * @return {*}
 */
const isGuestCacheFresh = (cached: GuestLastSeenCache | null): boolean => {
  if (!cached) {
    return false
  }
  if (typeof cached.signedAt === "number") {
    return Date.now() - cached.signedAt < GUEST_LAST_SEEN_WRITE_INTERVAL_MS
  }
  if (typeof cached.lastSeen === "string") {
    const seenMs = new Date(cached.lastSeen).getTime()
    return Number.isFinite(seenMs) && Date.now() - seenMs < GUEST_LAST_SEEN_WRITE_INTERVAL_MS
  }
  return false
}

/**
 * guestTracker
 * @param {*} req
 * @param {*} res
 * @param {*} next
 */
export async function guestTracker(req: Request, res: Response, next: NextFunction) {
  let guestId = req.cookies["gid"]
  if (!env.IS_PRODUCTION) {
    // ponytail: this used to log req.headers as well — i.e. `authorization` (the
    // Firebase ID token) and `cookie` (aid/gid/_csrf_secret/sid) on every request.
    // It is env-gated, so a single staging misconfiguration promoted it to a
    // production bearer-token leak. The guest ID is the only useful signal.
    console.log("guestTracker: Incoming request - Guest ID from cookie:", guestId) // Debug log
  }

  const user = req.app.locals["user"] as string | null
  const isUser = !!user

  // Only track guests, skip if authenticated or has aid cookie
  if (isUser || req.cookies["aid"]) return next()

  // ePrivacy Art. 5(3): no consent, no guest record. Before this guard every
  // anonymous request minted a one-year `gid` cookie and a
  // `guests/{sha256(ip|ua|os|device)}` document, while the privacy policy
  // promised analytics "with your consent" -- the record was created before the
  // visitor could answer. Returning here skips the fingerprint, all three Redis
  // probes, both mint branches and the lastSeen write; this is the single door
  // into every one of them, so it is the whole fix.
  if (!hasAnalyticsConsent(req.cookies)) return next()

  // Get IP and fingerprint. Read once: the create branch below used to call
  // getClientIps + parseUA a second time for the same request.
  const { ipv4, ipv6, raw } = await getClientIps(req)
  const ip = raw as string
  const agent = parseUA(req.headers["user-agent"] || "")
  const fingerstring = `${ip}|${agent.family}|${agent.os.family}|${agent.device.family}`
  // Create SHA-256 hash of the fingerprint for privacy
  const fingerprint = crypto.createHash("sha256").update(fingerstring).digest("hex")
  // Guest IP index digest, hashed for the same reason the fingerprint is. Empty
  // when the address is not specific enough to identify anybody (private, CGNAT,
  // loopback, unparseable), which disables the IP fallback for that request.
  const publicGuestIp = normalizePublicIp(ip)
  const guestIpDigest = isIndexableGuestIp(publicGuestIp) ? crypto.createHash("sha256")
    .update(publicGuestIp).digest("hex") : ""
  // One pipeline for both cache probes. This middleware runs on every anonymous
  // request, and the previous shape paid two sequential round-trips plus an
  // unconditional Firestore read for a value that had not changed.
  let existingGuestId: string | null = null
  let cachedGuestSeen: GuestLastSeenCache | null = null
  try {
    const guestProbe = redis.pipeline()
    guestProbe.get(guestFingerprintKey(fingerprint))
    // Only probe the guest key when there is one: an empty key is a REST error, and
    // the whole pipeline failing would discard the fingerprint hit too.
    if (guestId) guestProbe.get(presenceGuestKey(guestId))
    const [fingerprintHit, guestHit] = (await guestProbe.exec()) as [unknown, unknown]
    existingGuestId = typeof fingerprintHit === "string" ? fingerprintHit : null
    cachedGuestSeen = parseCachedJson<GuestLastSeenCache>(guestHit)
  } catch (error) {
    console.warn("guestTracker: Redis unavailable while checking the guest cache", error)
  }
  // The IP index is the last resort before minting a guest document, so it is
  // only probed when the cookie AND the fingerprint have both missed: the common
  // paths pay nothing for it.
  let ipGuestId: string | null = null
  if (!guestId && !existingGuestId && guestIpDigest) {
    try {
      const ipHit = await redis.get(guestIpKey(guestIpDigest))
      ipGuestId = typeof ipHit === "string" && ipHit ? ipHit : null
    } catch (error) {
      console.warn("guestTracker: Redis unavailable while checking the guest IP index", error)
    }
  }
  const identity = resolveGuestIdentity({ fingerprintGuestId: existingGuestId, ipGuestId })
  if (!guestId && identity.guestId) {
    guestId = identity.guestId
    res.cookie("gid", guestId, { httpOnly: false, secure: isProduction, sameSite: "lax", maxAge: 31536000000 })
    if (identity.source === "ip") {
      // An IP match means this fingerprint is new to us: teach the fast path the
      // fingerprint and slide the IP index forward. Fire-and-forget — the visitor
      // is already identified, so neither write may delay the response.
      void Promise.allSettled([
        redis.setex(guestFingerprintKey(fingerprint), GUEST_FINGERPRINT_TTL_SECONDS, guestId),
        redis.setex(guestIpKey(guestIpDigest), GUEST_IP_TTL_SECONDS, guestId),
      ]).catch(() => undefined)
    }
    // The cache entry is the throttle for both the Redis refresh and the Firestore
    // read: if it is fresh, nothing about this request needs writing at all.
    if (!isGuestCacheFresh(cachedGuestSeen)) {
      const now = new Date()
      const nowMs = now.getTime()
      // The Firestore write used to be gated by reading `guests/{id}` and comparing
      // its stored `lastSeen` -- a read per guest per interval for a value the cached
      // record already tracks. `shouldPersistGuestLastSeen` answers from the cache.
      const persist = shouldPersistGuestLastSeen(
        cachedGuestSeen?.persistedAt,
        nowMs,
        GUEST_LAST_SEEN_WRITE_INTERVAL_MS,
      )
      const [cacheWrite] = await Promise.allSettled([
        redis.setex(presenceGuestKey(guestId), PRESENCE_TTL_SECONDS, JSON.stringify({
          lastSeen: now,
          signedAt: nowMs,
          persistedAt: persist ? nowMs : cachedGuestSeen?.persistedAt,
        })),
        // The provenance rides along with the write we were already making, so an
        // over-merged guest (several people behind one IP) can be audited later.
        persist ?
          db.collection("guests").doc(guestId).set(
            identity.source === "ip" ? { lastSeen: now, identitySource: "ip" } : { lastSeen: now },
            { merge: true },
          ) :
          Promise.resolve(),
      ])
      if (cacheWrite.status === "rejected") {
        console.warn("guestTracker: Redis unavailable while updating guest lastSeen", cacheWrite.reason)
      }
    }
    return next()
  }

  // If no guestId and no fingerprint mapping, create new guest and store fingerprint
  if (!guestId) {
    guestId = db.collection("guests").doc().id // Generate a new Firestore ID
    // Set secure flag conditionally
    res.cookie("gid", guestId, { httpOnly: false, secure: isProduction, sameSite: "lax", maxAge: 31536000000 }) // 1 year

    const guestData: Guest = {
      id: guestId,
      uid: "", // Will be set when linked to a user
      ip: { ipv4, ipv6: ipv6 || null, raw },
      userAgent: agent.toString(), // Store full user agent string
      browser: agent.family,
      os: agent.os.family,
      device: agent.device.family,
      // Bot / AI-agent classification drives the bot-free analytics funnel.
      isBot: agent.isBot,
      botKind: agent.botKind,
      language: req.headers["accept-language"]?.split(",")[0] || "en",
      timezone: "UTC",
      country: "Unknown",
      geo: { continent: "Unknown", region: "Unknown" },
      region: "Unknown",
      latitude: 0,
      longitude: 0,
      location: "Unknown",
      acquisition: buildGuestAcquisition(req),
      createdAt: new Date(),
      lastSeen: new Date(),
      fingerprint,
      identitySource: "new",
    }
    const guestIntelligenceSeed = {
      intelligenceSourceIp: normalizePublicIp(ip),
      intelligenceStatus: "pending",
      intelligenceUpdatedAt: null,
    }
    req.clientIp = ip
    try {
      await Promise.allSettled([
        redis.setex(
          presenceGuestKey(guestId),
          PRESENCE_TTL_SECONDS,
          JSON.stringify({ ...guestData, ...guestIntelligenceSeed }),
        ),
        // This mapping used to be written with no expiry, so every new IP/UA pair
        // minted a key that never went away. Bounded to match the guest cookie.
        redis.setex(guestFingerprintKey(fingerprint), GUEST_FINGERPRINT_TTL_SECONDS, guestId),
        // IP index, so the next cookie-less fingerprint from this address is
        // absorbed into this guest rather than minting a second document for one
        // visitor. Skipped when the address identifies nobody (see the digest).
        ...(guestIpDigest ? [redis.setex(guestIpKey(guestIpDigest), GUEST_IP_TTL_SECONDS, guestId)] : []),
        db.collection("guests").doc(guestId).set({ ...guestData, ...guestIntelligenceSeed }, { merge: true }),
      ])
    } catch (error) {
      console.error("Error storing guest data:", error)
    }
    res.setHeader("Accept-CH", "Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Form-Factors, x-forwarded-for'")
  }
  return next()
}

// API endpoint to receive guest fingerprint data from frontend
/**
 * guestFingerprintHandler
 * @param {*} req
 * @param {*} res
 */
export async function guestFingerprintHandler(req: Request, res: Response) {
  // ePrivacy: the same gate as guestTracker. This is the only writer of
  // `guest_fp`, and it sets a one-year device fingerprint, so a visitor who
  // declined must not get one. The caller (`SizeDetectorComponent`) ignores the
  // body and every consumer of the cookie has a null fallback, so answering with
  // `fingerprint: null` keeps the contract while storing nothing.
  if (!hasAnalyticsConsent(req.cookies)) {
    res.status(200).json({ success: true, fingerprint: null })
    return
  }

  try {
    const fingerprintData = req.body
    // Hash the fingerprint for privacy
    const fingerprintString = JSON.stringify(fingerprintData)
    const fingerprintHash = crypto.createHash("sha256").update(fingerprintString).digest("hex")
    // Attach to session or cookie for guest tracking
    res.cookie("guest_fp", fingerprintHash, { httpOnly: false, secure: isProduction, sameSite: "lax", maxAge: 31536000000 })
    res.status(200).json({ success: true, fingerprint: fingerprintHash })
  } catch (error) {
    console.error("guestFingerprintHandler failed:", error)
    res.status(500).json({ success: false, error: "Internal error" })
  }
}

// Standardized analytics event schema
export type AnalyticsEvent = {
  timestamp: number,
  userId?: string,
  guestId?: string,
  eventType: string,
  metadata?: Record<string, string | number | boolean | null>,
  /** Tagged at ingress from the request UA, so the drain can filter bots. */
  isBot?: boolean,
  botKind?: string | null,
}

// Bounded client-event ingress: the drain processes CLIENT_EVENT_MAX per run and
// the list is hard-capped, so a stalled drain can never grow Redis forever.
// The caps live in src/config/redis-keys.ts and are re-exported here for callers
// that already import them from this module.
export { CLIENT_EVENT_LIST_MAX, CLIENT_EVENT_MAX }

// ponytail: trust boundary — client metadata is reduced to short scalars before it
// reaches Redis or Firestore, so a hostile payload cannot bloat either store.
const sanitizeMetadata = (metadata: unknown): Record<string, string | number | boolean | null> => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {}
  return Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>)
      .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
      .slice(0, CLIENT_EVENT_PROP_MAX)
      .map(([key, value]) => [
        String(key).slice(0, 60),
        typeof value === "string" ? value.slice(0, 200) : value as string | number | boolean | null,
      ]),
  )
}

export const toClientEvent = (body: unknown, ua: ReturnType<typeof parseUA>): AnalyticsEvent => {
  const raw = (body || {}) as { eventType?: unknown, event?: unknown, userId?: unknown, guestId?: unknown, metadata?: unknown, properties?: unknown }
  return {
    timestamp: Date.now(),
    // ponytail: clients have shipped both shapes (`eventType`/`metadata` and
    // `event`/`properties`). Accept either here so a mismatch cannot silently land
    // as `unknown` with empty props — this is the boundary all clients route through.
    eventType: String(raw.eventType ?? raw.event ?? "unknown").replace(/[^\w-]/g, "_").slice(0, 60),
    userId: typeof raw.userId === "string" ? raw.userId.slice(0, 128) : undefined,
    guestId: typeof raw.guestId === "string" ? raw.guestId.slice(0, 128) : undefined,
    isBot: ua.isBot,
    botKind: ua.botKind,
    metadata: sanitizeMetadata(raw.metadata ?? raw.properties),
  }
}

/**
 * Append client events and enforce the hard ingress cap in the same pipeline.
 *
 * The cap used to be applied only by the 30-minute drain. Between drains the list
 * grew with traffic, so a stalled or slow drain could push Redis memory into
 * eviction. One LPUSH + LTRIM per request keeps the list bounded at all times.
 *
 * LPUSH prepends, so `0..MAX-1` retains the newest MAX entries.
 *
 * Contract: producer LPUSHes, so the consumer MUST pop the opposite end (RPOP).
 * Popping this end drains newest-first, which starves the backlog: old events are
 * never read and are only removed by the LTRIM above, i.e. dropped unprocessed.
 * @param {*} events
 */
const appendClientEvents = async (events: string[]): Promise<number> => {
  const pipeline = redis.pipeline()
  pipeline.lpush(ANALYTICS_EVENTS_KEY, ...events)
  pipeline.ltrim(ANALYTICS_EVENTS_KEY, 0, CLIENT_EVENT_LIST_MAX - 1)
  const [, length] = (await pipeline.exec()) as [number, string]
  return Number(length)
}

// API endpoint to receive analytics events from frontend
/**
 * analyticsEventHandler
 * @param {*} req
 * @param {*} res
 */
export async function analyticsEventHandler(req: Request, res: Response) {
  try {
    const event = toClientEvent(req.body, parseUA(req.headers["user-agent"] || ""))
    await appendClientEvents([JSON.stringify(event)])
    res.status(200).json({ success: true })
  } catch (error) {
    console.warn("analyticsEventHandler: Redis unavailable, dropping event", error)
    res.status(202).json({ success: false, accepted: false })
  }
}

/**
 * batchAnalyticsEventHandler
 * @param {*} req
 * @param {*} res
 */
export async function batchAnalyticsEventHandler(req: Request, res: Response) {
  try {
    const { events } = req.body
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: "No events provided" })
    }
    // Bound the batch as well as the list: one request could otherwise carry an
    // unbounded array and force a single oversized Redis command.
    if (events.length > CLIENT_EVENT_LIST_MAX) {
      return res.status(413).json({ error: "Batch too large" })
    }
    const ua = parseUA(req.headers["user-agent"] || "")
    /**
     * callback
     * @param {*} event
     */
    const analyticsEvents = events.map((event) => JSON.stringify(toClientEvent(event, ua)))
    await appendClientEvents(analyticsEvents)
    return res.status(200).json({ success: true, processed: analyticsEvents.length })
  } catch (err) {
    console.error("Batch analytics error:", err)
    return res.status(500).json({ error: "Failed to process batch analytics events" })
  }
}

// ponytail: collapse identifier-ish segments so a per-day page counter cannot
// explode on /session/{id} style routes (Firestore docs have a 1MB field budget).
const ID_SEGMENT = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{16,})$/i
const normalizePagePath = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null
  const path = value.split("?")[0]
    .split("/")
    .map((segment) => (segment.length > 24 || ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/")
    .slice(0, 120)
  return path || "/"
}

/**
 * One drain pass: pop a bounded slice, write facts + counters, commit, trim.
 *
 * Separate from the caller so the run can repeat it — see DRAIN_CHUNKS_PER_RUN.
 *
 * @return {Promise<number>} How many events this pass drained.
 */
/**
 * drainOneChunk
 */
async function drainOneChunk(): Promise<number> {
  // RPOP, not LPOP: the producer LPUSHes, so the oldest entries sit at the tail.
  // Measured 2026-09-14: the list sat at 3634 with a 2026-05-06 head and a
  // 2025-11-30 tail — months of backlog the LPOP drain could never reach because
  // it kept consuming the newest end.
  const pending = await redis.rpop<string[]>(ANALYTICS_EVENTS_KEY, CLIENT_EVENT_MAX)
  if (!pending || !pending.length) return 0

  const batch = db.batch()
  const counters: Record<string, Record<string, number>> = {}
  // Mirrored into the hour bucket: the 30m/1h/24h ranges merge `clientEvents` and
  // `byPage` out of `metrics_hourly`, which the daily-only drain never wrote.
  const hourly: Record<string, Record<string, number>> = {}

  for (const entry of pending) {
    const parsed = (typeof entry === "string" ? JSON.parse(entry) : entry) as AnalyticsEvent
    // Allow-list, not free-form: an off-list name minted a permanent counter key
    // (`clientEvents.<typo>`) that no panel reads, so a typo was invisible from both
    // ends. Off-list events are still stored as facts for audit but count as `unknown`,
    // which keeps the rollup keys bounded.
    const name = normalizeClientAnalyticsEvent(parsed.eventType)
    if (name === UNKNOWN_CLIENT_ANALYTICS_EVENT && parsed.eventType) {
      console.warn(`analytics: client event "${String(parsed.eventType).slice(0, 60)}" is not on the allow-list`)
    }
    const event = buildAnalyticsEvent({
      name,
      ts: new Date(Number(parsed.timestamp) || Date.now()),
      uid: parsed.userId,
      guestId: parsed.guestId,
      isBot: parsed.isBot,
      botKind: parsed.botKind,
      props: sanitizeMetadata(parsed.metadata),
    })
    batch.set(db.collection(ANALYTICS_EVENTS).doc(), event)

    const day = counters[event.date] || (counters[event.date] = {})
    // Stale-backlog guard: `metrics_hourly` keeps 7 days, and the list can hold
    // months of entries, so draining into an expired hour would only create docs
    // for the pruner to delete.
    const backlogged = event.ts.getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000
    const hourKey = toEventHour(event.ts)
    const hour = backlogged ? null : hourly[hourKey] || (hourly[hourKey] = {})
    const bump = (key: string) => {
      day[key] = (day[key] || 0) + 1
      if (hour) hour[key] = (hour[key] || 0) + 1
    }
    // ponytail: bots are kept as facts but excluded from every counter — the same
    // rule as the funnel, so pageviews and client-event counts stay human.
    if (event.isBot) continue

    bump(`clientEvents.${event.name}`)

    const page = normalizePagePath(event.props.page ?? event.props.path)
    if (page) {
      bump(`byPage.${page.replace(/\./g, "_")}`)
    }
  }

  for (const [date, keys] of Object.entries(counters)) {
    batch.set(db.doc(`metrics_daily/${date}`), Object.fromEntries(
      Object.entries(keys).map(([key, count]) => [key, FieldValue.increment(count)]),
    ), { merge: true })
  }

  for (const [hourKey, keys] of Object.entries(hourly)) {
    batch.set(db.doc(`metrics_hourly/${hourKey}`), Object.fromEntries(
      Object.entries(keys).map(([key, count]) => [key, FieldValue.increment(count)]),
    ), { merge: true })
  }

  await batch.commit()
  // Safety cap: keep the newest CLIENT_EVENT_LIST_MAX entries if the drain falls behind.
  await redis.ltrim(ANALYTICS_EVENTS_KEY, 0, CLIENT_EVENT_LIST_MAX - 1)
  return pending.length
}

/**
 * Drain the client-event list into the `analytics_events` fact table.
 * Runs from the existing 30-minute scheduled function — no extra cloud function.
 *
 * ponytail: atomic `RPOP key count` instead of read-then-trim — a concurrent push
 * would shift the list and re-drain (duplicate) the same events.
 */
/**
 * drainClientAnalyticsEvents
 */
export async function drainClientAnalyticsEvents(): Promise<number> {
  // A no-op client answers every command successfully, so the only reliable
  // signal is whether this process was handed credentials at all. Without this
  // guard a missing secret binding is indistinguishable from an empty queue.
  if (!isRedisEnabled) {
    console.warn(
      "drainClientAnalyticsEvents skipped: Upstash Redis disabled in this " +
      "process - FUNCTIONS_ENV_JSON is not bound to the calling function.",
    )
    return 0
  }

  let drained = 0
  try {
    // Measured 2026-09-14: the queue sat at 4.6k of its 5k cap — ~11 hours of backlog
    // at one chunk per 30 minutes — while the oldest entries were already being
    // trimmed away. Several chunks per run clear it without a second scheduled
    // function. Chunk 1 failing still reports what earlier chunks committed.
    for (let chunk = 0; chunk < DRAIN_CHUNKS_PER_RUN; chunk++) {
      const count = await drainOneChunk()
      if (!count) break
      drained += count
    }
  } catch (error) {
    console.warn("drainClientAnalyticsEvents failed:", error)
  }

  if (drained) {
    console.log(`✅ Drained ${drained} client analytics events`)
  }
  return drained
}

/**
 * getClientIps
 * @param {*} req
 */
async function getClientIps(req: Request): Promise<{ ipv4: string | null, ipv6: string | null, raw: string | null }> {
  // const raw = req.headers["x-forwarded-for"] || req.connection.remoteAddress || null

  let rawIp = getClientIp(req) || ""

  // Normalize IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (rawIp.startsWith("::ffff:")) {
    rawIp = rawIp.substring(7)
  }

  let ipv4 = null
  let ipv6 = null

  if (net.isIPv4(rawIp)) {
    ipv4 = rawIp
  } else if (net.isIPv6(rawIp)) {
    // Special case: localhost "::1" → treat as IPv6
    ipv6 = rawIp
  }
  // console.log("Detected IPs - IPv4:", ipv4, "IPv6:", ipv6, "Raw:", raw)
  return { ipv4, ipv6, raw: rawIp }
}

