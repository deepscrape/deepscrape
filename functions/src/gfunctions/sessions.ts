/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto"
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { HttpsError } from "firebase-functions/v2/https"
// ponytail: session/device-trust/OTP callables now metered per UID. Aliased — no call
// site changes. Callables are user-initiated (the 60s heartbeat and analytics pings
// go to the /event Express routes), so 60/min sits far above real traffic.
import { guardedOnCall as onCall } from "../infrastructure/callable-limiter"
import { Timestamp } from "firebase-admin/firestore"
import { Resend } from "resend"
import { db, dbName, auth as adminAuth } from "../app/config"
import { env, functionsEnvJson } from "../config/env"
import { parseCachedJson, redis, redisEval } from "../app/cacheConfig"
import {
  FIXED_WINDOW_INCREMENT,
  MERGE_SESSION_CACHE,
  READ_SESSION_WITH_TTL_REFRESH,
} from "../../../src/config/redis-scripts"
import {
  REVOCATION_TTL_SECONDS,
  SESSION_ACCESS_CACHE_TTL_SECONDS,
  SESSION_CACHE_TTL_SECONDS,
  SIGNED_OUT_TTL_SECONDS,
  TRUSTED_DEVICE_TTL_SECONDS,
  VERIFICATION_RATE_LIMIT_MAX,
  VERIFICATION_RATE_LIMIT_WINDOW_SECONDS,
  VERIFICATION_TTL_SECONDS,
  revokedKey,
  sessionAccessKey,
  sessionKey,
  signedOutKey,
  trustedDeviceKey,
  verificationAttemptKey,
  verificationKey,
  verificationRateLimitKey,
} from "../../../src/config/redis-keys"
import { GeoLookupRequestContext, lookupGeoByIp, normalizeGeoLookupRoles, normalizePublicIp } from "./analytics"
import { emitGeoDimensions, type GeoDimensionSource } from "./analytics-realtime"
import { NON_ROUTABLE_GEO_LABEL, isNonRoutableIp } from "../domain/analytics-helpers"
import { detectNewLoginLocation } from "../domain/notifications/login-alerts"
import { validateCallableData } from "../infrastructure/validate"
import { z } from "zod"

const DATABASE_NAME = dbName || "easyscrape"

type ResolvedSessionGeo = {
  ip: string
  location: string
  region: string
  country: string
  latitude: number | null
  longitude: number | null
  timezone: string
  asn: string | null
  as: string | null
  isp: string | null
  domain: string | null
  usageType: string | null
  proxy: {
    isProxy: boolean
    proxyType: string | null
    threat: string | null
    lastSeenDays: number | null
    provider: string | null
    fraudScore: number | null
    confidence: "none" | "open-proxy-detected" | "unknown"
  }
}

type SessionGeoEnrichmentStatus = "pending" | "resolved" | "no-match" | "skipped"
type GuestGeoEnrichmentStatus = "pending" | "resolved" | "no-match" | "skipped"

// Firestore caps a batch at 500 writes and each revoke writes 5 documents
// (4 session records + its audit entry), so 80 revokes per commit.
const REVOKES_PER_BATCH = 80

/**
 * Merge a patch into the cached session payload.
 *
 * The merge itself now happens inside Redis (`MERGE_SESSION_CACHE`) rather than
 * as a `get` in Node followed by a `setex`. Two reasons: the old shape paid two
 * round-trips on a path that runs on every session mutation, and it re-created
 * an expired key from whatever the caller was holding.
 *
 * @param {string} sessionId - Session whose cache entry is patched.
 * @param {Record<string, unknown>} patch - Fields to merge into the payload.
 * @return {Promise<void>} Resolves once the merge has been issued.
 */
/**
 * updateSessionRedisCache
 * @param {*} sessionId
 * @param {*} patch
 */
async function updateSessionRedisCache(sessionId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    await redisEval<string | null>(
      MERGE_SESSION_CACHE,
      [sessionKey(sessionId)],
      [JSON.stringify(patch), SESSION_CACHE_TTL_SECONDS],
    )
  } catch (error) {
    if (error instanceof HttpsError) throw error
    console.warn(`Failed to update Redis session cache for ${sessionId}:`, error)
  }
}

type MfaPreferredMethod = "totp" | "sms" | "email"

type MfaSecurityPreferences = {
  primaryMethod: MfaPreferredMethod
  secondaryMethod: MfaPreferredMethod | null
  riskEmailNotifications: boolean
  updatedAt: string
}

type AvailableMfaMethods = {
  totp: boolean
  sms: boolean
  email: boolean
}

type MfaDisabledNotificationEvaluation = {
  shouldNotify: boolean
  reason: "notify" | "mfa_still_enabled" | "risk_email_notifications_disabled" | "missing_email"
}

export const getDefaultPrimaryMethod = (available: AvailableMfaMethods): MfaPreferredMethod => {
  if (available.totp) return "totp"
  if (available.sms) return "sms"
  return "email"
}

export const getDefaultSecondaryMethod = (
  available: AvailableMfaMethods,
  primary: MfaPreferredMethod,
): MfaPreferredMethod | null => {
  if (primary !== "sms" && available.sms) return "sms"
  if (primary !== "email" && available.email) return "email"
  if (primary !== "totp" && available.totp) return "totp"
  return null
}

export const isMethodAvailable = (available: AvailableMfaMethods, method: MfaPreferredMethod): boolean => {
  if (method === "totp") return available.totp
  if (method === "sms") return available.sms
  return available.email
}

export const normalizePreferredMethod = (
  value: unknown,
  fallback: MfaPreferredMethod,
): MfaPreferredMethod => {
  const normalized = String(value || "").trim().toLowerCase()
  if (normalized === "totp" || normalized === "sms" || normalized === "email") {
    return normalized
  }
  return fallback
}

export const readMfaPreferences = (
  userData: Record<string, unknown> | undefined,
  available: AvailableMfaMethods,
): MfaSecurityPreferences => {
  const securitySettings = (
    (userData?.settings as { security?: { mfa?: Partial<MfaSecurityPreferences> } })?.security?.mfa || {}
  ) as Partial<MfaSecurityPreferences>

  const defaultPrimary = getDefaultPrimaryMethod(available)
  const primaryCandidate = normalizePreferredMethod(securitySettings.primaryMethod, defaultPrimary)
  const primaryMethod = isMethodAvailable(available, primaryCandidate) ? primaryCandidate : defaultPrimary

  const secondaryCandidate = securitySettings.secondaryMethod ?
    normalizePreferredMethod(securitySettings.secondaryMethod, primaryMethod) : null
  const secondaryMethod = secondaryCandidate && secondaryCandidate !== primaryMethod &&
    isMethodAvailable(available, secondaryCandidate) ? secondaryCandidate :
    getDefaultSecondaryMethod(available, primaryMethod)

  return {
    primaryMethod,
    secondaryMethod,
    riskEmailNotifications: securitySettings.riskEmailNotifications !== false,
    updatedAt: typeof securitySettings.updatedAt === "string" ? securitySettings.updatedAt : new Date().toISOString(),
  }
}

export const resolveAvailableMfaMethods = (
  userRecord: { email?: string | null; phoneNumber?: string | null; multiFactor?: { enrolledFactors?: Array<{ factorId?: string | null }> } },
): AvailableMfaMethods => {
  const enrolledFactors = userRecord.multiFactor?.enrolledFactors || []
  const hasTotpFactor = enrolledFactors.some((factor) => factor.factorId === "totp")
  const hasPhoneFactor = enrolledFactors.some((factor) => factor.factorId === "phone")

  return {
    totp: hasTotpFactor,
    sms: hasPhoneFactor || (typeof userRecord.phoneNumber === "string" && userRecord.phoneNumber.length > 0),
    email: typeof userRecord.email === "string" && userRecord.email.length > 0,
  }
}

export const evaluateMfaDisabledNotification = (args: {
  hasEnrolledMfa: boolean
  riskEmailNotifications: boolean
  hasEmail: boolean
}): MfaDisabledNotificationEvaluation => {
  if (args.hasEnrolledMfa) {
    return { shouldNotify: false, reason: "mfa_still_enabled" }
  }

  if (!args.riskEmailNotifications) {
    return { shouldNotify: false, reason: "risk_email_notifications_disabled" }
  }

  if (!args.hasEmail) {
    return { shouldNotify: false, reason: "missing_email" }
  }

  return { shouldNotify: true, reason: "notify" }
}

const buildMfaDisabledEmailHtml = (): string => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MFA disabled</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:480px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding:32px 32px 8px 32px;text-align:center;">
              <div style="width:48px;height:48px;background-color:#dc2626;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
                <span style="color:#fff;font-size:24px;line-height:48px;">\u26A0\uFE0F</span>
              </div>
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#111318;letter-spacing:-0.3px;">Security alert</h1>
              <p style="margin:8px 0 0 0;font-size:14px;color:#5f6b7a;line-height:1.5;">
                Multi-factor authentication was disabled on your account.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 24px 32px;">
              <div style="background:#fef2f2;border-radius:12px;padding:16px;border:1px solid #fecaca;">
                <p style="margin:0;font-size:14px;color:#991b1b;line-height:1.5;">
                  Your account is now at higher risk. Re-enable an authenticator app (recommended) or SMS/Text message in Security settings as soon as possible.
                </p>
              </div>
              <hr style="border:none;border-top:1px solid #e9edf2;margin:16px 0;">
              <p style="margin:0;font-size:12px;color:#8a95a6;text-align:center;">
                If you didn't make this change, secure your account immediately and contact support.
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:12px 0 0 0;font-size:11px;color:#b0b8c4;text-align:center;">
          Deepscrape \u2022 Security notice
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

const buildVerificationEmailHtml = (code: string, expiresInMin = 10): string => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification code</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:480px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding:32px 32px 8px 32px;text-align:center;">
              <div style="width:48px;height:48px;background-color:#0891b2;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
                <span style="color:#fff;font-size:24px;line-height:48px;">\u{1F512}</span>
              </div>
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#111318;letter-spacing:-0.3px;">Verify your sign-in</h1>
              <p style="margin:8px 0 0 0;font-size:14px;color:#5f6b7a;line-height:1.5;">
                Enter this code to complete the verification step.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;text-align:center;">
              <div style="background:#f0f4f8;border-radius:12px;padding:20px 16px;letter-spacing:8px;font-size:36px;font-weight:800;color:#0891b2;font-family:ui-monospace,'SF Mono',Monaco,monospace;">
                ${code}
              </div>
              <p style="margin:16px 0 0 0;font-size:13px;color:#8a95a6;">This code expires in ${expiresInMin} minutes.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;">
              <hr style="border:none;border-top:1px solid #e9edf2;margin:0 0 16px 0;">
              <p style="margin:0;font-size:12px;color:#8a95a6;text-align:center;">
                If you didn't request this code, someone else may be trying to access your account.
                <br>Please secure your account or contact support.
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:12px 0 0 0;font-size:11px;color:#b0b8c4;text-align:center;">
          Deepscrape \u2022 Security notice
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

const sendSecurityNoticeEmail = async (args: {
  to: string
  subject: string
  text: string
  html?: string
}): Promise<void> => {
  const resendApiKey = env.RESEND_API_KEY
  const resendFromEmail = env.RESEND_FROM_EMAIL || "security@deepscrape.dev"
  if (!resendApiKey) {
    throw new Error("RESEND_API_KEY is not configured")
  }

  const resend = new Resend(resendApiKey)
  await resend.emails.send({
    from: resendFromEmail,
    to: args.to,
    subject: args.subject,
    text: args.text,
    html: args.html,
  })
}

const writeSecurityAuditAndTimeline = async (args: {
  userId: string
  action: string
  eventType: string
  message: string
  metadata?: Record<string, unknown>
}): Promise<void> => {
  const now = Timestamp.now()

  await Promise.all([
    db.collection("audit_logs").add({
      action: args.action,
      admin_uid: args.userId,
      target_userId: args.userId,
      reason: args.message,
      timestamp: now,
      isAdmin: false,
      metadata: args.metadata || {},
    }),
    db
      .collection("login_metrics")
      .doc(args.userId)
      .collection("login_history_events")
      .doc()
      .set({
        uid: args.userId,
        eventType: args.eventType,
        providerId: "security",
        browser: "",
        os: "",
        userAgent: "",
        ipAddress: "",
        location: "",
        connected: false,
        createdAt: now,
        metadata: {
          message: args.message,
          ...(args.metadata || {}),
        },
      }),
  ])
}

/**
 * getRequestIp
 * @param {*} request
 * @return {*}
 */
function getRequestIp(request: unknown): string {
  const rawRequest = (request as { rawRequest?: { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } })?.rawRequest
  const forwarded = rawRequest?.headers?.["x-forwarded-for"]
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded

  return normalizePublicIp(forwardedValue || rawRequest?.ip || rawRequest?.socket?.remoteAddress || "")
}

/**
 * resolveSessionGeo
 * @param {*} request
 * @param {*} fallbackIp
 */
async function resolveSessionGeo(request: unknown, fallbackIp: string): Promise<ResolvedSessionGeo> {
  const requestIp = getRequestIp(request)
  const normalizedFallbackIp = normalizePublicIp(fallbackIp)
  const lookupIp = requestIp || normalizedFallbackIp

  const fallback: ResolvedSessionGeo = {
    ip: lookupIp || "0.0.0.0",
    location: "Unknown",
    region: "Unknown",
    country: "Unknown",
    latitude: null,
    longitude: null,
    timezone: "UTC",
    asn: null,
    as: null,
    isp: null,
    domain: null,
    usageType: null,
    proxy: {
      isProxy: false,
      proxyType: null,
      threat: null,
      lastSeenDays: null,
      provider: null,
      fraudScore: null,
      confidence: "unknown",
    },
  }

  if (!lookupIp) {
    return fallback
  }

  const normalizedLookupIp = lookupIp.trim().toLowerCase()
  if (
    normalizedLookupIp === "0.0.0.0" ||
    normalizedLookupIp === "::" ||
    normalizedLookupIp === "::1" ||
    normalizedLookupIp === "127.0.0.1" ||
    normalizedLookupIp === "localhost"
  ) {
    return fallback
  }

  return {
    ...fallback,
    ip: lookupIp,
  }
}

/**
 * shouldSkipGeoEnrichment
 * @param {*} ipInput
 * @return {*}
 */
function shouldSkipGeoEnrichment(ipInput: string | null | undefined): boolean {
  // The five literals this compared against covered loopback and nothing else, so a
  // reserved or private address still reached the provider and came back as "no-match":
  // the same terminal state as a lookup that genuinely found nothing. Sharing the
  // guest-indexing predicate is what keeps "we did not ask" distinguishable from
  // "nobody knows", which is the difference the panel needs.
  return isNonRoutableIp(normalizePublicIp(ipInput))
}

/**
 * resolveGeoLookupUserRoles
 * @param {*} userId
 * @param {*} token
 */
async function resolveGeoLookupUserRoles(userId: string, token?: Record<string, unknown>): Promise<string[]> {
  const roleValues: unknown[] = []

  const collectRoleValues = (...values: unknown[]): void => {
    roleValues.push(...values)
  }

  if (token) {
    collectRoleValues(token.role, token.roles)

    const firebase = token.firebase
    if (firebase && typeof firebase === "object") {
      const firebaseClaims = firebase as Record<string, unknown>
      collectRoleValues(firebaseClaims.role, firebaseClaims.roles)
    }

    const customClaims = token.customClaims
    if (customClaims && typeof customClaims === "object") {
      const claimValues = customClaims as Record<string, unknown>
      collectRoleValues(claimValues.role, claimValues.roles)
    }
  }

  // One wave instead of a 3-deep waterfall. Each source keeps its own error isolation.
  const collectSafely = async (label: string, load: () => Promise<void>): Promise<void> => {
    try {
      await load()
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.warn(`${label} for ${userId}:`, error)
    }
  }

  await Promise.all([
    /**
     * Failed to read auth claims for geo lookup roles
     */
    /**
     * Failed to read auth claims for geo lookup roles
     */
    collectSafely("Failed to read auth claims for geo lookup roles", async () => {
      const authUser = await adminAuth.getUser(userId)
      const claims = (authUser.customClaims || {}) as Record<string, unknown>
      collectRoleValues(claims.role, claims.roles)
    }),
    /**
     * Failed to read user document roles for geo lookup
     */
    /**
     * Failed to read user document roles for geo lookup
     */
    collectSafely("Failed to read user document roles for geo lookup", async () => {
      const userDoc = await db.collection("users").doc(userId).get()
      if (userDoc.exists) {
        const userData = userDoc.data() as Record<string, unknown>
        collectRoleValues(userData.role, userData.roles)
      }
    }),
    /**
     * Failed to read membership roles for geo lookup
     */
    /**
     * Failed to read membership roles for geo lookup
     */
    collectSafely("Failed to read membership roles for geo lookup", async () => {
      const memberships = await db.collection("memberships").where("userId", "==", userId).limit(100).get()
      for (const membershipDoc of memberships.docs) {
        const membership = membershipDoc.data() as { role?: unknown }
        collectRoleValues(membership.role)
      }
    }),
  ])

  const resolvedRoles = normalizeGeoLookupRoles(...roleValues)
  return resolvedRoles.length > 0 ? resolvedRoles : ["guest"]
}

/**
 * enrichSessionGeoIntelligence
 * @param {*} args
 */
async function enrichSessionGeoIntelligence(args: {
  sessionId: string
  userId: string
  ipAddress: string
  authToken?: Record<string, unknown>
  requestId?: string
  forwardedFor?: string
}): Promise<void> {
  const normalizedIp = normalizePublicIp(args.ipAddress)
  const enrichmentTimestamp = Timestamp.now()
  const intelligenceUpdatedAtIso = enrichmentTimestamp.toDate().toISOString()

  const sessionRef = db.collection("loginSessions").doc(args.sessionId)
  const userSessionRef = db.doc(`users/${args.userId}`).collection("sessions").doc(args.sessionId)

  if (shouldSkipGeoEnrichment(normalizedIp)) {
    const skipPatch = {
      intelligenceSourceIp: normalizedIp || null,
      intelligenceUpdatedAt: enrichmentTimestamp,
      intelligenceStatus: "skipped" as SessionGeoEnrichmentStatus,
    }

    await Promise.all([
      sessionRef.set(skipPatch, { merge: true }),
      userSessionRef.set({
        ...skipPatch,
        syncedAt: enrichmentTimestamp,
      }, { merge: true }),
      updateSessionRedisCache(args.sessionId, {
        intelligenceSourceIp: normalizedIp || null,
        intelligenceUpdatedAt: intelligenceUpdatedAtIso,
        intelligenceStatus: "skipped",
      }),
    ])
    return
  }

  const lookupContext: GeoLookupRequestContext = {
    firebaseUid: args.userId,
    userRoles: await resolveGeoLookupUserRoles(args.userId, args.authToken),
    requestId: args.requestId || `session-geo-${args.sessionId}`,
    forwardedFor: args.forwardedFor || normalizedIp,
  }

  const geoData = await lookupGeoByIp(normalizedIp, lookupContext)
  if (!geoData) {
    const noMatchPatch = {
      intelligenceSourceIp: normalizedIp,
      intelligenceUpdatedAt: enrichmentTimestamp,
      intelligenceStatus: "no-match" as SessionGeoEnrichmentStatus,
    }

    await Promise.all([
      sessionRef.set(noMatchPatch, { merge: true }),
      userSessionRef.set({
        ...noMatchPatch,
        syncedAt: enrichmentTimestamp,
      }, { merge: true }),
      updateSessionRedisCache(args.sessionId, {
        intelligenceSourceIp: normalizedIp,
        intelligenceUpdatedAt: intelligenceUpdatedAtIso,
        intelligenceStatus: "no-match",
      }),
    ])
    return
  }

  const intelligencePatch = {
    ipAddress: geoData.ip,
    location: geoData.city || "Unknown",
    region: geoData.region || "Unknown",
    country: geoData.countryLong || "Unknown",
    latitude: geoData.latitude,
    longitude: geoData.longitude,
    timezone: geoData.timeZone || "UTC",
    asn: geoData.asn,
    asName: geoData.as,
    isp: geoData.isp,
    domain: geoData.domain,
    usageType: geoData.usageType,
    proxy: geoData.proxy,
    intelligenceSourceIp: normalizedIp,
    intelligenceUpdatedAt: enrichmentTimestamp,
    intelligenceStatus: "resolved" as SessionGeoEnrichmentStatus,
  }

  await Promise.all([
    sessionRef.set(intelligencePatch, { merge: true }),
    userSessionRef.set({
      ...intelligencePatch,
      syncedAt: enrichmentTimestamp,
    }, { merge: true }),
    updateSessionRedisCache(args.sessionId, {
      ipAddress: geoData.ip,
      location: geoData.city || "Unknown",
      region: geoData.region || "Unknown",
      country: geoData.countryLong || "Unknown",
      latitude: geoData.latitude,
      longitude: geoData.longitude,
      timezone: geoData.timeZone || "UTC",
      asn: geoData.asn,
      asName: geoData.as,
      isp: geoData.isp,
      domain: geoData.domain,
      usageType: geoData.usageType,
      proxy: geoData.proxy,
      intelligenceSourceIp: normalizedIp,
      intelligenceUpdatedAt: intelligenceUpdatedAtIso,
      intelligenceStatus: "resolved",
    }),
  ])
}

/**
 * Enterprise login session management with device tracking,
 * revocation handling, and Redis caching for performance.
 */

/**
 * Cloud Function: Create a new login session (called after user auth success)
 * Atomically creates Firestore doc + Redis cache entry
 */
export const createLoginSession = onCall(
  {
    cors: true,
    // ponytail: not enforced — client App Check init is fail-open, and this is the login path.
    // Enforce once app.config.ts fails loud instead of returning null.
    region: "us-central1",
    memory: "256MiB",
    secrets: [functionsEnvJson],
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const data = validateCallableData(
      z.object({
        userId: z.string().min(1).max(128),
        deviceId: z.string().min(1).max(256),
        metrics: z.object({
          ip: z.string().max(64).default(""),
          userAgent: z.string().max(512).optional().default(""),
          browser: z.string().max(128).optional().default(""),
          os: z.string().max(128).optional().default(""),
          location: z.string().max(256).optional().default("Unknown"),
          providerId: z.string().max(64).optional().default(""),
        }),
      }),
      request.data
    )
    const { userId, deviceId, metrics } = data

    const auth = request.auth
    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    if (auth.uid !== userId) {
      throw new HttpsError("permission-denied", "Cannot act on another user's data")
    }

    try {
      const now = new Date()
      const resolvedGeo = await resolveSessionGeo(request, metrics.ip)
      const resolvedLocation = metrics.location && metrics.location !== "Unknown" ? metrics.location : resolvedGeo.location
      const resolvedIp = resolvedGeo.ip || metrics.ip || "0.0.0.0"
      // ponytail: UA only — same contract as computeDeviceFingerprint in
      // handlers/home_handler.ts. Storing this geo-resolved IP next to a heartbeat that
      // compares against the socket IP made the check fail for honest users (dual-stack,
      // mobile handover, proxy hops). IP movement is alerted by detectNewLoginLocation.
      const deviceFingerprint = metrics.userAgent || ""
      const sessionId = `${userId}-${deviceId}-${Date.now()}-${randomUUID()}`

      // Security: warn when this login comes from a country the user has never used.
      // Awaited (not fire-and-forget) because Cloud Functions can reclaim background
      // work after the response; the helper swallows its own errors, so a failure to
      // *warn* can never become a failure to *log in*.
      await detectNewLoginLocation({
        uid: userId,
        sessionId,
        ip: resolvedIp,
        country: resolvedGeo.country,
        region: resolvedGeo.region,
        location: resolvedLocation,
        userAgent: metrics.userAgent,
      })

      // Create session record
      const sessionData = {
        sessionId,
        userId,
        deviceId,
        createdAt: Timestamp.now(),
        lastActivityAt: Timestamp.now(),
        revokedAt: null,
        active: true,
        ipAddress: resolvedIp,
        userAgent: metrics.userAgent,
        browser: metrics.browser,
        os: metrics.os,
        location: resolvedLocation,
        deviceFingerprint,
        region: resolvedGeo.region,
        country: resolvedGeo.country,
        latitude: resolvedGeo.latitude,
        longitude: resolvedGeo.longitude,
        timezone: resolvedGeo.timezone,
        asn: resolvedGeo.asn,
        asName: resolvedGeo.as,
        isp: resolvedGeo.isp,
        domain: resolvedGeo.domain,
        usageType: resolvedGeo.usageType,
        proxy: resolvedGeo.proxy,
        intelligenceStatus: "pending" as SessionGeoEnrichmentStatus,
        intelligenceSourceIp: resolvedIp,
        providerId: metrics.providerId,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), // 30 days
      }

      // Write to Firestore in batch with login_metrics for backwards compat
      const batch = db.batch()
      const sessionRef = db.collection("loginSessions").doc(sessionId)
      batch.set(sessionRef, sessionData)

      // Also add to user's sessionSubcollection for easy querying
      const userSessionRef = db.doc(`users/${userId}`).collection("sessions").doc(sessionId)
      batch.set(userSessionRef, {
        ...sessionData,
        syncedAt: Timestamp.now(),
      })

      await batch.commit()

      // Cache in Redis (fast path for heartbeat validation)
      await redis.setex(sessionKey(sessionId), SESSION_CACHE_TTL_SECONDS, JSON.stringify({
        ...sessionData,
        createdAt: sessionData.createdAt.toDate().toISOString(),
        lastActivityAt: sessionData.lastActivityAt.toDate().toISOString(),
        expiresAt: sessionData.expiresAt.toISOString(),
      }))

      console.log(`✅ Session ${sessionId} created for user ${userId}`)

      return {
        success: true,
        sessionId,
        expiresAt: sessionData.expiresAt.toISOString(),
        resolvedMetrics: {
          ip: resolvedIp,
          location: resolvedLocation,
          region: resolvedGeo.region,
          country: resolvedGeo.country,
          latitude: resolvedGeo.latitude,
          longitude: resolvedGeo.longitude,
          timezone: resolvedGeo.timezone,
        },
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error creating login session:", error)
      throw new Error("Failed to create session")
    }
  },
)

/**
 * Cloud Function: Revoke a login session (called from security tab)
 */
export const revokeMyLoginSession = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { loginId, reason } = validateCallableData(z.object({ loginId: z.string().min(1).max(128), reason: z.string().max(256).optional() }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "Unauthorized: You must be authenticated to revoke sessions")
    }

    if (!loginId) {
      throw new HttpsError("invalid-argument", "Missing required field: loginId")
    }

    try {
      const actorAccess = await resolveActorSessionAccess(auth)
      const result = await performSessionRevoke(
        auth.uid,
        loginId,
        reason,
        false,
        actorAccess.canManageSessions,
        actorAccess.role,
        false,
      )

      console.log(`✅ Session ${loginId} revoked for user ${result.targetUserId}`)

      return {
        success: true,
        loginId,
        revokedAt: result.revokedAt.toDate().toISOString(),
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error revoking session:", error)
      throw new Error("Failed to revoke session")
    }
  })

/**
 * performSessionRevoke
 * @param {*} actorUid
 * @param {*} loginId
 * @param {*} reason
 * @param {*} requireAdmin
 * @param {*} actorCanManageSessions
 * @param {*} actorRole
 * @param {*} allowCrossUserRevoke
 * @param {*} collector
 */
async function performSessionRevoke(
  actorUid: string,
  loginId: string,
  reason: string | undefined,
  requireAdmin: boolean,
  actorCanManageSessions = false,
  actorRole: "admin" | "manager" | "owner" | "superadmin" | "elevated" | "user" = "user",
  allowCrossUserRevoke = true,
  // Bulk callers pass the batch/pipeline to share (one commit + one Redis round-trip
  // for many sessions) plus the query-snapshot data, which removes the per-session read.
  collector?: {
    batch: ReturnType<typeof db.batch>
    pipeline: ReturnType<typeof redis.pipeline>
    sessionData?: Record<string, unknown>
  },
) {
  const revokedAt = Timestamp.now()

  const sessionData = collector?.sessionData ??
    (await db.collection("loginSessions").doc(loginId).get()).data()
  if (!sessionData) {
    throw new HttpsError("not-found", "Session not found")
  }

  const targetUserId = String(sessionData?.userId || "").trim()
  if (!targetUserId) {
    throw new HttpsError("internal", "Session record is invalid")
  }

  const isAdmin = actorRole === "admin"
  const isPrivileged = actorCanManageSessions

  if (requireAdmin && !isPrivileged) {
    throw new HttpsError("permission-denied", "Unauthorized: Elevated role required")
  }

  const isCrossUserRequest = targetUserId !== actorUid
  if (isCrossUserRequest && !allowCrossUserRevoke) {
    throw new HttpsError("permission-denied", "Unauthorized: You can only revoke your own sessions")
  }

  if (!isPrivileged && isCrossUserRequest) {
    throw new HttpsError("permission-denied", "Unauthorized: You can only revoke your own sessions")
  }

  const revokeReason = reason || (isPrivileged ? "privileged_initiated_revoke" : "user_initiated_revoke")

  const batch = collector?.batch ?? db.batch()
  const sessionRef = db.collection("loginSessions").doc(loginId)
  batch.update(sessionRef, {
    revokedAt,
    active: false,
    revokedBy: actorUid,
    revokedByRole: actorRole,
    revokeReason,
  })

  const userSessionRef = db.doc(`users/${targetUserId}`).collection("sessions").doc(loginId)
  batch.set(userSessionRef, {
    revokedAt,
    active: false,
    syncedAt: Timestamp.now(),
  }, {merge: true})

  const legacyRef = db.doc(`login_metrics/${targetUserId}/login_history_Info/${loginId}`)
  batch.set(legacyRef, {
    connected: false,
    revokedAt,
    revokedByUid: actorUid,
  }, {merge: true})

  const loginHistoryEventRef = db
    .collection("login_metrics")
    .doc(targetUserId)
    .collection("login_history_events")
    .doc()
  batch.set(loginHistoryEventRef, {
    uid: targetUserId,
    eventType: "revoke",
    eventSessionId: loginId,
    providerId: sessionData?.providerId || "firebase",
    browser: sessionData?.browser || "",
    os: sessionData?.os || "",
    userAgent: sessionData?.userAgent || "",
    ipAddress: sessionData?.ipAddress || "",
    location: sessionData?.location || "",
    connected: false,
    revokedAt,
    revokedByUid: actorUid,
    createdAt: revokedAt,
  })

  // The audit record joins the same batch: one round-trip instead of a separate
  // `.add()` per session, and the revoke + its audit now land atomically.
  batch.set(db.collection("audit_logs").doc(), {
    action: isPrivileged ? "privileged_revoke_session" : "user_revoke_session",
    admin_uid: actorUid,
    target_loginId: loginId,
    target_userId: targetUserId,
    reason: revokeReason,
    timestamp: Timestamp.now(),
    isAdmin,
    actorRole,
  })

  // revoked: flag + session cache drop. A caller-supplied collector owns the pipeline
  // (many sessions → one round-trip); otherwise this revocation gets its own.
  const revokePipeline = collector?.pipeline ?? redis.pipeline()
  revokePipeline.setex(revokedKey(loginId), REVOCATION_TTL_SECONDS, JSON.stringify({
    revokedAt: revokedAt.toDate().toISOString(),
    userId: targetUserId,
  }))
  revokePipeline.del(sessionKey(loginId))

  // Commit Firestore before flushing the cache flags, same order as before.
  if (!collector) {
    await batch.commit()
    await revokePipeline.exec()
  }

  return {
    revokedAt,
    targetUserId,
    isAdmin,
    isPrivileged,
    actorRole,
  }
}

const collectRoleValues = (value: unknown, collector: string[]): void => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized.length > 0) {
      collector.push(normalized)
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRoleValues(item, collector)
    }
  }
}

const isManagerLikeRole = (role: string): boolean => {
  return role.includes("manager") || role.endsWith("_mgr") || role.endsWith("-mgr")
}

const resolveHighestSessionRole = (roles: string[]): "admin" | "superadmin" | "owner" | "manager" | "elevated" | "user" => {
  if (roles.includes("admin") || roles.includes("platform_admin") || roles.includes("platform-admin")) {
    return "admin"
  }

  if (roles.includes("superadmin") || roles.includes("super_admin") || roles.includes("super-admin")) {
    return "superadmin"
  }

  if (roles.includes("owner")) {
    return "owner"
  }

  if (roles.some((role) => isManagerLikeRole(role))) {
    return "manager"
  }

  if (roles.some((role) => role === "lead" || role === "staff" || role === "operator")) {
    return "elevated"
  }

  return "user"
}

const isBootstrapAdminEmail = (email?: string | null): boolean => {
  if (!email) {
    return false
  }

  const normalizedEmail = email.trim().toLowerCase()
  return env.ADMIN_EMAILS.some((adminEmail) => adminEmail === normalizedEmail)
}

const resolveActorSessionAccess = async (
  auth: { uid: string; token?: Record<string, unknown> },
): Promise<{
  canManageSessions: boolean
  role: "admin" | "manager" | "owner" | "superadmin" | "elevated" | "user"
}> => {
  // This ran 3 sequential reads on every privileged call, uncached.
  // ponytail: 60s of role staleness. Lower the TTL if a demotion must bite faster.
  const accessCacheKey = sessionAccessKey(auth.uid)
  const cachedAccess = await redis.get<{
    canManageSessions: boolean
    role: "admin" | "manager" | "owner" | "superadmin" | "elevated" | "user"
  }>(accessCacheKey)
  if (cachedAccess && typeof cachedAccess === "object") {
    return cachedAccess
  }

  const collectedRoles: string[] = []

  if (auth.token) {
    collectRoleValues(auth.token.role, collectedRoles)
    collectRoleValues(auth.token.roles, collectedRoles)

    const firebase = auth.token.firebase
    if (firebase && typeof firebase === "object") {
      const firebaseClaims = firebase as Record<string, unknown>
      collectRoleValues(firebaseClaims.role, collectedRoles)
      collectRoleValues(firebaseClaims.roles, collectedRoles)
    }

    const customClaims = auth.token.customClaims
    if (customClaims && typeof customClaims === "object") {
      const claimValues = customClaims as Record<string, unknown>
      collectRoleValues(claimValues.role, collectedRoles)
      collectRoleValues(claimValues.roles, collectedRoles)
    }
  }

  // Three independent reads — one wave instead of a 3-deep waterfall. Each source keeps
  // its own error isolation, so one failure doesn't sink the others.
  const [userDoc, memberships, authUser] = await Promise.all([
    db.collection("users").doc(auth.uid).get(),
    db.collection("memberships").where("userId", "==", auth.uid).limit(100).get()
      .catch((error) => {
        if (error instanceof HttpsError) throw error
        console.warn(`Failed to read memberships while resolving session access for ${auth.uid}:`, error)
        return null
      }),
    adminAuth.getUser(auth.uid)
      .catch(() => null),
  ])

  if (userDoc.exists) {
    const userData = userDoc.data() as Record<string, unknown>
    collectRoleValues(userData.role, collectedRoles)
    collectRoleValues(userData.roles, collectedRoles)
  }

  for (const membershipDoc of memberships?.docs || []) {
    const membership = membershipDoc.data() as { role?: unknown }
    collectRoleValues(membership.role, collectedRoles)
  }

  if (authUser) {
    const claims = (authUser.customClaims || {}) as Record<string, unknown>
    collectRoleValues(claims.role, collectedRoles)
    collectRoleValues(claims.roles, collectedRoles)

    if (isBootstrapAdminEmail(authUser.email)) {
      collectedRoles.push("admin")
    }
  }

  const resolvedRole = resolveHighestSessionRole(collectedRoles)
  const access = {
    canManageSessions: resolvedRole !== "user",
    role: resolvedRole,
  }
  await redis.setex(accessCacheKey, SESSION_ACCESS_CACHE_TTL_SECONDS, JSON.stringify(access))
  return access
}

export const revokeUserLoginSessionByAdmin = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  async (request) => {
    const { loginId, reason } = validateCallableData(z.object({ loginId: z.string().min(1).max(128), reason: z.string().max(256).optional() }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "Unauthorized: You must be authenticated")
    }

    if (!loginId) {
      throw new HttpsError("invalid-argument", "Missing required field: loginId")
    }

    try {
      const actorAccess = await resolveActorSessionAccess(auth)
      const result = await performSessionRevoke(
        auth.uid,
        loginId,
        reason,
        true,
        actorAccess.canManageSessions,
        actorAccess.role,
      )

      console.log(`✅ Admin ${auth.uid} revoked session ${loginId} for user ${result.targetUserId}`)

      return {
        success: true,
        loginId,
        targetUserId: result.targetUserId,
        revokedAt: result.revokedAt.toDate().toISOString(),
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error in admin session revoke:", error)
      throw new Error("Failed to revoke user session")
    }
  },
)

export const revokeAllUserSessionsByAdmin = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  async (request) => {
    const {
      targetUserId,
      reason,
      limit,
    } = validateCallableData(z.object({
      targetUserId: z.string().min(1).max(128),
      reason: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "Unauthorized: You must be authenticated")
    }

    const normalizedTargetUserId = String(targetUserId || "").trim()
    if (!normalizedTargetUserId) {
      throw new HttpsError("invalid-argument", "Missing required field: targetUserId")
    }

    const actorAccess = await resolveActorSessionAccess(auth)
    if (!actorAccess.canManageSessions) {
      throw new HttpsError("permission-denied", "Unauthorized: Elevated role required")
    }

    const queryLimit = Math.max(1, Math.min(200, Number(limit) || 100))

    try {
      const snapshot = await db
        .collection("loginSessions")
        .where("userId", "==", normalizedTargetUserId)
        .where("active", "==", true)
        .limit(queryLimit)
        .get()

      const revokedSessionIds: string[] = []

      // One batch + one Redis pipeline per chunk instead of per session. A 200-session
      // revoke was ~1400 sequential round-trips; this makes it 3 commits + 3 pipelines.
      for (let i = 0; i < snapshot.docs.length; i += REVOKES_PER_BATCH) {
        const chunk = snapshot.docs.slice(i, i + REVOKES_PER_BATCH)
        const batch = db.batch()
        const pipeline = redis.pipeline()

        for (const sessionDoc of chunk) {
          await performSessionRevoke(
            auth.uid,
            sessionDoc.id,
            reason || "admin_bulk_revoke",
            true,
            actorAccess.canManageSessions,
            actorAccess.role,
            true,
            { batch, pipeline, sessionData: sessionDoc.data() },
          )
          revokedSessionIds.push(sessionDoc.id)
        }

        // Firestore first, then the cache flags — same order as the single-revoke path.
        await batch.commit()
        await pipeline.exec()
      }

      return {
        success: true,
        targetUserId: normalizedTargetUserId,
        revokedCount: revokedSessionIds.length,
        sessionIds: revokedSessionIds,
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error in admin bulk session revoke:", error)
      throw new Error("Failed to revoke user sessions")
    }
  },
)

/**
 * performSessionSignOut
 * @param {*} userId
 * @param {*} loginId
 * @param {*} signOutReason
 */
async function performSessionSignOut(userId: string, loginId: string, signOutReason: string) {
  const signedOutAt = Timestamp.now()

  const sessionRef = db.collection("loginSessions").doc(loginId)
  const sessionDoc = await sessionRef.get()

  if (!sessionDoc.exists) {
    throw new HttpsError("not-found", "Session not found")
  }

  const sessionData = sessionDoc.data()
  if (sessionData?.userId !== userId) {
    throw new HttpsError("permission-denied", "Unauthorized: Can only sign out own sessions")
  }

  const batch = db.batch()

  batch.set(sessionRef, {
    active: false,
    signedOutAt,
    signOutReason,
  }, {merge: true})

  const userSessionRef = db.doc(`users/${userId}`).collection("sessions").doc(loginId)
  batch.set(userSessionRef, {
    active: false,
    signedOutAt,
    syncedAt: Timestamp.now(),
  }, {merge: true})

  const legacyRef = db.doc(`login_metrics/${userId}/login_history_Info/${loginId}`)
  batch.set(legacyRef, {
    connected: false,
    signOutTime: signedOutAt,
  }, {merge: true})

  const loginHistoryEventRef = db
    .collection("login_metrics")
    .doc(userId)
    .collection("login_history_events")
    .doc()
  batch.set(loginHistoryEventRef, {
    uid: userId,
    eventType: "logout",
    eventSessionId: loginId,
    providerId: sessionData?.providerId || "firebase",
    browser: sessionData?.browser || "",
    os: sessionData?.os || "",
    userAgent: sessionData?.userAgent || "",
    ipAddress: sessionData?.ipAddress || "",
    location: sessionData?.location || "",
    connected: false,
    signOutTime: signedOutAt,
    createdAt: signedOutAt,
  })

  await batch.commit()

  // One pipeline for the cache invalidation, instead of a `del` round-trip
  // followed by a `setex` round-trip on the logout path.
  const signOutPipeline = redis.pipeline()
  signOutPipeline.del(sessionKey(loginId))
  signOutPipeline.setex(signedOutKey(loginId), SIGNED_OUT_TTL_SECONDS, JSON.stringify({
    signedOutAt: signedOutAt.toDate().toISOString(),
    userId,
  }))
  await signOutPipeline.exec()

  return {
    loginId,
    signedOutAt,
  }
}
/**
       * PHASE 1.2: Cloud Function: Sign out a login session
       * Called when user explicitly logs out (different from forced revocation)
       * Marks session as signed_out and invalidates Redis cache immediately
       */
export const signOutLoginSession = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { loginId } = validateCallableData(z.object({ loginId: z.string().min(1).max(128) }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "Unauthorized: You must be authenticated to sign out")
    }

    if (!loginId) {
      throw new HttpsError("invalid-argument", "Missing required field: loginId")
    }

    try {
      const userId = auth.uid
      const result = await performSessionSignOut(userId, loginId, "user_initiated_logout")

      console.log(`✅ Session ${loginId} signed out for user ${userId}`)

      return {
        success: true,
        loginId,
        signedOutAt: result.signedOutAt.toDate().toISOString(),
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error signing out session:", error)
      throw new Error("Failed to sign out session")
    }
  },
)

/**
       * Cloud Function: Get login session status
       */
export const getMyLoginSessionStatus = onCall(
  {
    cors: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { loginId } = validateCallableData(z.object({ loginId: z.string().min(1).max(128) }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    if (!loginId) {
      throw new HttpsError("invalid-argument", "Missing required field: loginId")
    }

    try {
      const userId = auth.uid

      // Check Redis cache first (fast path)
      const cachedRevoked = await redis.get(`revoked:${loginId}`)
      const revocationData = parseCachedJson<{ revokedAt?: string }>(cachedRevoked)
      if (revocationData) {
        return {
          loginId,
          active: false,
          revoked: true,
          revokedAt: revocationData.revokedAt,
        }
      }

      // Fall back to Firestore
      const sessionDoc = await db.collection("loginSessions").doc(loginId).get()
      if (!sessionDoc.exists) {
        return {
          loginId,
          active: false,
          revoked: true,
          revokedAt: null,
          message: "Session not found",
        }
      }

      const sessionData = sessionDoc.data()

      // Verify ownership
      if (sessionData?.userId !== userId) {
        throw new HttpsError("permission-denied", "Unauthorized: Invalid session for user")
      }

      return {
        loginId,
        active: sessionData?.active === true && !sessionData?.revokedAt,
        revoked: sessionData?.revokedAt !== null,
        revokedAt: sessionData?.revokedAt ? sessionData.revokedAt.toDate().toISOString() : null,
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error getting session status:", error)
      throw new Error("Failed to get session status")
    }
  },
)

/**
       * PHASE 3.2: Cloud Function: Record logout metrics atomically
       * Updates both loginSessions and login_history_Info collections and invalidates Redis
       * Called when user explicitly logs out
       */
export const recordLogoutMetrics = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { loginId } = validateCallableData(z.object({ loginId: z.string().min(1).max(128) }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "Unauthorized: You must be authenticated")
    }

    if (!loginId) {
      throw new HttpsError("invalid-argument", "Missing required field: loginId")
    }

    try {
      const userId = auth.uid
      const result = await performSessionSignOut(userId, loginId, "user_initiated_logout")

      console.log(`✅ Logout metrics recorded for session ${loginId}`)

      return {
        success: true,
        loginId,
        signedOutAt: result.signedOutAt.toDate().toISOString(),
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error recording logout metrics:", error)
      throw new Error("Failed to record logout metrics")
    }
  },
)

/**
       * Cloud Function: Get all active login sessions for the user
       */
export const getMyLoginSessions = onCall(
  {
    cors: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { limit } = validateCallableData(z.object({ limit: z.number().int().min(1).max(200).default(50) }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    try {
      const userId = auth.uid
      const queryLimit = Math.min(limit, 100) // Cap at 100

      // Query from user's sessions subcollection (more efficient)
      const snapshot = await db
        .collection("users")
        .doc(userId)
        .collection("sessions")
        .where("active", "==", true)
        .orderBy("lastActivityAt", "desc")
        .limit(queryLimit)
        .get()

      /**
       * callback
       * @param {*} doc
       */
      const sessions = snapshot.docs.map((doc) => ({
        loginId: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || doc.data().createdAt,
        lastActivityAt: doc.data().lastActivityAt?.toDate?.()?.toISOString?.() || doc.data().lastActivityAt,
        expiresAt: doc.data().expiresAt?.toDate?.()?.toISOString?.() || doc.data().expiresAt,
      }))

      return {
        success: true,
        sessions,
        total: sessions.length,
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error getting login sessions:", error)
      throw new Error("Failed to get sessions")
    }
  },
)

export const getUserLoginSessionsByAdmin = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  async (request) => {
    const {
      targetUserId,
      limit = 50,
      activeOnly = false,
    } = validateCallableData(z.object({
      targetUserId: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(200).default(50),
      activeOnly: z.boolean().default(false),
    }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const actorAccess = await resolveActorSessionAccess(auth)
    if (!actorAccess.canManageSessions) {
      throw new HttpsError("permission-denied", "Unauthorized: Elevated role required")
    }

    const normalizedTargetUserId = String(targetUserId || "").trim()
    if (!normalizedTargetUserId) {
      throw new HttpsError("invalid-argument", "Missing required field: targetUserId")
    }

    try {
      const queryLimit = Math.max(1, Math.min(200, Number(limit) || 50))
      let q = db
        .collection("loginSessions")
        .where("userId", "==", normalizedTargetUserId)

      if (activeOnly) {
        q = q.where("active", "==", true)
      }

      const snapshot = await q
        .orderBy("lastActivityAt", "desc")
        .limit(queryLimit)
        .get()

      const sessions = snapshot.docs.map((doc) => ({
        loginId: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || doc.data().createdAt,
        lastActivityAt: doc.data().lastActivityAt?.toDate?.()?.toISOString?.() || doc.data().lastActivityAt,
        revokedAt: doc.data().revokedAt?.toDate?.()?.toISOString?.() || doc.data().revokedAt,
        expiresAt: doc.data().expiresAt?.toDate?.()?.toISOString?.() || doc.data().expiresAt,
      }))

      return {
        success: true,
        targetUserId: normalizedTargetUserId,
        sessions,
        total: sessions.length,
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error getting target user sessions:", error)
      throw new Error("Failed to get target user sessions")
    }
  },
)

/**
       * Validate session cookie and update activity (called from heartbeat)
       */
export const validateSessionCookie = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { sessionId } = validateCallableData(z.object({ sessionId: z.string().min(1).max(256) }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    if (!sessionId) {
      throw new Error("Missing sessionId")
    }

    try {
      const userId = auth.uid

      // Read + revocation check + TTL refresh in ONE round-trip. This used to be a
      // pipeline read followed by a separate `setex`, i.e. two round-trips on the
      // hottest authenticated path in the app. The `/heartbeat` route shares the
      // same script.
      const [cachedRevoked, cachedSession] = await redisEval<[unknown, string | null]>(
        READ_SESSION_WITH_TTL_REFRESH,
        [sessionKey(sessionId), revokedKey(sessionId)],
        [SESSION_CACHE_TTL_SECONDS],
      )

      if (cachedRevoked) {
        return { valid: false, reason: "revoked" }
      }
      // Upstash auto-deserializes, so this is already an object, not a string.
      const cachedSessionData = parseCachedJson<Record<string, unknown>>(cachedSession)
      if (cachedSessionData) {
        try {
          if (cachedSessionData.userId === userId && cachedSessionData.active) {
            const cachedIntelligenceStatus = String(cachedSessionData.intelligenceStatus || "").trim().toLowerCase()
            const shouldRefreshFromFirestore = cachedIntelligenceStatus === "pending"

            if (shouldRefreshFromFirestore) {
              // Pending intelligence in cache can become stale if geo enrichment completed after session creation.
              // Fall through to Firestore to refresh cache with authoritative values.
            } else {
              // TTL was already refreshed by the script above.
              return { valid: true, cachedHit: true }
            }
          }
        } catch (e) {
          // Fallthrough to Firestore
        }
      }

      // Query Firestore
      const sessionDoc = await db.collection("loginSessions").doc(sessionId).get()
      if (!sessionDoc.exists) {
        return { valid: false, reason: "not_found" }
      }

      const sessionData = sessionDoc.data()
      if (sessionData?.userId !== userId) {
        return { valid: false, reason: "user_mismatch" }
      }

      if (sessionData?.revokedAt) {
        return { valid: false, reason: "revoked" }
      }

      if (sessionData?.active === false) {
        return { valid: false, reason: "inactive" }
      }

      const expiresAt = sessionData?.expiresAt
      if (expiresAt && new Date() > new Date(expiresAt)) {
        return { valid: false, reason: "expired" }
      }

      // Update lastActivityAt + presence (real-time active-user tracking)
      const now = Timestamp.now()
      const batch = db.batch()
      const sessionRef = db.collection("loginSessions").doc(sessionId)
      batch.update(sessionRef, { lastActivityAt: now })

      const userSessionRef = db.doc(`users/${userId}`).collection("sessions").doc(sessionId)
      batch.update(userSessionRef, { lastActivityAt: now, syncedAt: now })

      // Upsert presence doc — used by computeActiveUsersNow to count live users
      const presenceRef = db.collection("presence").doc(userId)
      batch.set(presenceRef, {
        userId,
        sessionId,
        lastSeen: now,
        isUser: true,
      }, { merge: true })

      await batch.commit()

      // Refresh Redis cache
      const refreshedData = {
        ...sessionData,
        lastActivityAt: now.toDate().toISOString(),
      }
      await redis.setex(sessionKey(sessionId), SESSION_CACHE_TTL_SECONDS, JSON.stringify(refreshedData))

      return { valid: true }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error validating session:", error)
      return { valid: false, reason: "server_error" }
    }
  },
)

/**
 * Guest presence heartbeat — called every 60 s by unauthenticated clients.
 * Updates `guests/{guestId}.lastSeen` so computeActiveUsersNow can count them.
 * No auth required (guest users are anonymous).
 */
export const recordGuestPresence = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { guestId } = validateCallableData(z.object({ guestId: z.string().min(1).max(128) }), request.data)

    if (!guestId || typeof guestId !== "string" || guestId.length > 128) {
      throw new Error("Missing or invalid guestId")
    }

    try {
      const guestRef = db.collection("guests").doc(guestId)
      const guestDoc = await guestRef.get()

      // Only update existing guests — never create via this endpoint
      if (!guestDoc.exists) {
        return { updated: false, reason: "not_found" }
      }

      await guestRef.update({ lastSeen: Timestamp.now() })

      return { updated: true }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error recording guest presence:", error)
      throw new Error("Failed to record presence")
    }
  },
)

/**
       * Scheduled function: Clean up expired sessions daily
       * Removes sessions older than 30 days with revokedAt set
       */
export const cleanupExpiredSessions = onSchedule(
  {
    schedule: "every day 02:00",
    timeZone: "UTC",
    region: "us-central1",
  },
  /**
   * callback
   */
  async () => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgoTs = Timestamp.fromDate(thirtyDaysAgo)

      // Find revoked sessions older than 30 days
      const snapshot = await db
        .collection("loginSessions")
        .where("revokedAt", "<", thirtyDaysAgoTs)
        .limit(100)
        .get()

      let deletedCount = 0
      const batch = db.batch()

      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref)
        deletedCount++

        // Also delete from user subcollection
        const userId = doc.data().userId
        const sessionId = doc.id
        const userSessionRef = db.doc(`users/${userId}`).collection("sessions").doc(sessionId)
        batch.delete(userSessionRef)
      })

      if (snapshot.size > 0) {
        await batch.commit()
        console.log(`✅ Cleaned up ${deletedCount} expired sessions`)
      } else {
        console.log("ℹ️ No expired sessions to clean up")
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error cleaning up sessions:", error)
    }
  },
)

/**
           * Trigger: Update session lastActivityAt when new login history is recorded
           * Keeps loginSession in sync with activity
           */
export const onLoginHistoryCreated = onDocumentWritten(
  {
    document: "login_metrics/{userId}/login_history_Info/{loginId}",
    database: DATABASE_NAME,
  },
  /**
   * callback
   * @param {*} event
   */
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()

    // Only process creates (no before data) or updates that set connected: true
    if (before || !after) return

    try {
      const loginId = event.params.loginId

      // Check if corresponding loginSession exists
      const sessionDoc = await db.collection("loginSessions").doc(loginId).get()
      if (sessionDoc.exists) {
        // Update lastActivityAt in loginSession
        await sessionDoc.ref.update({
          lastActivityAt: Timestamp.now(),
        })
      }

      console.log(`ℹ️ Updated session activity for ${loginId}`)
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error updating session activity:", error)
      // Don't throw - let the trigger succeed even if update fails
    }
  },
)

export const enrichLoginSessionGeo = onDocumentWritten(
  {
    document: "loginSessions/{sessionId}",
    database: DATABASE_NAME,
    region: "us-central1",
    memory: "512MiB",
    secrets: [functionsEnvJson],
  },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()

    if (!after) {
      return
    }

    const sessionId = String(event.params.sessionId || "").trim()
    const userId = String(after.userId || "").trim()
    const ipAddress = normalizePublicIp(String(after.ipAddress || ""))
    const currentSourceIp = normalizePublicIp(String(after.intelligenceSourceIp || ""))
    const currentStatus = String(after.intelligenceStatus || "").trim().toLowerCase()

    if (!sessionId || !userId || !ipAddress) {
      return
    }

    const ipChanged = normalizePublicIp(String(before?.ipAddress || "")) !== ipAddress
    const alreadyResolvedForSameIp =
      currentSourceIp === ipAddress &&
      typeof after.intelligenceUpdatedAt !== "undefined" &&
      // ponytail: no-match is terminal too, else every heartbeat (and this trigger's own
      // status write) re-fires geo lookup and self-triggers an infinite loop / spend storm.
      (currentStatus === "resolved" || currentStatus === "skipped" || currentStatus === "no-match")

    if (!ipChanged && alreadyResolvedForSameIp) {
      return
    }

    try {
      await enrichSessionGeoIntelligence({
        sessionId,
        userId,
        ipAddress,
        requestId: `enrich-login-session-geo-${sessionId}`,
        forwardedFor: ipAddress,
      })
      console.log(`✅ Session intelligence enriched for ${sessionId}`)
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error(`❌ Error enriching session intelligence for ${sessionId}:`, error)
    }
  },
)

/**
 * getContinentFromTimezone
 * @param {*} timezone
 * @return {*}
 */
function getContinentFromTimezone(timezone: string): string {
  if (!timezone) return "Unknown"
  if (timezone.startsWith("Europe/")) return "Europe"
  if (timezone.startsWith("Asia/")) return "Asia"
  if (timezone.startsWith("America/")) return "North America"
  if (timezone.startsWith("Africa/")) return "Africa"
  if (timezone.startsWith("Australia/") || timezone.startsWith("Pacific/")) return "Oceania"
  if (timezone.startsWith("Antarctica/")) return "Antarctica"
  return "Unknown"
}

export const enrichGuestGeo = onDocumentWritten(
  {
    document: "guests/{guestId}",
    database: DATABASE_NAME,
    region: "us-central1",
    memory: "256MiB",
    secrets: [functionsEnvJson],
  },
  async (event) => {
    const before = event.data?.before.data() as { ip?: { raw?: string }; intelligenceStatus?: string; intelligenceSourceIp?: string; intelligenceUpdatedAt?: unknown } | undefined
    const after = event.data?.after.data() as (GeoDimensionSource & { ip?: { raw?: string }; intelligenceStatus?: string; intelligenceSourceIp?: string; intelligenceUpdatedAt?: unknown }) | undefined

    if (!after) {
      return
    }

    const guestId = String(event.params.guestId || "").trim()
    const ipAddress = normalizePublicIp(String(after.ip?.raw || ""))
    const currentSourceIp = normalizePublicIp(String(after.intelligenceSourceIp || ""))
    const currentStatus = String(after.intelligenceStatus || "").trim().toLowerCase()

    // `onGuestCreated` counts a guest the moment the document appears, when every geo
    // field is still a placeholder, so the geo dimensions are counted HERE instead.
    // A guest already terminal before this run was counted by its first enrichment:
    // an IP change re-resolves the document but must not count it twice.
    const previousStatus = String(before?.intelligenceStatus || "").trim().toLowerCase()
    const geoAlreadyCounted = ["resolved", "skipped", "no-match"].includes(previousStatus)

    if (!guestId || !ipAddress) {
      return
    }

    const ipChanged = normalizePublicIp(String(before?.ip?.raw || "")) !== ipAddress
    const alreadyResolvedForSameIp =
      currentSourceIp === ipAddress &&
      typeof after.intelligenceUpdatedAt !== "undefined" &&
      // ponytail: no-match is terminal too, else every heartbeat (and this trigger's own
      // status write) re-fires geo lookup and self-triggers an infinite loop / spend storm.
      (currentStatus === "resolved" || currentStatus === "skipped" || currentStatus === "no-match")

    if (!ipChanged && alreadyResolvedForSameIp) {
      return
    }

    const guestRef = db.collection("guests").doc(guestId)
    const enrichmentTimestamp = Timestamp.now()

    // One write per terminal state, and the geo counters ride along with it. The patch
    // is merged over the stored snapshot, so a branch that resolves nothing still counts
    // the guest once instead of dropping it out of the distributions entirely. What it
    // counts as is the point: "Unknown" is what a FAILED resolution leaves behind, and a
    // reserved address must not hide inside it.
    const finishEnrichment = async (patch: Record<string, unknown>): Promise<void> => {
      await guestRef.set(patch, { merge: true })
      if (!geoAlreadyCounted) {
        await emitGeoDimensions({ ...(after as GeoDimensionSource), ...patch } as GeoDimensionSource)
      }
    }

    if (shouldSkipGeoEnrichment(ipAddress)) {
      await finishEnrichment({
        // Own bucket rather than the "Unknown" a failed lookup leaves: the long-range
        // panels rebuild from these document fields and the short-range ones from the
        // counters emitted below, so labelling here covers both.
        country: NON_ROUTABLE_GEO_LABEL,
        region: NON_ROUTABLE_GEO_LABEL,
        location: NON_ROUTABLE_GEO_LABEL,
        intelligenceSourceIp: ipAddress,
        intelligenceUpdatedAt: enrichmentTimestamp,
        intelligenceStatus: "skipped" as GuestGeoEnrichmentStatus,
      })
      return
    }

    try {
      const geoData = await lookupGeoByIp(ipAddress, {
        firebaseUid: `guest:${guestId}`,
        userRoles: ["guest"],
        requestId: `enrich-guest-geo-${guestId}`,
        forwardedFor: ipAddress,
      })
      if (!geoData) {
        await finishEnrichment({
          intelligenceSourceIp: ipAddress,
          intelligenceUpdatedAt: enrichmentTimestamp,
          intelligenceStatus: "no-match" as GuestGeoEnrichmentStatus,
        })
        return
      }

      const timezone = geoData.timeZone || "UTC"
      await finishEnrichment({
        country: geoData.countryLong || "Unknown",
        region: geoData.region || "Unknown",
        location: geoData.city || "Unknown",
        latitude: geoData.latitude ?? 0,
        longitude: geoData.longitude ?? 0,
        timezone,
        geo: {
          continent: getContinentFromTimezone(timezone),
          region: geoData.countryShort || "Unknown",
        },
        network: geoData.network,
        proxy: geoData.proxy,
        intelligenceSourceIp: ipAddress,
        intelligenceUpdatedAt: enrichmentTimestamp,
        intelligenceStatus: "resolved" as GuestGeoEnrichmentStatus,
      })

      console.log(`✅ Guest intelligence enriched for ${guestId}`)
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error(`❌ Error enriching guest intelligence for ${guestId}:`, error)
    }
  },
)

/**
       * PHASE 4.2: Cloud Function: Send device verification code
       * Generates a 6-digit code and sends via email or SMS
       * Code expires in 10 minutes
       */
export const sendDeviceVerificationCode = onCall(
  {
    enforceAppCheck: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { userId, method, sessionId } = validateCallableData(
      z.object({
        userId: z.string().min(1).max(128),
        method: z.enum(["email", "sms", "auto"]),
        sessionId: z.string().max(256).optional(),
      }),
      request.data
    )
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    if (auth.uid !== userId) {
      throw new HttpsError("permission-denied", "Unauthorized: Can only request code for own account")
    }

    if (!userId || !method) {
      throw new HttpsError("invalid-argument", "Missing required fields: userId, method")
    }

    if (!["email", "sms", "auto"].includes(method)) {
      throw new Error("Invalid method: must be 'email', 'sms' or 'auto'")
    }

    // Rate limit: max 3 verification code requests per 10 minutes per user.
    // Atomic increment: the previous `get` + `setex` pair let two concurrent
    // requests both read the same count and both be admitted.
    const [requestCount] = await redisEval<[number, number]>(
      FIXED_WINDOW_INCREMENT,
      [verificationRateLimitKey(userId)],
      [VERIFICATION_RATE_LIMIT_WINDOW_SECONDS],
    )
    if (requestCount > VERIFICATION_RATE_LIMIT_MAX) {
      throw new Error(
        "Too many verification code requests. Please wait before requesting a new code."
      )
    }

    try {
      const userRecord = await adminAuth.getUser(userId)
      const userSnap = await db.doc(`users/${userId}`).get()
      const userData = userSnap.data() as Record<string, unknown> | undefined
      const enrolledFactors = userRecord.multiFactor?.enrolledFactors || []
      /**
       * callback
       * @param {*} factor
       */
      const phoneMfaFactor = enrolledFactors.find((factor) => factor.factorId === "phone")
      const hasMfaEnabled = enrolledFactors.length > 0
      const hasPhoneNumber = typeof userRecord.phoneNumber === "string" && userRecord.phoneNumber.length > 0
      const hasPhoneMfa = !!phoneMfaFactor
      const availableMethods = resolveAvailableMfaMethods(userRecord)
      const preferences = readMfaPreferences(userData, availableMethods)

      const selectedMethod = method === "auto" ?
        preferences.primaryMethod :
        (method === "sms" ? "sms" : "email")

      const effectiveMethod = isMethodAvailable(availableMethods, selectedMethod) ?
        selectedMethod :
        getDefaultPrimaryMethod(availableMethods)

      if (effectiveMethod === "email" && !userRecord.email) {
        throw new Error("No email found on account. Add an email first.")
      }

      if (effectiveMethod === "sms" && !hasPhoneNumber && !hasPhoneMfa) {
        throw new Error("No phone number or phone MFA factor found. Add phone number or enable MFA first.")
      }

      // Generate 6-digit verification code
      const verificationCode = randomInt(100000, 1000000).toString()
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
      const expiresAtTs = Timestamp.fromDate(expiresAt)

      // Store verification attempt in Firestore
      const verificationRef = db.collection("device_verifications").doc()
      const verificationData: Record<string, unknown> = {
        userId,
        code: verificationCode,
        method: effectiveMethod,
        expiresAt: expiresAtTs,
        createdAt: Timestamp.now(),
        verified: false,
        attempts: 0,
      }
      if (sessionId) {
        verificationData.sessionId = sessionId
      }
      await verificationRef.set(verificationData)

      // Store in Redis for fast lookup (expires in 10 minutes)
      const redisData: Record<string, string> = {
        code: verificationCode,
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date().toISOString(),
      }
      if (sessionId) {
        redisData.sessionId = sessionId
      }
      await redis.setex(
        verificationKey(userId, effectiveMethod),
        VERIFICATION_TTL_SECONDS,
        JSON.stringify(redisData),
      )

      let deliveryStatus: "sent" | "pending_client_mfa"
      let deliveryMessage = ""

      if (effectiveMethod === "email") {
        await sendSecurityNoticeEmail({
          to: userRecord.email as string,
          subject: "Your device verification code",
          text: `Your verification code is ${verificationCode}. It expires in 10 minutes.`,
          html: buildVerificationEmailHtml(verificationCode),
        })

        deliveryStatus = "sent"
        deliveryMessage = "Verification code sent via email"
      } else {
        // Firebase Admin SDK cannot directly send SMS OTP.
        // For SMS verification, frontend should use Firebase phone auth / MFA challenge flow.
        deliveryStatus = "pending_client_mfa"
        deliveryMessage = hasPhoneMfa ?
          "Use your enrolled phone MFA challenge to retrieve and verify the code" :
          "Use Firebase phone verification flow for your saved phone number"
      }

      console.log(`✅ Verification code generated for ${userId} via ${method}`)

      return {
        success: true,
        expiresAt: expiresAt.toISOString(),
        message: deliveryMessage,
        method: effectiveMethod,
        deliveryStatus,
        hasPhoneNumber,
        hasMfaEnabled,
        sessionId: sessionId || null,
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error sending verification code:", error)
      throw new Error(
        "Failed to send verification code"
      )
    }
  },
)

export const getMfaSecurityPreferences = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
    secrets: [functionsEnvJson],
  },
  async (request) => {
    const auth = request.auth
    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const userId = auth.uid
    const [userRecord, userSnap] = await Promise.all([
      adminAuth.getUser(userId),
      db.doc(`users/${userId}`).get(),
    ])

    const availableMethods = resolveAvailableMfaMethods(userRecord)
    const userData = userSnap.data() as Record<string, unknown> | undefined
    const preferences = readMfaPreferences(userData, availableMethods)

    return {
      success: true,
      preferences,
      availableMethods,
      hasEnrolledMfa: (userRecord.multiFactor?.enrolledFactors || []).length > 0,
    }
  },
)

export const updateMfaSecurityPreferences = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    region: "us-central1",
    secrets: [functionsEnvJson],
  },
  async (request) => {
    const auth = request.auth
    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const userId = auth.uid
    const { primaryMethod, secondaryMethod, riskEmailNotifications } =
      (request.data || {}) as {
        primaryMethod?: MfaPreferredMethod
        secondaryMethod?: MfaPreferredMethod | null
        riskEmailNotifications?: boolean
      }

    const [userRecord, userSnap] = await Promise.all([
      adminAuth.getUser(userId),
      db.doc(`users/${userId}`).get(),
    ])

    const availableMethods = resolveAvailableMfaMethods(userRecord)
    const userData = userSnap.data() as Record<string, unknown> | undefined
    const existingPreferences = readMfaPreferences(userData, availableMethods)

    const desiredPrimary = normalizePreferredMethod(primaryMethod, existingPreferences.primaryMethod)
    const normalizedPrimary = isMethodAvailable(availableMethods, desiredPrimary) ?
      desiredPrimary : getDefaultPrimaryMethod(availableMethods)

    const desiredSecondary = secondaryMethod ? normalizePreferredMethod(secondaryMethod, normalizedPrimary) : null
    const normalizedSecondary = desiredSecondary && desiredSecondary !== normalizedPrimary &&
      isMethodAvailable(availableMethods, desiredSecondary) ? desiredSecondary :
      getDefaultSecondaryMethod(availableMethods, normalizedPrimary)

    const preferences: MfaSecurityPreferences = {
      primaryMethod: normalizedPrimary,
      secondaryMethod: normalizedSecondary,
      riskEmailNotifications: typeof riskEmailNotifications === "boolean" ?
        riskEmailNotifications : existingPreferences.riskEmailNotifications,
      updatedAt: new Date().toISOString(),
    }

    await db.doc(`users/${userId}`).set({
      settings: {
        security: {
          mfa: preferences,
        },
      },
      updated_At: new Date(),
    }, { merge: true })

    await writeSecurityAuditAndTimeline({
      userId,
      action: "mfa_preferences_updated",
      eventType: "mfa_preference_updated",
      message: "MFA challenge preference was updated",
      metadata: {
        previous: existingPreferences,
        updated: preferences,
        availableMethods,
      },
    })

    return {
      success: true,
      preferences,
      availableMethods,
    }
  },
)

export const notifyMfaRiskEvent = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
    secrets: [functionsEnvJson],
  },
  async (request) => {
    const auth = request.auth
    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const eventType = String((request.data as { eventType?: string })?.eventType || "").trim().toLowerCase()
    if (eventType !== "mfa_disabled") {
      throw new Error("Unsupported event type")
    }

    const userId = auth.uid
    const [userRecord, userSnap] = await Promise.all([
      adminAuth.getUser(userId),
      db.doc(`users/${userId}`).get(),
    ])

    const availableMethods = resolveAvailableMfaMethods(userRecord)
    const userData = userSnap.data() as Record<string, unknown> | undefined
    const preferences = readMfaPreferences(userData, availableMethods)

    const hasEnrolledMfa = (userRecord.multiFactor?.enrolledFactors || []).length > 0
    const evaluation = evaluateMfaDisabledNotification({
      hasEnrolledMfa,
      riskEmailNotifications: preferences.riskEmailNotifications,
      hasEmail: Boolean(userRecord.email),
    })

    if (evaluation.shouldNotify) {
      await sendSecurityNoticeEmail({
        to: userRecord.email as string,
        subject: "Security alert: Multi-factor authentication is disabled",
        text: "Multi-factor authentication was disabled on your account. Your account is now at higher risk. Re-enable an authenticator app (recommended) or SMS/Text message in Security settings as soon as possible.",
        html: buildMfaDisabledEmailHtml(),
      })
    }

    if (!hasEnrolledMfa) {
      await db.collection("users").doc(userId).collection("alerts").add({
        type: "warning",
        // The fan-out trigger sends the push for this; email stays here because it
        // honours the separate `riskEmailNotifications` preference. See
        // alert-presentation.ts for the full reasoning.
        category: "mfa_disabled",
        severity: "warning",
        title: "MFA disabled",
        message: "Your account currently has no enrolled second factor. Re-enable MFA to reduce account takeover risk.",
        createdAt: Timestamp.now(),
        read: false,
        metadata: {
          source: "notifyMfaRiskEvent",
          eventType,
          notificationReason: evaluation.reason,
        },
      })
    }

    await writeSecurityAuditAndTimeline({
      userId,
      action: "mfa_disabled_risk_event",
      eventType: "mfa_disabled",
      message: "MFA disabled risk event processed",
      metadata: {
        eventType,
        hasEnrolledMfa,
        riskEmailNotifications: preferences.riskEmailNotifications,
        notificationReason: evaluation.reason,
        notificationSent: evaluation.shouldNotify,
      },
    })

    if (!evaluation.shouldNotify) {
      return { success: true, skipped: true, reason: evaluation.reason }
    }

    return { success: true }
  },
)

/**
           * PHASE 4.2: Cloud Function: Verify code and trust device
           * Validates the verification code and adds device to trusted list
           */
/**
       * PHASE 4.2: Cloud Function: Verify code and trust device
       * Validates the verification code and adds device to trusted list
       */
export const verifyAndTrustDevice = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { userId, code, deviceId, deviceName, sessionId, mfaVerified } = validateCallableData(
      z.object({
        userId: z.string().min(1).max(128),
        code: z.string().min(1).max(32),
        deviceId: z.string().min(1).max(256),
        deviceName: z.string().max(128).default(""),
        sessionId: z.string().max(256).optional(),
        mfaVerified: z.boolean().optional(),
      }),
      request.data
    )
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    if (auth.uid !== userId) {
      throw new HttpsError("permission-denied", "Unauthorized: Can only verify for own account")
    }

    if (!userId || !code || !deviceId) {
      throw new HttpsError("invalid-argument", "Missing required fields: userId, code, deviceId")
    }

    try {
      // Find the verification attempt
      const snapshot = await db
        .collection("device_verifications")
        .where("userId", "==", userId)
        .where("verified", "==", false)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()

      if (snapshot.empty) {
        throw new Error("No pending verification found")
      }

      const verificationDoc = snapshot.docs[0]
      const verificationData = verificationDoc.data()

      // Check expiration
      if (new Date() > verificationData.expiresAt.toDate()) {
        throw new Error("Verification code expired")
      }

      // If the verification was bound to a session, validate the session matches
      if (verificationData.sessionId && sessionId && verificationData.sessionId !== sessionId) {
        throw new Error("Verification code was generated for a different session. Please request a new code.")
      }

      // If MFA was verified on the client (SMS path), skip code check
      const isMfaVerified = mfaVerified === true && verificationData.method === "sms"

      if (!isMfaVerified) {
        // ponytail: the Firestore attempt counter that used to live here could not
        // work, so the "lock after 5 wrong attempts" was decorative:
        //   * `attempts + 1` is a read-modify-write — N concurrent guesses all read
        //     the same value, so the counter never advances;
        //   * the lock predicate read the PRE-update snapshot, so it tripped on the
        //     6th wrong attempt, not the 5th;
        //   * `verified: false` was already false, so no lock was ever persisted.
        // A 6-digit space (900k) behind a 10-minute TTL with no working counter is
        // an unlimited parallel brute force → trusted_devices/{deviceId}, which is a
        // 90-day reauth bypass. Reuse the atomic fixed-window counter that
        // sendDeviceVerificationCode already uses, on its own budget.
        const [attemptCount] = await redisEval<[number, number]>(
          FIXED_WINDOW_INCREMENT,
          [verificationAttemptKey(userId)],
          [VERIFICATION_RATE_LIMIT_WINDOW_SECONDS],
        )

        // 2x the send budget: room for honest typos, still nowhere near enough
        // parallel guesses to cover a 900k space inside the code's lifetime.
        if (attemptCount > VERIFICATION_RATE_LIMIT_MAX * 2) {
          throw new HttpsError(
            "resource-exhausted",
            "Too many verification attempts. Please request a new code."
          )
        }

        // ponytail: constant-time compare. `!==` short-circuits on the first
        // differing byte, leaking the matching prefix through timing. Length is not
        // secret (the code is fixed at 6 digits) and timingSafeEqual throws when the
        // buffers differ in length, so gate on that first.
        const expectedCode = Buffer.from(String(verificationData.code ?? ""), "utf8")
        const providedCode = Buffer.from(code, "utf8")
        if (
          expectedCode.length !== providedCode.length ||
          !timingSafeEqual(expectedCode, providedCode)
        ) {
          throw new HttpsError("invalid-argument", "Invalid verification code")
        }
      }

      // Mark verification as complete
      await verificationDoc.ref.update({ verified: true })

      // Add device to trusted devices
      const trustedUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // 90 days
      const trustedUntilTs = Timestamp.fromDate(trustedUntil)

      const trustedDeviceRef = db
        .collection("users")
        .doc(userId)
        .collection("trusted_devices")
        .doc(deviceId)

      await Promise.all([
        trustedDeviceRef.set({
          deviceId,
          deviceName: deviceName || "Trusted Device",
          trustedAt: Timestamp.now(),
          trustedUntil: trustedUntilTs,
          lastUsedAt: Timestamp.now(),
          browser: "", // Will be filled by client
          os: "", // Will be filled by client
          location: "",
        }),
        // A trusted device skips device verification for 90 days, so the owner has
        // to learn about it. Written concurrently with the trust record, and its
        // failure is swallowed: a missing notice must never fail a trust grant.
        // Email + push are handled by onSecurityAlertCreated.
        db.collection("users").doc(userId).collection("alerts").add({
          type: "warning",
          category: "new_trusted_device",
          severity: "warning",
          title: "New device trusted",
          message: `${deviceName || "A new device"} was added to your trusted devices. If this wasn't you, remove it and change your password.`,
          createdAt: Timestamp.now(),
          read: false,
          metadata: {
            source: "verifyAndTrustDevice",
            deviceId,
            deviceName: deviceName || "Trusted Device",
            sessionId: sessionId || null,
            trustedUntil: trustedUntil.toISOString(),
          },
        }).catch((error) => {
          console.warn(`Failed to write trusted-device alert for ${userId}:`, error)
        }),
      ])

      // Cache in Redis
      await redis.setex(trustedDeviceKey(userId, deviceId), TRUSTED_DEVICE_TTL_SECONDS, JSON.stringify({
        deviceId,
        trustedAt: new Date().toISOString(),
        trustedUntil: trustedUntil.toISOString(),
      }))

      // Invalidate verification cache — one round-trip for both method keys.
      const invalidatePipeline = redis.pipeline()
      invalidatePipeline.del(verificationKey(userId, "email"))
      invalidatePipeline.del(verificationKey(userId, "sms"))
      await invalidatePipeline.exec()

      console.log(`✅ Device ${deviceId} trusted for user ${userId}`)

      return {
        success: true,
        deviceId,
        trustedUntil: trustedUntil.toISOString(),
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error verifying device:", error)
      throw new Error("Failed to verify device")
    }
  },
)

/**
           * PHASE 4.2: Cloud Function: Check if device is trusted
           */
export const isDeviceTrusted = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { userId, deviceId } = validateCallableData(z.object({ userId: z.string().min(1).max(128), deviceId: z.string().min(1).max(256) }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    if (auth.uid !== userId) {
      throw new HttpsError("permission-denied", "Cannot act on another user's data")
    }

    if (!userId || !deviceId) {
      throw new HttpsError("invalid-argument", "Missing required fields: userId, deviceId")
    }

    try {
      // Check Redis cache first
      const cachedTrust = await redis.get(trustedDeviceKey(userId, deviceId))
      const trustData = parseCachedJson<{ trustedUntil?: string }>(cachedTrust)
      if (trustData && new Date() < new Date(trustData.trustedUntil || 0)) {
        return { trusted: true, cachedHit: true }
      }

      // Query Firestore
      const trustedDeviceDoc = await db
        .collection("users")
        .doc(userId)
        .collection("trusted_devices")
        .doc(deviceId)
        .get()

      if (!trustedDeviceDoc.exists) {
        return { trusted: false }
      }

      const deviceData = trustedDeviceDoc.data()
      if (deviceData?.trustedUntil && new Date() > deviceData.trustedUntil.toDate()) {
        // Trust expired, delete it
        await trustedDeviceDoc.ref.delete()
        return { trusted: false }
      }

      // Update lastUsedAt
      await trustedDeviceDoc.ref.update({ lastUsedAt: Timestamp.now() })

      // Refresh Redis cache
      const trustedUntil = deviceData?.trustedUntil || new Date(Date.now() + TRUSTED_DEVICE_TTL_SECONDS * 1000)
      await redis.setex(trustedDeviceKey(userId, deviceId), TRUSTED_DEVICE_TTL_SECONDS, JSON.stringify({
        deviceId,
        trustedAt: new Date().toISOString(),
        trustedUntil: trustedUntil.toDate?.()?.toISOString?.() || trustedUntil,
      }))

      return { trusted: true }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error checking device trust:", error)
      return { trusted: false, error: "server_error" }
    }
  },
)

/**
           * PHASE 4.2: Cloud Function: Get trusted devices list
           */
export const getTrustedDevices = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    try {
      const userId = auth.uid

      const snapshot = await db
        .collection("users")
        .doc(userId)
        .collection("trusted_devices")
        .where("trustedUntil", ">", Timestamp.now())
        .orderBy("lastUsedAt", "desc")
        .get()

      /**
       * callback
       * @param {*} doc
       */
      const devices = snapshot.docs.map((doc) => ({
        deviceId: doc.id,
        ...doc.data(),
        trustedAt: doc.data().trustedAt?.toDate?.()?.toISOString?.() || doc.data().trustedAt,
        trustedUntil: doc.data().trustedUntil?.toDate?.()?.toISOString?.() || doc.data().trustedUntil,
        lastUsedAt: doc.data().lastUsedAt?.toDate?.()?.toISOString?.() || doc.data().lastUsedAt,
      }))

      return { success: true, devices }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error getting trusted devices:", error)
      throw new Error("Failed to get devices")
    }
  },
)

/**
           * PHASE 4.2: Cloud Function: Remove trusted device
           */
export const removeTrustedDevice = onCall(
  {
    cors: true,
    enforceAppCheck: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { deviceId } = validateCallableData(z.object({ deviceId: z.string().min(1).max(256) }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    if (!deviceId) {
      throw new HttpsError("invalid-argument", "Missing required field: deviceId")
    }

    try {
      const userId = auth.uid

      await db
        .collection("users")
        .doc(userId)
        .collection("trusted_devices")
        .doc(deviceId)
        .delete()

      // Invalidate cache
      await redis.del(trustedDeviceKey(userId, deviceId))

      console.log(`✅ Trusted device ${deviceId} removed for user ${userId}`)

      return { success: true }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      console.error("❌ Error removing trusted device:", error)
      throw new Error("Failed to remove device")
    }
  },
)
