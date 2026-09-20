import { describe, expect, test } from 'bun:test'
import { createBridge, toResponse } from './bridge'

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
