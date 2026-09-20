import { clientIp } from './limiter'
import { parseCookies } from './security'

/**
 * Minimal Express-shaped req/res facade, so the existing route handlers run
 * inside Elysia unchanged.
 *
 * Why this exists: `heartbeat` plus the analytics handlers are ~1,500 lines of
 * Redis/Firestore session logic — including a *fixed* forged-`aid` security bug
 * whose comment explains the trust boundary. Elysia cannot mount an Express
 * Router (`.mount()` accepts WinterTC fetch handlers only), so the alternatives
 * were re-implementing that logic and re-testing it, or giving it the surface it
 * already expects. This is the second option.
 *
 * ponytail: covers exactly what the ported handlers touch — `req.{body,cookies,
 * headers,ip,connection,app,user,get()}` and `res.{status().json(),json(),send(),
 * cookie(),setHeader()}`. Extend it when a route group needs more. Do NOT grow it
 * into a general Express emulator.
 */

type CookieOptions = {
  httpOnly?: boolean
  secure?: boolean
  sameSite?: boolean | 'lax' | 'strict' | 'none'
  maxAge?: number
  path?: string
}

export type BridgedResponse = {
  status: number
  body: unknown
  headers: Record<string, string>
  cookies: string[]
  /** True once a handler has produced a body — otherwise we 500 rather than hang. */
  sent: boolean
}

const serializeCookie = (
  name: string,
  value: string,
  opts: CookieOptions = {},
): string => {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`]

  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  if (opts.sameSite) {
    parts.push(
      `SameSite=${
        opts.sameSite === true
          ? 'Strict'
          : `${opts.sameSite[0]!.toUpperCase()}${opts.sameSite.slice(1)}`
      }`,
    )
  }
  // Express takes maxAge in MILLISECONDS and emits Max-Age in seconds.
  if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`)

  return parts.join('; ')
}

/** Express `res.type()` shorthand map for the values the handlers actually use. */
const MIME: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  text: 'text/plain; charset=utf-8',
}

/**
 * Elysia's request cookie jar, as a sink for `res.cookie`.
 *
 * Middleware (guestTracker) sets cookies on a request that keeps going, so they
 * cannot be returned as part of a synthetic Response — they must land on the real
 * one. `set.headers['Set-Cookie'] = [...]` silently drops arrays, so the jar is
 * the only path that works.
 */
export type CookieSink = Record<
  string,
  {
    value: unknown
    httpOnly?: boolean
    sameSite?: boolean | 'lax' | 'strict' | 'none'
    path?: string
    secure?: boolean
    maxAge?: number
  }
>

export const createBridge = (
  request: Request,
  body: unknown,
  user?: { uid?: string } | undefined,
  params: Record<string, string> = {},
  cookieSink?: CookieSink,
) => {
  const state: BridgedResponse = {
    status: 200,
    body: undefined,
    headers: {},
    cookies: [],
    sent: false,
  }

  const headerBag: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headerBag[key.toLowerCase()] = value
  })

  const res = {
    /**
     * status
     * @param {*} code
     * @return {*}
     */
    status(code: number) {
      state.status = code
      return res
    },
    /**
     * type
     * @param {*} value
     * @return {*}
     */
    type(value: string) {
      state.headers['Content-Type'] = MIME[value] ?? value
      return res
    },
    /**
     * json
     * @param {*} payload
     * @return {*}
     */
    json(payload: unknown) {
      state.body = payload
      state.sent = true
      state.headers['Content-Type'] ??= 'application/json; charset=utf-8'
      return res
    },
    /**
     * send
     * @param {*} payload
     * @return {*}
     */
    send(payload: unknown) {
      state.body = payload
      state.sent = true
      // Express derives the type from the payload: an object is JSON, a string
      // defaults to text/html. Handlers rely on that (they call bare
      // `res.send({...})`), so mirroring it is not optional.
      if (payload !== null && typeof payload === 'object') {
        state.headers['Content-Type'] ??= 'application/json; charset=utf-8'
      } else if (typeof payload === 'string') {
        state.headers['Content-Type'] ??= 'text/html; charset=utf-8'
      }
      return res
    },
    /**
     * setHeader
     * @param {*} key
     * @param {*} value
     * @return {*}
     */
    setHeader(key: string, value: unknown) {
      state.headers[key] = String(value)
      return res
    },
    /**
     * cookie
     * @param {*} name
     * @param {*} value
     * @param {*} opts
     * @return {*}
     */
    cookie(name: string, value: string, opts?: CookieOptions) {
      if (cookieSink) {
        const target = cookieSink[name]
        if (target) {
          target.value = value
          // Elysia's CookieOptions.maxAge is SECONDS; Express's is MILLISECONDS.
          target.maxAge = opts?.maxAge ? Math.floor(opts.maxAge / 1000) : target.maxAge
          target.httpOnly = opts?.httpOnly ?? target.httpOnly
          target.sameSite = opts?.sameSite ?? target.sameSite
          target.path = opts?.path ?? target.path
          target.secure = opts?.secure ?? target.secure
          return res
        }
      }

      state.cookies.push(serializeCookie(name, value, opts))
      return res
    },
  }

  const url = new URL(request.url)

  const req = {
    body,
    params,
    // Always an object. The function has hit real bugs here: its Express 4 app is
    // wrapped by the functions-framework's Express 5, so the lazy `query` getter is
    // not on the prototype and `req.query` can be undefined at runtime.
    query: Object.fromEntries(url.searchParams),
    // Express provides these; omitting `path` broke guest tracking in a way that
    // looked like Firestore noise: `buildGuestAcquisition` returns undefined when
    // every field is empty, and Firestore rejects `undefined` as a document value,
    // so every guest write failed silently.
    path: url.pathname,
    originalUrl: url.pathname + url.search,
    cookies: parseCookies(request.headers.get('cookie')) as Record<string, string>,
    headers: headerBag,
    get: (key: string) => headerBag[key.toLowerCase()],
    // Same trust order as the limiter: cf-ray-gated cf-connecting-ip, then XFF.
    ip: clientIp(request),
    connection: { remoteAddress: clientIp(request) },
    // Handlers read `app.locals['user']` as a legacy fallback; `user` is the
    // verified identity and is what `heartbeat` actually requires.
    app: { locals: {} as Record<string, unknown> },
    user,
  }

  return { req, res: Object.assign(res, { locals: {} }), state }
}

/** Turn the captured state into a Response.
 * @param {*} state
 * @return {*}
 */
export const toResponse = (state: BridgedResponse): Response => {
  const headers = new Headers()

  for (const [key, value] of Object.entries(state.headers)) {
    headers.set(key, value)
  }
  // append, not set: a handler and the CSRF hook may both set cookies.
  for (const cookie of state.cookies) {
    headers.append('Set-Cookie', cookie)
  }

  if (!state.sent) {
    return new Response(JSON.stringify({ error: 'Handler produced no response' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const payload =
    typeof state.body === 'string'
      ? state.body
      : JSON.stringify(state.body ?? null)

  return new Response(payload, { status: state.status, headers })
}

/** The Express-typed handlers; the bridge supplies exactly what they read. */
export type ExpressHandler = (req: never, res: never) => unknown

/** An Express middleware, including `next`. */
export type ExpressMiddleware = (
  req: never,
  res: never,
  next: never,
) => unknown

export type BridgeContext = {
  request: Request
  body?: unknown
  params?: Record<string, string>
  user?: { uid?: string }
}

/**
 * Wrap an Express handler as an Elysia handler.
 *
 * A throwing handler becomes a 500 rather than an unhandled rejection — Express
 * did that for free, so without this the failure mode changes shape.
 * @param {*} handler
 * @return {*}
 */
export const bridgeHandler =
  (handler: ExpressHandler) =>
  async (ctx: BridgeContext): Promise<Response> => {
    const { req, res, state } = createBridge(
      ctx.request,
      ctx.body,
      ctx.user,
      ctx.params,
    )

    try {
      await handler(req as never, res as never)
    } catch (error) {
      console.error('bff: bridged handler threw', error)

      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return toResponse(state)
  }

/**
 * Run an Express middleware chain through one bridge, in order.
 *
 * This is what makes the `/api` port cheap: `isJwtAuth` sets `req.user` (and
 * `req.app.locals.user`) on the shared request, and `requirePaidAccess`,
 * `requirePermission` and the handler all read it — no user-threading, no
 * re-implementation of the ~700 lines of org/machine logic, and the ordering is
 * the same array Express ran.
 *
 * The chain stops as soon as a middleware produces a response (401/403/500/429),
 * which is exactly when Express would stop.
 * @param {*} ctx
 * @param {*} chain
 */
export const runChain = async (
  ctx: BridgeContext,
  chain: ExpressMiddleware[],
): Promise<Response> => {
  const { req, res, state } = createBridge(
    ctx.request,
    ctx.body,
    ctx.user,
    ctx.params,
  )

  let index = 0
  const next = () => {
    index += 1
  }

  try {
    while (index < chain.length) {
      const before = index

      await chain[index]!(req as never, res as never, next as never)

      if (state.sent) {
        return toResponse(state)
      }

      // A middleware that neither advanced the chain nor answered would spin
      // forever. Nothing in the ported chains does this, so treat it as a stop.
      if (index === before) {
        break
      }
    }
  } catch (error) {
    console.error('bff: express chain threw', error)

    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return toResponse(state)
}
