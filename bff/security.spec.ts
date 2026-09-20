import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { security } from './security'

const app = new Elysia()
  .use(security)
  .get('/page', () => new Response('<app-root></app-root>'))
  .post('/api/echo', () => ({ ok: true }))
  .post('/event/analytics/event', () => ({ ok: true }))

const call = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init))

const setCookie = (res: Response, name: string) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))

  if (!raw) {
    throw new Error(`${name} not set; got ${JSON.stringify(res.headers.getSetCookie())}`)
  }

  return raw
}

const valueOf = (res: Response, name: string) =>
  decodeURIComponent(setCookie(res, name).split(';')[0].slice(name.length + 1))

/** The cookie a browser would receive on a page load and echo back. */
const bootstrap = async () => {
  const res = await call('/page')

  return {
    token: valueOf(res, '_csrf'),
    cookie: `_csrf_secret=${encodeURIComponent(valueOf(res, '_csrf_secret'))}`,
  }
}

describe('csrf, cookies and cors', () => {
  test('issues a signed httpOnly secret plus a readable token', async () => {
    const res = await call('/page')

    // Both cookies must survive: the cookie jar is what makes multiple Set-Cookie work.
    expect(res.headers.getSetCookie().length).toBe(2)

    expect(setCookie(res, '_csrf_secret')).toContain('HttpOnly')
    expect(setCookie(res, '_csrf_secret')).toContain('SameSite=Lax')
    expect(valueOf(res, '_csrf_secret')).toMatch(/^s:/)
    expect(setCookie(res, '_csrf')).not.toContain('HttpOnly')
  })

  test('rejects a state-changing request with no token', async () => {
    const res = await call('/api/echo', { method: 'POST' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Invalid CSRF token' })
  })

  test('rejects a wrong token', async () => {
    const { cookie } = await bootstrap()
    const res = await call('/api/echo', {
      method: 'POST',
      headers: { cookie, 'csrf-token': 'not-the-token' },
    })

    expect(res.status).toBe(403)
  })

  test('accepts the matching token', async () => {
    const { token, cookie } = await bootstrap()
    const res = await call('/api/echo', {
      method: 'POST',
      headers: { cookie, 'csrf-token': token },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('ignores non-browser prefixes and safe methods', async () => {
    expect((await call('/event/analytics/event', { method: 'POST' })).status).toBe(200)
    expect((await call('/page')).status).toBe(200)
  })

  test('/csrf-token returns a usable token with no-store', async () => {
    const res = await call('/csrf-token')
    const body = (await res.json()) as { csrfToken: string }

    expect(res.headers.get('cache-control')).toBe('no-store')

    const echoed = await call('/api/echo', {
      method: 'POST',
      headers: {
        cookie: `_csrf_secret=${encodeURIComponent(valueOf(res, '_csrf_secret'))}`,
        'csrf-token': body.csrfToken,
      },
    })

    expect(echoed.status).toBe(200)
  })

  test('security.txt keeps its contract', async () => {
    const res = await call('/.well-known/security.txt')

    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=604800')
    expect(await res.text()).toContain('Contact: mailto:security@deepscrape.dev')
  })

  test('cors echoes allowlisted origins only, with credentials', async () => {
    const allowed = await call('/page', { headers: { origin: 'http://localhost:4200' } })

    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4200',
    )
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')

    const denied = await call('/page', { headers: { origin: 'https://evil.example' } })

    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})
