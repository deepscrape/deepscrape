/* eslint-disable max-len */
// Per-UID rate limiting for callable functions.
//
// Why this exists: the limiters in handlers/upstash-limiter.ts are Express
// middleware, so they never see an onCall invocation. Every callable was therefore
// unbounded per account — a single authenticated user could loop createPaymentIntent
// / createCheckoutSession (~25 billing callables in app/stripe.ts), spam the WebAuthn
// ceremonies (each writes a Firestore challenge doc), or hammer session mutations as
// fast as the network allowed.
//
// Reuses the atomic FIXED_WINDOW_INCREMENT Lua counter already used by
// sendDeviceVerificationCode: no new script, no new dependency.
import {HttpsError, onCall as rawOnCall} from "firebase-functions/v2/https"
import {redisEval} from "../app/cacheConfig"
import {FIXED_WINDOW_INCREMENT} from "../../../src/config/redis-scripts"
import {
  CALLABLE_RATE_LIMIT_MAX,
  CALLABLE_RATE_LIMIT_MAX_ANONYMOUS,
  CALLABLE_RATE_LIMIT_WINDOW_SECONDS,
  callableRateLimitKey,
} from "../../../src/config/redis-keys"

/**
 * Whether a wrapped callable requires a valid App Check token.
 *
 * MUST move in lockstep with the client. `app.config.ts` no longer calls
 * `provideAppCheck()` (the App Check client was deleted as dead code), so the browser
 * sends NO App Check token — and firebase-functions answers a missing token with a bare
 * `HttpsError("unauthenticated", "Unauthenticated")` whenever a callable declares
 * `enforceAppCheck: true`:
 *
 *   if (tokenStatus.app === "MISSING" && options.enforceAppCheck) throw ...
 *
 * So that declaration never hardened the handlers, it disabled them. The nine in
 * gfunctions/sessions.ts that set it — session revoke (user + admin + bulk), sign-out,
 * device removal, MFA preferences, and both halves of device verification — returned
 * `{error:{message:"Unauthenticated",status:"UNAUTHENTICATED"}}` for every real user.
 * That is the whole reason a revoke button could never work, and why device
 * verification could prompt but never be completed.
 *
 * Enforcement lives here rather than at the call sites so the two halves can only be
 * flipped together: restore `provideAppCheck()` on the client, then set this to true.
 * Until then the boundary is the verified ID token plus the `auth.uid === userId`
 * ownership check every one of those handlers already performs.
 */
export const APP_CHECK_ENFORCED = false

/**
 * Apply the App Check policy to one callable's declared options.
 *
 * Kept pure and exported so the invariant is testable without mocking the framework:
 * a call site may declare `enforceAppCheck: true`, but the effective value is that AND
 * the global switch. Every other option (`secrets`, `region`, `memory`, `cors`, …)
 * passes through untouched — they are load-bearing, and dropping one silently changes
 * how the function is deployed.
 *
 * @param {Record<string, unknown>} options - Options as declared at the call site.
 * @return {Record<string, unknown>} The options the framework will actually see.
 */
export const applyAppCheckPolicy = (
  options: Record<string, unknown>,
): Record<string, unknown> => ({
  ...options,
  enforceAppCheck: APP_CHECK_ENFORCED && Boolean(options["enforceAppCheck"]),
})

type CallableLike = {
  auth?: {uid?: string} | null
  data?: unknown
  rawRequest?: {
    ip?: string
    socket?: {remoteAddress?: string}
    headers?: Record<string, string | string[] | undefined>
  }
}

/**
 * Bucket key for one invocation, or null when the caller cannot be identified.
 *
 * A verified uid is always the better bucket. Anonymous invocations cannot be keyed
 * that way, and at least one of them is genuinely reachable without auth —
 * `recordGuestPresence` is the guest heartbeat and never rejects an anonymous
 * caller — so falling back to the client IP is what turns "unbounded" into "bounded".
 *
 * The forwarded header is read here rather than via `normalizePublicIp()` in
 * gfunctions/analytics: this module is imported by every callable, and dragging the
 * analytics module into every cold start to save four lines is a bad trade.
 *
 * ponytail: an IP is weak identity — rotation defeats the bucket, and a NAT shares
 * one. This is abuse control, not a security boundary; App Check is the boundary.
 *
 * @param {CallableLike} request Callable request carrying the caller identity.
 * @return {string | null} The rate-limit key, or null to skip metering.
 */
export const resolveCallableLimitKey = (request: CallableLike): string | null => {
  const uid = request.auth?.uid
  if (uid) return callableRateLimitKey(uid)

  const raw = request.rawRequest
  const forwarded = raw?.headers?.["x-forwarded-for"]
  const forwardedValue = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || ""
  // x-forwarded-for is a chain (`client, proxy1, proxy2`); the client is the first
  // entry. Keying on the whole header would bucket every caller behind a shared proxy
  // together and make the key grow with the chain.
  const [clientIp] = forwardedValue.split(",")
  const ip = (clientIp || raw?.ip || raw?.socket?.remoteAddress || "").trim()

  // A loopback or missing address identifies nobody, and pooling every such caller
  // into one bucket would throttle them collectively for no benefit.
  if (!ip || ip === "0.0.0.0" || ip === "::" || ip === "::1" || ip === "127.0.0.1" || ip === "localhost") {
    return null
  }

  return callableRateLimitKey(`ip:${ip}`)
}

/**
 * Fixed-window budget, incremented atomically so N concurrent invocations cannot all
 * read the same count and all be admitted.
 *
 * ponytail: ONE budget per bucket, deliberately generous (see the redis-keys
 * constants). The win is turning "unbounded" into "bounded" — a loop is capped at the
 * budget per window instead of running at network speed. Tighten per callable (money
 * paths first) if abuse actually shows up; a per-callable map is the next rung.
 *
 * Fails OPEN when Redis is unconfigured or erroring, matching
 * handlers/upstash-limiter.ts. This is an abuse control; taking the whole API down
 * because the limiter's backing store blinked is the worse outage.
 *
 * @param {CallableLike} request Callable request; its uid or client IP is the key.
 * @return {Promise<void>} Resolves when within budget, rejects with resource-exhausted when full.
 */
/**
 * enforceCallableRateLimit
 * @param {*} request
 */
export async function enforceCallableRateLimit(request: CallableLike): Promise<void> {
  const key = resolveCallableLimitKey(request)
  if (!key) return

  const max = request.auth?.uid ? CALLABLE_RATE_LIMIT_MAX : CALLABLE_RATE_LIMIT_MAX_ANONYMOUS

  let count: number
  try {
    const [measured] = await redisEval<[number, number]>(
      FIXED_WINDOW_INCREMENT,
      [key],
      [CALLABLE_RATE_LIMIT_WINDOW_SECONDS],
    )
    count = measured
  } catch (error) {
    console.warn("callable rate limit unavailable, allowing request:", error)
    return
  }

  if (count > max) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many requests. Please slow down and try again shortly.",
    )
  }
}

// Drop-in replacement for onCall that enforces the per-UID budget first.
//
// Aliased at the import site — `import {guardedOnCall as onCall} from
// "../infrastructure/callable-limiter"` — so NOT ONE call site changes. Handles both
// overloads: onCall(handler) and onCall(opts, handler).
export const guardedOnCall = ((
  optsOrHandler: unknown,
  maybeHandler?: unknown,
): unknown => {
  // The options form always passes a plain object first; the handler-only form
  // passes a function.
  const hasOptions = typeof optsOrHandler === "object" && optsOrHandler !== null
  const options = hasOptions ? optsOrHandler : undefined
  const handler = (hasOptions ? maybeHandler : optsOrHandler) as (request: CallableLike) => unknown

  const guarded = async (request: CallableLike): Promise<unknown> => {
    await enforceCallableRateLimit(request)
    return handler(request)
  }

  if (options === undefined) {
    return rawOnCall(guarded as never)
  }

  return rawOnCall(
    applyAppCheckPolicy(options as Record<string, unknown>) as never,
    guarded as never,
  )
  // ponytail: the cast is the price of being a transparent drop-in for an overloaded
  // generic. Typing it properly means restating firebase-functions' overloads and
  // re-validating them at ~65 untouched call sites, for no extra safety — tsc still
  // checks every call site against the real signature.
}) as unknown as typeof rawOnCall
