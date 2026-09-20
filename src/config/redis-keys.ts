/**
 * Redis namespace, TTL and cap constants shared by the Express API (`api/`) and
 * the Cloud Functions package (`functions/`).
 *
 * Why this file exists: every Redis key was previously built from an inline
 * template literal at its call site, so no single place answered "what lives in
 * Redis, and how long does it survive?". Two keys (`guestfp:*` and
 * `analytics:events`) ended up with no expiry at all and grew without bound.
 * Every new key MUST be declared here so TTL coverage stays auditable.
 *
 * This module is intentionally dependency-free so it can be imported from the
 * Angular/API tsconfig graph and the Cloud Functions tsconfig graph alike.
 *
 * TTL policy:
 * - `null` means "no expiry" and is only allowed for keys that are explicitly
 *   bounded by another mechanism (a hard cap, a trim, or a periodic delete).
 *   No key should rely on "it will probably be overwritten".
 */

/** Coarse prefix shared by every key, so ops can SCAN a namespace in one pass. */
export const REDIS_NAMESPACE = 'deepscrape'

// ---------------------------------------------------------------------------
// Sessions and revocation
// ---------------------------------------------------------------------------

export const SESSION_PREFIX = 'session:'
export const REVOKED_PREFIX = 'revoked:'
export const SIGNED_OUT_PREFIX = 'signed-out:'
export const AUTH_SESSION_REVOKED_PREFIX = 'auth:session:revoked:'

/** TTL for the cached session document. Refreshed on every validated read. */
export const SESSION_CACHE_TTL_SECONDS = 30 * 60

/** TTL for a revocation tombstone. Outliving the session TTL prevents resurrection. */
export const REVOCATION_TTL_SECONDS = 30 * 24 * 60 * 60

/** TTL for the sign-out tombstone consumed by the session-status read path. */
export const SIGNED_OUT_TTL_SECONDS = 24 * 60 * 60

/** TTL for the legacy `login_history_Info`-derived revocation tombstone. */
export const LEGACY_REVOCATION_TTL_SECONDS = 30 * 24 * 60 * 60

// ---------------------------------------------------------------------------
// Presence (sorted sets, scored by epoch ms)
// ---------------------------------------------------------------------------

export const ONLINE_USERS_KEY = 'online:users'
export const ONLINE_GUESTS_KEY = 'online:guests'
export const PRESENCE_USER_PREFIX = 'user:'
export const PRESENCE_GUEST_PREFIX = 'guest:'

/** Liveness window for a presence key. Must exceed the client heartbeat interval. */
export const PRESENCE_TTL_SECONDS = 60 * 60

/** Trailing window used to trim stale members from the presence sorted sets. */
export const PRESENCE_WINDOW_MS = 5 * 60 * 1000

export const PRESENCE_WINDOWS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000] as const

// ---------------------------------------------------------------------------
// Guests and geo intelligence
// ---------------------------------------------------------------------------

export const GUEST_FINGERPRINT_PREFIX = 'guestfp:'

/**
 * TTL for the fingerprint -> guestId mapping. Bounded rather than permanent:
 * without it every new IP/UA pair minted a key that never expired.
 * Chosen to match the one-year guest cookie's practical lifetime (a guest who
 * has not returned in 30 days is not worth a permanent mapping).
 */
export const GUEST_FINGERPRINT_TTL_SECONDS = 30 * 24 * 60 * 60

/** Minimum interval between Firestore `lastSeen` writes for a guest. */
export const GUEST_LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000

/**
 * IP -> guestId index. Consulted only when a visitor arrives with neither a
 * `gid` cookie nor a known fingerprint.
 *
 * Why: the fingerprint is (IP, UA family, OS family, device family), so a
 * cookie-less client whose user agent drifts -- a crawler rotating UA, or a
 * cleared cookie plus a browser update -- minted a brand new `guests/` document
 * on each visit from an IP already seen. This index lets the existing guest
 * absorb the new fingerprint, which is what makes the guest count a *visitor*
 * count rather than a document count.
 *
 * 24h and sliding: refreshed whenever the identity is touched, never on a plain
 * page view. Deliberately not longer -- an IP is a shared bucket, so a long TTL
 * would merge genuinely different cookie-less visitors behind one NAT address.
 * Only cookie-less traffic reads it, so a real visitor's identity still comes
 * from their cookie.
 */
export const GUEST_IP_PREFIX = 'guestip:'
export const GUEST_IP_TTL_SECONDS = 24 * 60 * 60

export const GEO_CACHE_PREFIX = 'ipintel:v2:'

/**
 * TTL for a successfully resolved IP intelligence payload.
 *
 * 24h, up from 6h: guests sharing an IP outlive a 6h cache, so the same address
 * was re-resolved up to four times a day. Not longer, because `country` from this
 * payload feeds the country deny-list in `handlers/upstash-limiter.ts` -- a stale
 * country is a stale security decision, while geo/ASN for one IP is otherwise
 * stable for months.
 */
export const GEO_CACHE_TTL_SECONDS = 60 * 60 * 24

/**
 * TTL for a cached *failure*. Shorter than the success TTL on purpose: a
 * provider outage should be retried sooner than a legitimate negative result.
 */
export const GEO_CACHE_FAILURE_TTL_SECONDS = 60 * 5

// ---------------------------------------------------------------------------
// Client analytics ingress
// ---------------------------------------------------------------------------

export const ANALYTICS_EVENTS_KEY = 'analytics:events'

/** Events popped per drain run (one drain runs from the scheduled function). */
export const CLIENT_EVENT_MAX = 200
/**
 * Drain chunks per scheduled run.
 *
 * A Firestore batch is capped at 500 writes, and this drain writes one fact per
 * event plus one counter doc per day — so at 200 events a chunk is already ~201
 * writes and the per-run volume has to grow in *commits*, not in batch size.
 */
export const DRAIN_CHUNKS_PER_RUN = 5

/** Hard ceiling on the ingress list. Enforced at write time and on drain. */
export const CLIENT_EVENT_LIST_MAX = 5000

/** Maximum metadata properties retained per client event. */
export const CLIENT_EVENT_PROP_MAX = 20

// ---------------------------------------------------------------------------
// Verification codes, trusted devices, abuse budgets
// ---------------------------------------------------------------------------

export const VERIFICATION_PREFIX = 'verification:'
export const TRUSTED_DEVICE_PREFIX = 'trusted:'
export const VERIFICATION_RATE_LIMIT_PREFIX = 'rate_verification:'
export const DEVICE_MISMATCH_PREFIX = 'security:device-mismatch:'
export const SESSION_ACCESS_PREFIX = 'session-access:'

/**
 * TTL for a cached role-resolution result. Role resolution costs up to three
 * Firestore reads and runs on every privileged call, so it is cached briefly —
 * but a demotion must bite quickly, hence 60s rather than minutes.
 */
export const SESSION_ACCESS_CACHE_TTL_SECONDS = 60

/**
 * Cached org membership map for an API subject (`uid` -> `{orgId: role}`).
 *
 * Why: `buildSubject` in `infrastructure/authz.middleware.ts` resolved memberships
 * with a Firestore query on *every* authorized request — a billed read even when
 * the query matches nothing, which is the common case (most accounts belong to no
 * org). Memberships change rarely but are read on every privileged call.
 *
 * 60s, the same trade as the session-access cache above: long enough to absorb a
 * burst of requests, short enough that a removed role stops working quickly.
 */
export const MEMBERSHIPS_PREFIX = 'memberships:'
export const MEMBERSHIPS_CACHE_TTL_SECONDS = 60

/** TTL for a verification code, matching the Firestore `expiresAt` it shadows. */
export const VERIFICATION_TTL_SECONDS = 10 * 60

export const TRUSTED_DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60

/** Verification-code request budget per user. */
export const VERIFICATION_RATE_LIMIT_MAX = 3
export const VERIFICATION_RATE_LIMIT_WINDOW_SECONDS = 10 * 60

/** Dedupe window for device-mismatch audit rows. */
export const DEVICE_MISMATCH_DEDUPE_TTL_SECONDS = 10 * 60

/**
 * Per-user, per-category budget for outbound security notifications
 * (email + push), counted in a fixed window.
 *
 * Why a budget at all: sign-in alerts fan out to a paid email provider. A user
 * bouncing between two countries on a flaky VPN would otherwise mint one email
 * per login. The in-app alert is written unconditionally — only the outbound
 * channels are rate limited, so nothing is ever lost from the bell.
 */
export const ALERT_NOTIFY_PREFIX = 'alert-notify:'
export const ALERT_NOTIFY_MAX_PER_WINDOW = 1
export const ALERT_NOTIFY_WINDOW_SECONDS = 6 * 60 * 60

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export const RATE_LIMIT_PREFIX = 'rateLimit:'
export const API_RATE_LIMIT_PREFIX = 'apiRateLimit:'
export const AUTH_RATE_LIMIT_PREFIX = 'authRateLimit'
export const EVENT_RATE_LIMIT_PREFIX = 'eventRateLimit'
export const FUNCTIONS_RATE_LIMIT_PREFIX = 'functionsRateLimit'

/**
 * Budget policy for the two request limiters — the Express middleware in
 * `functions/src/handlers/upstash-limiter.ts` and the Elysia handlers in
 * `bff/limiter.ts`.
 *
 * Why here: the BFF limiter was a copy of the Functions one (same multipliers,
 * same windows, same caps, its own header said "ported from"), so every policy
 * change had to be made twice and the two runtimes would silently drift into
 * throttling the same account differently. One definition, both consumers.
 *
 * The prefix constants above are live Redis namespaces: changing one orphans
 * every bucket already counting against it, so they are read, never rebuilt.
 */

/** Multiplies the base function budget. Longest / most specific role wins. */
export const RATE_LIMIT_TIER_MULTIPLIERS = {
  free: 1,
  pro: 3,
  enterprise: 8,
  admin: 20,
} as const

export type RateLimitTier = keyof typeof RATE_LIMIT_TIER_MULTIPLIERS

/**
 * Normalize a `role` claim to a tier key, defaulting to `free`.
 * @param {unknown} role The authenticated user's role claim.
 * @return {RateLimitTier} One of RATE_LIMIT_TIER_MULTIPLIERS' keys.
 */
export const resolveRateLimitTier = (role: unknown): RateLimitTier => {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : ''
  if (normalized.includes('admin')) return 'admin'
  if (normalized.includes('enterprise')) return 'enterprise'
  if (normalized.includes('pro')) return 'pro'
  return 'free'
}

/** Sliding window per limiter. Production: 15 min. Development: 1 min. */
export const rateLimitWindow = (isProduction: boolean): '15 m' | '1 m' =>
  isProduction ? '15 m' : '1 m'

/**
 * Base cap per window, before the tier multiplier.
 * Production: 100 requests. Development: 50.
 */
export const rateLimitFunctionMax = (
  tier: RateLimitTier,
  isProduction: boolean,
): number =>
  Math.max(
    1,
    Math.floor(
      (isProduction ? 100 : 50) * RATE_LIMIT_TIER_MULTIPLIERS[tier],
    ),
  )

/** Tighter and tier-independent: blunts credential stuffing and enumeration. */
export const rateLimitAuthMax = (isProduction: boolean): number =>
  isProduction ? 10 : 50

/** Higher cap, and the only limiter that runs without deny-list protection. */
export const rateLimitEventMax = (isProduction: boolean): number =>
  isProduction ? 100 : 50

/** Health checks must never be throttled — they gate deploys and uptime probes. */
export const RATE_LIMIT_SKIP_PATHS: readonly string[] = ['/health', '/ping', '/']

// ---------------------------------------------------------------------------
// Key builders — the only sanctioned way to construct a key
// ---------------------------------------------------------------------------

export const sessionKey = (sessionId: string): string => `${SESSION_PREFIX}${sessionId}`
export const revokedKey = (loginId: string): string => `${REVOKED_PREFIX}${loginId}`
export const signedOutKey = (loginId: string): string => `${SIGNED_OUT_PREFIX}${loginId}`
export const legacyRevokedKey = (userId: string, loginId: string): string =>
  `${AUTH_SESSION_REVOKED_PREFIX}${userId}:${loginId}`

export const presenceUserKey = (userId: string): string => `${PRESENCE_USER_PREFIX}${userId}`
export const presenceGuestKey = (guestId: string): string => `${PRESENCE_GUEST_PREFIX}${guestId}`

export const guestFingerprintKey = (fingerprint: string): string =>
  `${GUEST_FINGERPRINT_PREFIX}${fingerprint}`

export const guestIpKey = (ipDigest: string): string => `${GUEST_IP_PREFIX}${ipDigest}`

export const geoCacheKey = (ipDigest: string): string => `${GEO_CACHE_PREFIX}${ipDigest}`

export const verificationKey = (userId: string, method: string): string =>
  `${VERIFICATION_PREFIX}${userId}:${method}`

export const trustedDeviceKey = (userId: string, deviceId: string): string =>
  `${TRUSTED_DEVICE_PREFIX}${userId}:${deviceId}`

export const verificationRateLimitKey = (userId: string): string =>
  `${VERIFICATION_RATE_LIMIT_PREFIX}${userId}`

/**
 * Budget for *wrong guesses* at a verification code, separate from the
 * send-code budget above. Deliberately a different counter: sharing one key
 * would let three typos also starve the user's ability to request a new code.
 * Incremented atomically by `FIXED_WINDOW_INCREMENT`.
 */
export const verificationAttemptKey = (userId: string): string =>
  `verificationAttempts:${userId}`

/**
 * Per-UID budget for callable invocations (all of them, one counter).
 *
 * The Express limiters never see an `onCall`, so callables were unbounded per
 * account. Deliberately generous: callables are user-initiated actions — the
 * heartbeats and analytics pings go to the `/event` Express routes, not here —
 * so a real client sits far below this. The point is to cap a loop.
 */
export const CALLABLE_RATE_LIMIT_MAX = 60
export const CALLABLE_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * Budget for invocations with no verified uid, bucketed by client IP.
 *
 * Higher than the per-uid budget because an IP is a *shared* bucket: a corporate NAT
 * with a few hundred guest tabs heartbeating once a minute must not be throttled,
 * while a single abusive caller still goes from unbounded to bounded.
 */
export const CALLABLE_RATE_LIMIT_MAX_ANONYMOUS = 300

export const callableRateLimitKey = (uid: string): string =>
  `callableRateLimit:${uid}`

export const sessionAccessKey = (uid: string): string =>
  `${SESSION_ACCESS_PREFIX}${uid}`

export const membershipsKey = (uid: string): string => `${MEMBERSHIPS_PREFIX}${uid}`

export const deviceMismatchKey = (loginId: string, fingerprint: string): string =>
  `${DEVICE_MISMATCH_PREFIX}${loginId}:${fingerprint}`

export const functionsRateLimitKey = (tier: string): string =>
  `${FUNCTIONS_RATE_LIMIT_PREFIX}:${tier}`

export const alertNotifyKey = (userId: string, category: string): string =>
  `${ALERT_NOTIFY_PREFIX}${userId}:${category}`
