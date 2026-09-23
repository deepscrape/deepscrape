import { Elysia } from 'elysia'
import { guestFingerprintHandler, analyticsEventHandler, batchAnalyticsEventHandler } from '../functions/src/gfunctions/analytics'
import { heartbeat } from '../functions/src/handlers/home_handler'
import { bridgeHandler } from './bridge'
import { countConsentDecision } from './consent'
import { adminAuth } from './firebase'
import { limitEvent } from './limiter'

/**
 * `/event` — the four telemetry routes, reusing the existing handlers verbatim
 * through the bridge in `bridge.ts`.
 *
 * Ported from `functions/src/infrastructure/events.ts`, whose `optionalJwtAuth`
 * comment is the important part: guests send `Authorization: Bearer ` with an
 * EMPTY token, so a missing or unverifiable token must mean "anonymous", never
 * 401 — a 401 here would break the guest heartbeat. A present-and-valid token
 * populates `user`, which is what stops a caller forging a claimed `userId`.
 * @param {*} request
 */

const optionalUser = async (request: Request) => {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (!token) {
    return undefined
  }

  try {
    return await adminAuth().verifyIdToken(token, true)
  } catch (error) {
    // Log the message, not the error object: the original logged the whole thing,
    // and this path sees the raw bearer token.
    console.warn(
      'bff /event: token verification failed, continuing anonymously:',
      error instanceof Error ? error.message : 'unknown error',
    )

    return undefined
  }
}

export const eventRoutes = new Elysia({ name: 'event' })
  // derive runs before beforeHandle, so the limiter can key on the verified uid.
  .derive(async ({ request }) => ({ user: await optionalUser(request) }))
  .onBeforeHandle(async ({ request, set, user }) =>
    limitEvent({ request, set, user: user as { uid?: string } | undefined }),
  )
  .post('/event/guest-fingerprint', bridgeHandler(guestFingerprintHandler))
  .post('/event/analytics/event', bridgeHandler(analyticsEventHandler))
  .post('/event/analytics/batch', bridgeHandler(batchAnalyticsEventHandler))
  .post('/event/heartbeat', bridgeHandler(heartbeat))
  // Consent decisions. Not a bridge handler: this is our own aggregate counter, and it
  // deliberately reads no cookie and calls no upstream service.
  .post('/event/consent', countConsentDecision)
