import { Elysia } from 'elysia'
import {
  checkUserEmailForDifferentProvider,
  resolveIdentifier,
  updateEmailVerificationStatus,
  verifyLogin,
} from '../functions/src/handlers/fire_auth'
import {
  checkPhoneNumberExists,
  linkPhoneToAccount,
  updatePhoneVerificationStatus,
  verifyPhoneNumber,
} from '../functions/src/handlers/phone_auth'
import { bridgeHandler, type ExpressHandler } from './bridge'
import { adminAuth } from './firebase'
import { limitAuth, limitFunction, type Limiter } from './limiter'

/**
 * `/oauth` — the eight authentication routes, reusing the existing handlers
 * through the bridge.
 *
 * Ported from `functions/src/infrastructure/authproxy.ts`, where the guard order
 * is load-bearing: the function mounts `upstashFunctionLimiter` on the whole
 * group, then adds `upstashAuthLimiter` per route, then optionally `isJwtAuth`
 * and `requireSelfOrAdmin`. Transcribed per route rather than inferred.
 *
 * Imported from `fire_auth` / `phone_auth` directly, not the `../handlers`
 * barrel — the barrel pulls every handler module (machines, crawler, contact).
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })

type DecodedUser = { uid?: string; role?: unknown }

type OAuthCtx = {
  request: Request
  body?: unknown
  params?: Record<string, string>
  set: { status?: number | string; headers: Record<string, string | number> }
}

/** A guard either rejects with a Response or contributes the resolved user. */
type GuardOutcome = Response | DecodedUser | undefined
type Guard = (ctx: OAuthCtx, user: DecodedUser | undefined) => Promise<GuardOutcome>

const limitedBy =
  (limiter: Limiter): Guard =>
  (ctx, user) =>
    limiter({ request: ctx.request, set: ctx.set, user })

const getAuthErrorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code || '')
  }

  return ''
}

/** Strict verification — 401 with the codes the Angular client switches on. */
const requireJwt: Guard = async ({ request }) => {
  const header = request.headers.get('authorization') ?? ''

  if (!header.startsWith('Bearer ')) {
    return json(401, { error: 'Unauthorized: Missing or invalid token' })
  }

  const token = header.split(' ')[1] ?? ''

  try {
    return (await adminAuth().verifyIdToken(token, true)) as DecodedUser
  } catch (error) {
    // Message only — the original logged the whole error on a path that holds the
    // raw bearer token.
    console.error(
      'bff /oauth: JWT verification failed:',
      error instanceof Error ? error.message : 'unknown error',
    )

    return getAuthErrorCode(error) === 'auth/id-token-revoked'
      ? json(401, { error: 'Unauthorized: Session revoked', code: 'session_revoked' })
      : json(401, { error: 'Unauthorized: Invalid token', code: 'invalid_token' })
  }
}

/** Caller may act on their own uid, or be an admin.
 * @param {*} user
 */
const requireSelfOrAdmin: Guard = async ({ body }, user) => {
  const targetUid = (body as { uid?: unknown } | undefined)?.uid

  if (!targetUid || typeof targetUid !== 'string') {
    return json(400, { error: 'Missing required fields', message: 'uid is required' })
  }

  if (!user?.uid) {
    return json(401, { error: 'Unauthorized: Missing user context' })
  }

  if (user.uid === targetUid || user.role === 'admin') {
    return undefined
  }

  return json(403, { error: 'Forbidden', message: 'Insufficient permissions' })
}

const guarded =
  (handler: ExpressHandler, ...guards: Guard[]) =>
  async (ctx: OAuthCtx): Promise<Response> => {
    let user: DecodedUser | undefined

    for (const guard of guards) {
      const outcome = await guard(ctx, user)

      if (outcome instanceof Response) {
        return outcome
      }
      if (outcome) {
        user = outcome
      }
    }

    return bridgeHandler(handler)({ ...ctx, user })
  }

/** Every route in the group sits behind the general limiter, as in the function.
 * @param {*} handler
 * @param {*} guards
 * @return {*}
 */
const oauth = (handler: ExpressHandler, ...guards: Guard[]) =>
  guarded(handler, limitedBy(limitFunction), ...guards)

export const oauthRoutes = new Elysia({ name: 'oauth' })
  .get(
    '/oauth/provider/email/:email',
    oauth(checkUserEmailForDifferentProvider as unknown as ExpressHandler),
  )
  .post('/oauth/resolve-identifier', oauth(resolveIdentifier, limitedBy(limitAuth)))
  .post(
    '/oauth/provider/phone/check',
    oauth(checkPhoneNumberExists, limitedBy(limitAuth)),
  )
  .post('/oauth/verify-login', oauth(verifyLogin, limitedBy(limitAuth)))
  .post(
    '/oauth/email/verification',
    oauth(updateEmailVerificationStatus, requireJwt, requireSelfOrAdmin),
  )
  .post('/oauth/phone/verify', oauth(verifyPhoneNumber, limitedBy(limitAuth)))
  .post('/oauth/phone/link', oauth(linkPhoneToAccount, requireJwt))
  .post(
    '/oauth/phone/update-verification',
    oauth(updatePhoneVerificationStatus, requireJwt, requireSelfOrAdmin),
  )
