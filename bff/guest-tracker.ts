import { Elysia } from 'elysia'
import { guestTracker } from '../functions/src/gfunctions/analytics'
import { createBridge, type CookieSink } from './bridge'

/**
 * `guestTracker` wired as a global hook.
 *
 * `functions/src/server.ts` mounts it with "track anonymous guests as early as
 * possible so API and event routes are included" — which also means it runs for
 * static misses and the page catch-all, so this is a global hook rather than
 * per-route.
 *
 * Two things it needs that a returned Response cannot provide:
 * - it sets cookies (`gid`) on a request that continues, so they must land on the
 *   real response via Elysia's cookie jar;
 * - it sets a response header (`Accept-CH`), which has to be merged into `set`.
 *
 * IP parity: it resolves the client IP through `request-ip`'s `getClientIp`, whose
 * FIRST check is `cf-connecting-ip`. Passing all request headers through means it
 * resolves the same value as the function, so existing guest fingerprints — which
 * are `sha256(ip|ua-family|os-family|device-family)` — stay stable. Changing this
 * would silently fragment every stored guest record.
 */
export const guestTrackerPlugin = new Elysia({ name: 'guest-tracker' }).onBeforeHandle(
  { as: 'global' },
  /**
   * callback
   */
  async ({ request, set, cookie }) => {
    const { req, res, state } = createBridge(
      request,
      undefined,
      undefined,
      {},
      cookie as unknown as CookieSink,
    )

    await guestTracker(req as never, res as never, (() => undefined) as never)

    for (const [key, value] of Object.entries(state.headers)) {
      set.headers[key] = value
    }
  },
)
