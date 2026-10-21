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
import {isAccountDeleted} from "./account-tombstone"
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
 * @return {string} The rate-limit key. Anonymous callers are ALWAYS metered now.
 */
export const resolveCallableLimitKey = (request: CallableLike): string | null => {
  const uid = request.auth?.uid
  if (uid) return callableRateLimitKey(uid)

  const raw = request.rawRequest
  const forwarded = raw?.headers?.["x-forwarded-for"]
  const forwardedValue = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || ""
  // The LAST entry, not the first. The header is a chain and a TRUSTED proxy
  // APPENDS the address it saw, so everything to the left of that came from the
  // caller. Reading index 0 therefore read a caller-supplied string, and a
  // rotating `X-Forwarded-For: 1.2.3.<random>` minted a fresh bucket per
  // request -- which is the same as having no limiter on the anonymous callables.
  const entries = forwardedValue.split(",")
  const clientIp = (entries[entries.length - 1] || "").trim()
  const ip = (clientIp || raw?.ip || raw?.socket?.remoteAddress || "").trim()

  // No loopback exemption, deliberately. This used to return null -- "skip
  // metering" -- for 127.0.0.1 and friends, and because the source above was
  // attacker-controlled a caller could simply CLAIM loopback to get an unlimited
  // budget on `recordGuestPresence` and the WebAuthn options callable. A caller
  // whose address cannot be derived now shares one `unknown` bucket instead,
  // which is the bounded direction.
  return callableRateLimitKey(`ip:${ip || "unknown"}`)
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

    // Deleted-account gate. Lives here rather than in each handler because this wrapper
    // is the single choke point every callable already routes through — the aliasing at
    // the import site means ~65 call sites cannot forget it. Without it, disabling the
    // Auth record only stops the *next* token: an ID token minted a minute earlier keeps
    // full access to every callable for up to an hour, which is where the expensive
    // paths live (billing, sessions, account administration).
    if (request.auth?.uid && await isAccountDeleted(request.auth.uid)) {
      throw new HttpsError(
        "permission-denied",
        "This account has been closed. Contact support if you believe this is a mistake.",
      )
    }

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
