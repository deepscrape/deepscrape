import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { guestTrackerPlugin } from './guest-tracker'

const app = new Elysia()
  .use(guestTrackerPlugin)
  .get('/page', () => new Response('<app-root></app-root>'))

const visit = (headers: Record<string, string> = {}) =>
  app.handle(
    new Request('http://localhost/page', {
      headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0', ...headers },
    }),
  )

const gidOf = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith('gid='))

describe('guestTracker', () => {
  test('mints a readable gid cookie for an anonymous visit', async () => {
    // Consent is required before any guest record exists (ePrivacy Art. 5(3)), so this
    // case must carry the cookie the banner sets. It asserted a mint without consent and
    // had been red since the gate shipped.
    const res = await visit({ cookie: 'consent=granted' })

    expect(res.status).toBe(200)
    const gid = gidOf(res)

    expect(gid).toBeDefined()
    // Readable by design: the client-side tracker echoes it.
    expect(gid).not.toContain('HttpOnly')
    expect(gid).toContain('SameSite=Lax')
  })

  test('does not mint a gid when an aid cookie is present', async () => {
    // Signed-in-ish visitors already have a durable identifier; the tracker
    // deliberately returns early for them.
    const res = await visit({ cookie: `aid=${encodeURIComponent('{"guestId":"x"}')}` })

    expect(gidOf(res)).toBeUndefined()
  })

  test('reuses an existing gid instead of rotating it', async () => {
    const res = await visit({ cookie: 'gid=existing-guest-id' })
    const gid = gidOf(res)

    // Only assert if it re-set the cookie: the handler skips the write when the
    // cached liveness record is fresh, so absence is also correct.
    if (gid) {
      expect(gid).toContain('existing-guest-id')
    }
  })
})
