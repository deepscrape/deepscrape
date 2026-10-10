import { describe, expect, test } from 'bun:test'
import { createBridge, runChain, toResponse } from './bridge'

/**
 * The facade mediates every reused Express handler, so its shape is load-bearing.
 * These assert the Express behaviours that are easy to omit and expensive to miss.
 * @param {*} url
 * @param {*} headers
 * @return {*}
 */

const bridge = (url = 'http://localhost/page?a=1&b=2', headers: Record<string, string> = {}) =>
  createBridge(new Request(url, { headers }), { hello: 'world' })

describe('bridge: Express request surface', () => {
  test('provides path and originalUrl', () => {
    const { req } = bridge()

    // Omitting `path` made buildGuestAcquisition return undefined, which Firestore
    // rejects as a document value — every guest write failed.
    expect(req.path).toBe('/page')
    expect(req.originalUrl).toBe('/page?a=1&b=2')
  })

  test('query is always an object, never undefined', () => {
    const { req } = bridge()

    expect(req.query).toEqual({ a: '1', b: '2' })
    expect(typeof createBridge(new Request('http://localhost/x'), {}).req.query).toBe(
      'object',
    )
  })

  test('params default to an empty object', () => {
    expect(bridge().req.params).toEqual({})
    expect(
      createBridge(new Request('http://localhost/x'), {}, undefined, { email: 'a@b.c' })
        .req.params,
    ).toEqual({ email: 'a@b.c' })
  })

  test('headers expose both bracket access and get()', () => {
    const { req } = bridge('http://localhost/page', { 'User-Agent': 'probe' })

    expect(req.headers['user-agent']).toBe('probe')
    expect(req.get('User-Agent')).toBe('probe')
  })

  test('cookies are parsed and decoded', () => {
    const { req } = bridge('http://localhost/page', {
      cookie: `aid=${encodeURIComponent('{"guestId":"x"}')}; gid=abc`,
    })

    expect(req.cookies['gid']).toBe('abc')
    expect(req.cookies['aid']).toBe('{"guestId":"x"}')
  })

  test('ip uses the same trust order as the limiter', () => {
    expect(
      bridge('http://localhost/page', {
        'cf-ray': 'r',
        'cf-connecting-ip': '203.0.113.7',
      }).req.ip,
    ).toBe('203.0.113.7')

    // cf-connecting-ip without cf-ray is a forgery attempt; fall to XFF.
    expect(
      bridge('http://localhost/page', {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '198.51.100.4, 10.0.0.1',
      }).req.ip,
    ).toBe('198.51.100.4')
  })
})

describe('bridge: Express response surface', () => {
  test('is chainable and send() derives the content type', async () => {
    const { res, state } = createBridge(new Request('http://localhost/x'), {})

    // res.send({...}) must look like JSON, res.send('...') like HTML — Express
    // derives the type from the payload and handlers rely on it.
    await (res as unknown as { send: (p: unknown) => unknown }).send({ a: 1 })
    expect(state.headers['Content-Type']).toContain('application/json')

    const html = createBridge(new Request('http://localhost/x'), {})
    await (html.res as unknown as { send: (p: unknown) => unknown }).send('<p>x</p>')
    expect(html.state.headers['Content-Type']).toContain('text/html')
  })

  test('type() maps shorthand names', () => {
    const { res, state } = createBridge(new Request('http://localhost/x'), {})
    ;(res as unknown as { type: (t: string) => unknown }).type('json')

    expect(state.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })

  test('cookie() converts Express maxAge milliseconds into Max-Age seconds', () => {
    const { res, state } = createBridge(new Request('http://localhost/x'), {})
    ;(
      res as unknown as {
        cookie: (n: string, v: string, o: Record<string, unknown>) => unknown
      }
    ).cookie('gid', 'abc', { maxAge: 31_536_000_000, httpOnly: false, sameSite: 'lax' })

    // A year, not a millennium.
    expect(state.cookies[0]).toContain('Max-Age=31536000')
    expect(state.cookies[0]).not.toContain('HttpOnly')
    expect(state.cookies[0]).toContain('SameSite=Lax')
  })

  test('an unset response becomes 500 rather than an empty 200', () => {
    const { state } = createBridge(new Request('http://localhost/x'), {})

    expect(toResponse(state).status).toBe(500)
  })
})

/**
 * The response EVENTS, which the credit-charging path settles on.
 *
 * `requirePaidAccess` reserves a credit and registers `res.once("finish", …)` to
 * consume it. The bridged `res` was a bare object literal with no event surface, so
 * that call threw INSIDE the middleware, its own catch answered 500, and every
 * `paid`-gated route (crawl, the AI endpoints, machines, the job surface) failed
 * for every paying customer — while leaving the reservation unsettled, so the
 * customer lost the credit too. `streaming.spec.ts` could not have caught it: its
 * guard is a stub that "refuses the way requirePaidAccess does" and never touches
 * `once`. These drive the real call.
 */
describe('bridge: response events the money path settles on', () => {
  test('once("finish") exists, fires once, and can read the final status', async () => {
    const seen: Array<number | undefined> = []

    const paidish = (_req: unknown, res: unknown, next: () => void) => {
      const r = res as { once: (e: string, f: () => void) => void; statusCode?: number }
      // The exact call that used to throw `res.once is not a function`.
      r.once('finish', () => seen.push(r.statusCode))
      next()
    }

    const handler = (_req: unknown, res: unknown) => {
      const r = res as { status: (c: number) => { json: (p: unknown) => unknown } }
      r.status(201).json({ ok: true })
    }

    const response = await runChain(
      { request: new Request('http://localhost/api/crawl', { method: 'POST' }) },
      [paidish as never, handler as never],
    )

    expect(response.status).toBe(201)
    // 201, NOT undefined. An undefined status is never in 2xx/3xx, so the
    // middleware's own predicate would have released the reservation and charged
    // nothing even after `once` existed.
    expect(seen).toEqual([201])
  })

  test('a call that throws fires close, not finish, so a reservation is released', async () => {
    const fired: string[] = []

    const paidish = (_req: unknown, res: unknown, next: () => void) => {
      const r = res as { once: (e: string, f: () => void) => void }
      r.once('finish', () => fired.push('finish'))
      r.once('close', () => fired.push('close'))
      next()
    }

    const boom = () => {
      throw new Error('handler blew up')
    }

    const response = await runChain(
      { request: new Request('http://localhost/api/crawl', { method: 'POST' }) },
      [paidish as never, boom as never],
    )

    expect(response.status).toBe(500)
    // Only close: emitting finish here would hand the listener the still-200 status
    // and consume credits for work that never ran.
    expect(fired).toEqual(['close'])
  })

  test('a settlement promise returning from a listener is awaited before the response', async () => {
    const order: string[] = []

    const paidish = (_req: unknown, res: unknown, next: () => void) => {
      const r = res as { once: (e: string, f: () => Promise<void>) => void }
      // This is what `requirePaidAccess` now does with its ledger write. If the
      // bridge did not await it, the settlement could be lost when the platform
      // freezes the instance as soon as the response is written.
      r.once('finish', async () => {
        await Promise.resolve()
        order.push('settled')
      })
      next()
    }

    const handler = (_req: unknown, res: unknown) => {
      ;(res as { json: (p: unknown) => unknown }).json({ ok: true })
    }

    await runChain(
      { request: new Request('http://localhost/api/crawl', { method: 'POST' }) },
      [paidish as never, handler as never],
    )

    expect(order).toEqual(['settled'])
  })

  test('a registered drain listener does not throw, and finish still fires once', async () => {
    let ticks = 0

    const streamingish = (_req: unknown, res: unknown, next: () => void) => {
      const r = res as {
        once: (e: string, f: () => void) => void
        write: (chunk: string) => boolean
      }
      // `ai_handler` registers this on the streaming path; the bridge's write()
      // always succeeds, so drain is registered and never emitted.
      r.once('drain', () => (ticks += 100))
      r.write('frame')
      r.once('finish', () => (ticks += 1))
      next()
    }

    const handler = (_req: unknown, res: unknown) => {
      ;(res as { end: () => unknown }).end()
    }

    await runChain(
      { request: new Request('http://localhost/api/anthropic/messages', { method: 'POST' }) },
      [streamingish as never, handler as never],
    )

    expect(ticks).toBe(1)
  })
})
