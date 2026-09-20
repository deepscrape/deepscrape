import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { CLIENT_EVENT_LIST_MAX } from '../src/config/redis-keys'
import { eventRoutes } from './event'

const app = new Elysia().use(eventRoutes)

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )

describe('/event routes', () => {
  test('guest-fingerprint hashes the payload and sets a readable cookie', async () => {
    const res = await post('/event/guest-fingerprint', { ua: 'test', tz: 'UTC' }, {
      cookie: 'consent=granted',
    })
    const body = (await res.json()) as { success: boolean; fingerprint: string }

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.fingerprint).toMatch(/^[a-f0-9]{64}$/)

    const cookies = res.headers.getSetCookie()
    const fp = cookies.find((c) => c.startsWith('guest_fp='))
    expect(fp).toBeDefined()
    expect(fp).not.toContain('HttpOnly')
  })

  test('guest-fingerprint stores nothing without consent', async () => {
    const res = await post('/event/guest-fingerprint', { ua: 'test', tz: 'UTC' })

    expect(res.status).toBe(200)
    // The caller ignores the body; the point is that no tracking cookie is set.
    expect(
      res.headers.getSetCookie().find((c) => c.startsWith('guest_fp=')),
    ).toBeUndefined()
  })

  test('analytics/event accepts a client event', async () => {
    const res = await post('/event/analytics/event', {
      eventType: 'page_view',
      properties: { path: '/' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  test('analytics/batch rejects an empty batch and bounds an oversized one', async () => {
    const empty = await post('/event/analytics/batch', { events: [] })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: 'No events provided' })

    // The cap is the ingress bound on one request; the check is `>`, so exactly
    // CLIENT_EVENT_LIST_MAX passes and one more is rejected.
    const events = Array.from({ length: CLIENT_EVENT_LIST_MAX + 1 }, (_, i) => ({
      eventType: `e${i}`,
    }))

    const atCap = await post('/event/analytics/batch', {
      events: events.slice(0, CLIENT_EVENT_LIST_MAX),
    })
    expect(atCap.status).toBe(200)

    const huge = await post('/event/analytics/batch', { events })
    expect(huge.status).toBe(413)
  })

  test('an unverifiable token stays anonymous rather than 401', async () => {
    // Guests send `Bearer ` with an empty token; a 401 would break the heartbeat.
    const res = await post('/event/analytics/event', { eventType: 'x' }, {
      authorization: 'Bearer not-a-real-token',
    })

    expect(res.status).not.toBe(401)
  })

  test('heartbeat is wired, not a 404', async () => {
    const res = await post('/event/heartbeat', {})

    expect(res.status).not.toBe(404)
  })
})
