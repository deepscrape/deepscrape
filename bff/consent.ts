import { isRedisEnabled, redis } from '../functions/src/app/cacheConfig'
import { CONSENT_DECISION_TTL_SECONDS, consentDecisionKey } from '../src/config/redis-keys'

/**
 * Counts a consent decision the banner just recorded.
 *
 * This is the one number a consent gate cannot produce from tracking data: everyone the
 * gate is required to skip is, by construction, absent from every other counter. So the
 * banner reports what the visitor chose and the server keeps an aggregate count per day
 * and verdict — no identifier is stored (not the cookie value, not the IP, not a uid),
 * nothing is written back to the device, and this handler reads no cookie at all.
 *
 * It counts DECISIONS, not people: a visitor who clears the cookie and answers again is
 * counted twice. `ponytail:` the per-person proof record (Art. 7(1) — timestamp, banner
 * version, categories, keyed on a hash) is the other half and is deliberately not built
 * here; it needs a retention and lawful-basis decision before anything is written.
 */

/**
 * Whitelisted, never free text: this route is unauthenticated and its only job is to pick
 * one of two counters. Anything that is not the literal `granted` counts as a refusal.
 *
 * @param {unknown} decision Raw body value.
 * @return {string} `granted` or `denied`.
 */
export const toVerdict = (decision: unknown): string =>
  decision === 'granted' ? 'granted' : 'denied'

/**
 * `POST /event/consent` handler.
 *
 * @param {*} context Elysia handler context; only `body` and `set` are read.
 * @return {Promise<void>} Resolves once the counter is incremented; never throws.
 */
export const countConsentDecision = async (context: {
  body: unknown,
  set: { status?: number | string },
}): Promise<void> => {
  const { body, set } = context
  const verdict = toVerdict((body as { decision?: unknown } | null)?.decision)

  set.status = 204

  if (!isRedisEnabled) {
    return
  }

  try {
    const key = consentDecisionKey(new Date().toISOString().split('T')[0], verdict)
    // TTL only on the create, so ordinary decisions stay a single round trip.
    if (await redis.incr(key) === 1) {
      await redis.expire(key, CONSENT_DECISION_TTL_SECONDS)
    }
  } catch (error) {
    // A Redis hiccup must never become a failed response.
    console.error('[bff] consent decision count failed', error)
  }
}
