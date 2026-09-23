import { Elysia } from 'elysia'
import { isRedisEnabled, redis } from '../functions/src/app/cacheConfig'
import { TRAFFIC_TTL_SECONDS, trafficDailyKey } from '../src/config/redis-keys'

/**
 * Consent-free traffic counter.
 *
 * Every other identifier this app writes is behind the ePrivacy gate: `guestTracker`
 * returns before it touches a fingerprint, a cookie or Redis unless the visitor granted
 * consent, so a visitor who declines — or never answers the banner — is invisible to the
 * dashboard. This counts requests the BFF actually served, and it is lawful for everyone
 * for exactly one reason: **it reads nothing from the device.** No cookie is parsed, no
 * fingerprint is computed, no id is minted, and nothing is written back to the browser.
 * ePrivacy Art. 5(3) governs storing or accessing information on the user's terminal; a
 * server-side counter does neither, and the value it produces singles nobody out, so the
 * GDPR's material scope is not entered either.
 *
 * That is also the honest limit of what it can say. It is a request level, not a visitor
 * count, and it is blind to consent by construction — which is the point: `newGuests`
 * answers "how many people are new", this answers "is anything reaching the site at all",
 * and a consent-gated metric can never answer the second one.
 *
 * ponytail: one counter per UTC day, no path or dimension breakdown. The guest pipeline
 * already breaks down consented traffic; this only has to be a level. Add a dimension when
 * someone asks a question the level cannot answer.
 */

/** Counts one served request for the current UTC day. */
const countServedRequest = async (): Promise<void> => {
  if (!isRedisEnabled) {
    return
  }

  const key = trafficDailyKey(new Date().toISOString().split('T')[0])
  // TTL only on the create, so ordinary requests stay a single round trip.
  if (await redis.incr(key) === 1) {
    await redis.expire(key, TRAFFIC_TTL_SECONDS)
  }
}

/**
 * Global `onAfterHandle`, so it runs once per request and can see the status the app
 * decided on: probes, missing assets and blocked requests answer 4xx and stay out of the
 * count, which keeps the scanner traffic out without inspecting the user agent.
 *
 * `count` is injectable so the spec can assert both the counting and the no-device-write
 * property without Redis credentials — the same stub seam `limiter.ts` uses.
 *
 * @param {() => Promise<void>} count Sink for one served request.
 * @return {Elysia} Plugin to register with `app.use`.
 */
export const trafficCounterPlugin = (count: () => Promise<void> = countServedRequest): Elysia =>
  new Elysia({ name: 'traffic-counter' }).onAfterHandle(
    { as: 'global' },
    async ({ set }) => {
      if (Number(set.status ?? 200) >= 400) {
        return
      }

      try {
        await count()
      } catch (error) {
        // A Redis hiccup must never become a failed response.
        console.error('[bff] traffic counter failed', error)
      }
    },
  )
