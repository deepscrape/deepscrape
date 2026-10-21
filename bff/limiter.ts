import { Ratelimit } from '@upstash/ratelimit'
import { isRedisEnabled, redis } from '../functions/src/app/cacheConfig'
import {
  AUTH_RATE_LIMIT_PREFIX,
  EVENT_RATE_LIMIT_PREFIX,
  RATE_LIMIT_SKIP_PATHS,
  RATE_LIMIT_TIER_MULTIPLIERS,
  type RateLimitTier,
  functionsRateLimitKey,
  rateLimitAuthMax,
  rateLimitEventMax,
  rateLimitFunctionMax,
  rateLimitWindow,
  resolveRateLimitTier as resolveTier,
} from '../src/config/redis-keys'

/**
 * Rate limiting for the Elysia BFF — same mechanism as
 * `functions/src/handlers/upstash-limiter.ts`, same budget policy.
 *
 * Reuses the function's shared Upstash REST client instead of building a second
 * one: `cacheConfig` already owns the credential handling, including the two
 * guards that exist because of real incidents — `encrypted:` placeholders and
 * the doubled `.upstash.io.upstash.io` hostname.
 *
 * The numbers (tiers, windows, caps, prefixes, health paths) live in
 * `src/config/redis-keys.ts` so the BFF and the Functions middleware cannot
 * drift into throttling the same account differently.
 *
 * Living here rather than in `security.ts` because it needs Redis, and because
 * the route groups select different limiters.
 */

const isProd = process.env['PRODUCTION'] === 'true'

const build = (
  max: number,
  prefix: string,
  protection: boolean,
): Ratelimit | null =>
  isRedisEnabled
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(max, rateLimitWindow(isProd)),
        analytics: isProd,
        // Disabled for telemetry: per-IP deny-listing false-positives on
        // high-volume client events.
        enableProtection: isProd && protection,
        prefix,
      })
    : null

/** Paid tiers get a bigger budget; the role claim is matched longest-first. */
const tiered = Object.fromEntries(
  Object.keys(RATE_LIMIT_TIER_MULTIPLIERS).map((tier) => [
    tier,
    build(
      rateLimitFunctionMax(tier as RateLimitTier, isProd),
      functionsRateLimitKey(tier),
      true,
    ),
  ]),
) as Record<string, Ratelimit | null>

const functionLimiter = tiered['free'] ?? null
const authLimiter = build(rateLimitAuthMax(isProd), AUTH_RATE_LIMIT_PREFIX, true)
const eventLimiter = build(rateLimitEventMax(isProd), EVENT_RATE_LIMIT_PREFIX, false)

if (isProd && !isRedisEnabled) {
  console.error(
    'bff: rate limiting DISABLED — no usable Upstash REST credentials. ' +
      'Limiting and IP deny-lists are inactive on this instance.',
  )
}

/** Health checks must never be throttled — they gate deploys and uptime probes. */
const SKIP_PATHS = new Set(RATE_LIMIT_SKIP_PATHS)

/**
 * Client IP, in trust order.
 *
 * Why not `server.requestIP()`: it returns the *socket* address and deliberately
 * ignores X-Forwarded-For, which behind Cloudflare -> Firebase Hosting -> Cloud Run
 * is the proxy's address, not the visitor's.
 *
 * `cf-connecting-ip` is only trusted when `cf-ray` is also present, because the
 * origin is reachable directly (`*.run.app`, `*.web.app`) where a client could
 * forge both. Without that guard the limiter buckets collapse onto the Cloudflare
 * PoP — one shared bucket per PoP, every user throttling every other user, which
 * is exactly what was found in Redis on 2026-09-15.
 *
 * ponytail: header-based, so a direct-to-origin caller can still lie about its IP,
 * as it already could via X-Forwarded-For. Locking the origin to Cloudflare's
 * ranges is the boundary.
 * @param {*} request
 * @return {*}
 */
export const clientIp = (request: Request): string => {
  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp && request.headers.get('cf-ray')) {
    return cfIp.trim()
  }

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return (forwarded.split(',')[0] ?? '').trim()
  }

  return 'unknown'
}

/**
 * One template for both block pages. The original had two near-identical
 * ~40-line blobs; the only real difference was the status text.
 *
 * ponytail: the inline `cdn.tailwindcss.com` script is NOT in the live CSP
 * (`hosting.headers` allows only 'self' + a fixed allowlist), so these pages
 * render unstyled in production. Pre-existing, kept as-is for parity — fixing it
 * means inlining the CSS or moving it to a bundled stylesheet.
 * @param {*} status
 * @param {*} retryAfterSec
 * @return {*}
 */
const blockedPage = (status: 403 | 429, retryAfterSec: number): string => {
  const denied = status === 403
  const heading = denied ? 'Access Denied' : 'Too Many Requests'
  const message = denied
    ? 'Your IP address has been blocked due to suspicious activity. Please contact support if you believe this is an error.<br><span class="text-red-600 font-semibold">Reason: Security Policy Violation</span>'
    : `You have made too many requests. Please try again in ${retryAfterSec} seconds.`

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${status} ${heading}</title>
    <link rel="preconnect" href="https://fonts.gstatic.com/" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?display=swap&family=Inter:wght@400;500;700;900&family=Noto+Sans:wght@400;500;700;900" />
    <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  </head>
  <body class="relative min-h-screen w-full bg-white flex flex-col items-center justify-center font-['Inter','Noto Sans',sans-serif] overflow-x-hidden">
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
      <span class="text-[16vw] font-black text-gray-200 opacity-40">${status}</span>
    </div>
    <div class="relative z-10 w-full max-w-xl mx-auto flex flex-col items-center justify-center py-10">
      <h2 class="text-[#111318] text-3xl md:text-4xl font-bold leading-tight text-center pb-3 pt-5">${heading}</h2>
      <p class="text-[#111318] text-base font-normal leading-normal pb-3 pt-1 text-center">${message}</p>
      <div class="flex gap-4 py-6 justify-center">
        <button class="flex min-w-[84px] max-w-xs cursor-pointer items-center justify-center rounded-lg h-10 px-4 bg-[#195de6] text-white text-sm font-bold hover:bg-blue-700" onclick="window.location.href='/'">
          <span>Go Home</span>
        </button>
      </div>
    </div>
  </body>
</html>
`
}

/** Paths whose client parses a body, so a block must reach them as JSON. */
const JSON_BLOCK_PREFIXES = ['/api/', '/oauth/']

/**
 * The block body, shaped for whoever is reading it.
 *
 * A browser navigation gets the styled page. `/api` and `/oauth` get JSON: those
 * callers go through `res.json()` and an HTML 429 surfaces as an unparseable
 * error instead of a retryable status, which is how a throttled poll looks like
 * a crash.
 * @param {403|429} status 403 for a deny-list hit, 429 for a rate limit.
 * @param {number} retryAfterSec Seconds the caller should wait.
 * @param {string} pathname Request path, to pick the shape.
 * @return {Response} The block response.
 */
const blockResponse = (
  status: 403 | 429,
  retryAfterSec: number,
  pathname: string,
): Response =>
  JSON_BLOCK_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ? new Response(
        JSON.stringify({
          error: status === 403 ? 'forbidden' : 'rate-limited',
          message: `Too many requests. Retry after ${retryAfterSec}s.`,
        }),
        {
          status,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfterSec),
          },
        },
      )
    : new Response(blockedPage(status, retryAfterSec), {
        status,
        headers: { 'Content-Type': 'text/html' },
      })

type LimitContext = {
  request: Request
  set: {
    status?: number | string
    headers: Record<string, string | number>
  }
  /** Supplied later by the auth plugin; absent leaves the limiter keyed on IP. */
  user?: { uid?: string; role?: unknown }
}

export type Limiter = (ctx: LimitContext) => Promise<Response | undefined>

/**
 * Production check for the fail-closed decision, read at call time.
 *
 * Deliberately not the module-level `isProd`: that is frozen at import, so a
 * security switch keyed on it cannot be asserted in a test and cannot follow an
 * env established after the module loads. One property read on an auth request
 * is a fine price for a decision that is provable.
 * @return {boolean} True when running in production.
 */
const inProduction = (): boolean => process.env['PRODUCTION'] === 'true'

/**
 * The response when an AUTH limiter cannot decide.
 *
 * Only the auth limiters use this; everywhere else stays fail-open. I3 says a
 * rate limit must never take the site down, and that is right for a crawler or a
 * page view. Auth is the one exception worth inverting: with no counter,
 * `/oauth/verify-login` and `/resolve-identifier` are unmetered password and
 * enumeration oracles, so an outage that stops new sign-ins is cheaper than one
 * that lets credential stuffing proceed at network speed.
 *
 * JSON, not `blockedPage`: these are API endpoints whose client parses a body,
 * and an HTML 503 would surface as an unparseable error instead of a retry.
 * @return {Response} A 503 the client can retry.
 */
const unavailable = (): Response =>
  new Response(
    JSON.stringify({
      error: 'service-unavailable',
      message: 'Sign-in is temporarily unavailable. Try again shortly.',
    }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    },
  )

/**
 * Built as a factory so the failing and blocking paths are testable without a
 * live Redis — pass a stub `limit()`.
 * @param {*} limiter
 * @param {*} tieredByRole
 * @param {*} failClosed Refuse when the counter cannot be read, IN PRODUCTION
 *   ONLY. Auth routes pass true; nothing else may.
 * @return {*} A `Limiter`.
 */
export const createLimiter = (
  limiter: Ratelimit | null,
  tieredByRole = false,
  failClosed = false,
): Limiter =>
  async function check(ctx: LimitContext): Promise<Response | undefined> {
    if (!limiter) {
      // No counter at all — unconfigured or unusable Upstash credentials. An
      // auth route must refuse rather than run wide open. Outside production
      // this stays permissive so local dev and the emulator work without Redis.
      return failClosed && inProduction() ? unavailable() : undefined
    }

    const { pathname } = new URL(ctx.request.url)
    if (SKIP_PATHS.has(pathname)) {
      return undefined
    }

    const effective = tieredByRole
      ? (tiered[resolveTier(ctx.user?.role)] ?? limiter)
      : limiter

    const ip = clientIp(ctx.request)
    // Authenticated callers are limited per-user, everyone else per-IP.
    const identifier = ctx.user?.uid ?? ip

    try {
      const { success, limit, remaining, reset, reason, pending } = await effective.limit(
        identifier,
        { ip, userAgent: ctx.request.headers.get('user-agent') ?? 'unknown' },
      )

      // Upstash's own bookkeeping, not a check: fire-and-forget so it never adds
      // a second sequential REST round trip to the request path.
      void pending?.catch(() => undefined)

      ctx.set.headers['RateLimit-Limit'] = String(limit)
      ctx.set.headers['RateLimit-Remaining'] = String(Math.max(0, remaining))
      ctx.set.headers['RateLimit-Reset'] = new Date(reset).toISOString()

      if (success) {
        return undefined
      }

      const retryAfterSec = Math.max(0, Math.ceil((reset - Date.now()) / 1000))
      const status = reason === 'denyList' ? 403 : 429

      ctx.set.headers['Retry-After'] = String(retryAfterSec)
      // Both, deliberately: the status must ride on the returned Response, and
      // `set.status` covers the case where the framework prefers it. Setting only
      // `set.status` shipped the block page as HTTP 200.
      ctx.set.status = status

      return blockResponse(status, retryAfterSec, pathname)
    } catch (error) {
      // Fail OPEN by default, matching the Express limiter's `catch { next() }`.
      // A Redis or Upstash outage must degrade to "unlimited", never to "site
      // down" — a 500 on every page request is a far worse failure than a missed
      // throttle. Logged so it stays visible instead of silently unthrottled.
      //
      // The auth limiters invert this in production: an un-decidable auth check
      // is a brute-force window, so it refuses (see `unavailable`). Dev and the
      // emulator have no Redis, so they keep the permissive path.
      console.error('bff: rate limit check failed', error)

      if (failClosed && inProduction()) {
        return unavailable()
      }

      return undefined
    }
  }

export const limitEvent = createLimiter(eventLimiter)
/**
 * The ONLY fail-closed limiter. Every route mounting it is an auth endpoint
 * whose cheapness is the attack: guessing a password, enumerating an email or a
 * phone number, or spending SMS budget.
 */
export const limitAuth = createLimiter(authLimiter, false, true)
export const limitFunction = createLimiter(functionLimiter, true)

// No limiter re-exports: nothing imported them, and an export that no module
// reads is an invitation to reach around `limitAuth`/`limitFunction` and skip the
// fail-closed policy. `resolveTier` stays because a spec exercises the mapping.
export { resolveTier }
