import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { trafficCounterPlugin } from './traffic-counter'

let counted = 0

const app = new Elysia()
  .use(trafficCounterPlugin(async () => {
    counted += 1
  }))
  .get('/page', () => new Response('<app-root></app-root>'))
  .get('/probe', ({ set }) => {
    set.status = 404
    return 'not found'
  })

const visit = (headers: Record<string, string> = {}) =>
  app.handle(new Request('http://localhost/page', { headers }))

describe('consent-free traffic counter', () => {
  test('counts a declined visitor exactly like one who never answered', async () => {
    counted = 0

    // The two states the guest pipeline cannot see. Neither cookie is read: the
    // count is identical because the counter is blind to consent by construction.
    const declined = await visit({ cookie: 'consent=denied' })
    const unanswered = await visit()

    expect(declined.status).toBe(200)
    expect(unanswered.status).toBe(200)
    expect(counted).toBe(2)
  })

  test('writes nothing back to the device', async () => {
    counted = 0

    const res = await visit({ cookie: 'gid=existing, aid={"guestId":"x"}' })

    // The entire legal basis: no Set-Cookie, so nothing is stored on, or read from,
    // the visitor's terminal. Assert it, because a future "improvement" that returns
    // a visitor id here would take this mechanism outside Art. 5(3).
    expect(res.headers.getSetCookie()).toEqual([])
    expect(counted).toBe(1)
  })

  test('leaves probes and error responses out of the count', async () => {
    counted = 0

    await app.handle(new Request('http://localhost/probe'))

    expect(counted).toBe(0)
  })
})
