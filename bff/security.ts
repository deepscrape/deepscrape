import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../functions/src/config/env'

/**
 * Security spine for the Elysia BFF — parity with the Express `deepscrape`
 * function's CORS / cookie / CSRF behaviour.
 *
 * Deliberately NOT ported:
 * - `helmet(helmetConfig)`. Measured against production, the only CSP reaching
 *   the browser is Firebase Hosting's `hosting.headers` value
 *   (script-src 'self' 'unsafe-inline' 'unsafe-eval', no nonce). The function's
 *   nonce + 'strict-dynamic' CSP never reaches clients, and the CSR shell's
 *   script tags carry no nonce — so emitting it here would be dead code at best
 *   and a hard outage at worst. Hosting stays the single owner of CSP.
 *
 *   CONDITIONAL — this only holds while Firebase Hosting is in front of this
 *   service. If a domain ever points straight at Cloud Run with no Hosting in
 *   the path, then NOTHING emits CSP / HSTS / X-Content-Type-Options /
 *   X-Frame-Options for production, and they must be added here. Use the
 *   `unsafe-inline` policy, never the nonce one: the CSR shell this service
 *   serves has no nonce on its <script> tags, so a nonce policy blocks the app.
 * - The `sid` session cookie and `POST /logout`: they lived in the root `server.ts`,
 *   which has since been deleted. They were dead code there anyway — the cookie's
 *   path allowlist matched no route that server mounted, so it was never set, and
 *   nothing in the app called `/logout`.
 *
 * ponytail: rate limiters and `guestTracker` are not here yet — they need
 * Redis/Firestore and land together with the route groups that consume them.
 */

const isProd = process.env['PRODUCTION'] === 'true'

/**
 * Reuse the function's config layer instead of reading `process.env` directly:
 * this value lives INSIDE the `FUNCTIONS_ENV_JSON` secret, and `getConfigValue`
 * checks `process.env` first and falls back to that blob — so the same
 * production value the function uses resolves here, with one source of truth
 * and no duplicated copy of the secret to drift.
 *
 * `isProd` deliberately does NOT use `env.IS_PRODUCTION`: that blob's
 * `PRODUCTION` currently holds an undecrypted `encrypted:...` dotenvx
 * placeholder, which parses to false. The plain environment variable is the
 * reliable source, and getting this wrong silently disables `Secure` cookies.
 */
const COOKIE_SECRET = env.COOKIE_SECRET || env.CSRF_COOKIE_SECRET || ''

if (isProd && !COOKIE_SECRET) {
  throw new Error('COOKIE_SECRET (or CSRF_COOKIE_SECRET) is required in production')
}

const CSRF_SECRET_COOKIE = '_csrf_secret'
const CSRF_COOKIE = '_csrf'

/** Non-browser callers: machine / webhook / health endpoints are exempt from CSRF. */
const CSRF_IGNORED_PATH_PREFIXES = ['/event', '/status', '/oauth', '/services/contact']
const CSRF_IGNORED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const ALLOWED_ORIGINS = isProd
  ? ['https://deepscrape.dev', 'https://deepscrape.web.app']
  : [
      'http://localhost:5000',
      'http://127.0.0.1:5000',
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'http://127.0.0.1:8081',
    ]

const b64url = (buf: Buffer) => buf.toString('base64url')
const hmac = (value: string) =>
  b64url(createHmac('sha256', COOKIE_SECRET).update(value).digest())

/** Replaces `cookie-parser(secret)` signed cookies — same `s:` prefix convention.
 * @param {*} value
 * @return {*}
 */
export const signCookie = (value: string) => `s:${value}.${hmac(value)}`

export const unsignCookie = (signed: string | undefined): string | null => {
  if (!signed || !signed.startsWith('s:')) {
    return null
  }

  const separator = signed.lastIndexOf('.')
  if (separator < 3) {
    return null
  }

  const value = signed.slice(2, separator)
  const mac = Buffer.from(signed.slice(separator + 1))
  const expected = Buffer.from(hmac(value))

  return mac.length === expected.length && timingSafeEqual(mac, expected)
    ? value
    : null
}

/**
 * Double-submit token bound to the httpOnly signed secret.
 *
 * ponytail: deterministic per secret, where csurf salted per request. The token
 * is JS-readable by design (the client echoes it in the `csrf-token` header), so
 * per-request salting bought little — the httpOnly signed `_csrf_secret` is the
 * real protection. Upgrade path if you ever need rotation: derive from
 * `secret + sessionId` and re-issue on login.
 * @param {*} secret
 * @return {*}
 */
const csrfTokenFor = (secret: string) => hmac(secret)

const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {}

  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator > 0) {
      out[part.slice(0, separator).trim()] = decodeURIComponent(
        part.slice(separator + 1).trim(),
      )
    }
  }

  return out
}

const CSRF_SECRET_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: isProd,
} as const

const CSRF_TOKEN_OPTIONS = {
  httpOnly: false,
  sameSite: 'lax',
  path: '/',
  secure: isProd,
} as const

export const security = new Elysia({ name: 'security' })
  .use(
    cors({
      origin: (request: Request) => {
        const origin = request.headers.get('origin')
        // No Origin header = non-browser caller; allowed, as in the Express setup.
        return origin === null || ALLOWED_ORIGINS.includes(origin)
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
      allowedHeaders: [
        'content-type',
        'Authorization',
        'Accept',
        'anthropic-version',
        'x-with-iframe',
        'x-return-format',
        'x-target-selector',
        'x-with-generated-alt',
        'x-set-cookie',
        'x-api-key',
        'csrf-token',
        'x-csrf-token',
      ],
      maxAge: 86400,
      credentials: true,
    }),
  )
  .onBeforeHandle({ as: 'global' }, ({ request, set, cookie }) => {
    const { pathname } = new URL(request.url)
    const incoming = parseCookies(request.headers.get('cookie'))

    // Resolve (or mint) the secret, then publish both cookies through the jar so
    // that multiple Set-Cookie headers serialize correctly.
    let secret = unsignCookie(incoming[CSRF_SECRET_COOKIE])
    if (!secret) {
      secret = b64url(randomBytes(32))
    }

    const token = csrfTokenFor(secret)

    cookie[CSRF_SECRET_COOKIE].value = signCookie(secret)
    Object.assign(cookie[CSRF_SECRET_COOKIE], CSRF_SECRET_OPTIONS)
    cookie[CSRF_COOKIE].value = token
    Object.assign(cookie[CSRF_COOKIE], CSRF_TOKEN_OPTIONS)

    const bypassed = CSRF_IGNORED_PATH_PREFIXES.some((path) =>
      pathname.startsWith(path),
    )

    if (bypassed || CSRF_IGNORED_METHODS.has(request.method)) {
      return undefined
    }

    const supplied =
      request.headers.get('csrf-token') ?? request.headers.get('x-csrf-token') ?? null

    if (supplied !== token) {
      set.status = 403

      return pathname.startsWith('/api')
        ? { error: 'Invalid CSRF token' }
        : 'Invalid CSRF token'
    }

    return undefined
  })
  /** Proactive refresh for the Angular `csrfRefreshInterceptor`. */
  .get('/csrf-token', ({ cookie }) => {
    // The global hook above has already published a signed secret into the jar.
    // If it somehow has not, mint one AND store it — returning a token whose
    // secret was never persisted would 403 the client on every later request.
    const stored = cookie[CSRF_SECRET_COOKIE].value
    let secret = unsignCookie(typeof stored === 'string' ? stored : undefined)

    if (!secret) {
      secret = b64url(randomBytes(32))
      cookie[CSRF_SECRET_COOKIE].value = signCookie(secret)
      Object.assign(cookie[CSRF_SECRET_COOKIE], CSRF_SECRET_OPTIONS)
    }

    return new Response(JSON.stringify({ csrfToken: csrfTokenFor(secret) }), {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    })
  })
  /** RFC 9116. */
  .get('/.well-known/security.txt', () => {
    // ponytail: only fields that resolve. RFC 9116 requires Contact + Expires;
    // everything else is optional, and `/security`, `/security-policy` and
    // `/security-acknowledgments` have no route — a researcher who followed
    // them landed on the SPA's not-found page. Add each back with its page.
    const body = `Contact: mailto:security@deepscrape.dev
Expires: 2027-05-28T00:00:00Z
Preferred-Languages: en
Canonical: https://deepscrape.dev/.well-known/security.txt
`

    return new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=604800',
      },
    })
  })

export { ALLOWED_ORIGINS, CSRF_IGNORED_METHODS, CSRF_IGNORED_PATH_PREFIXES, parseCookies }
