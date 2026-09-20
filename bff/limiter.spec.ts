import { describe, expect, test } from 'bun:test'
import type { Ratelimit } from '@upstash/ratelimit'
import { rateLimitFunctionMax, rateLimitWindow } from '../src/config/redis-keys'
import { clientIp, createLimiter, resolveTier } from './limiter'

const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/x', { headers })

/** Stub that never touches Redis.
 * @param {*} result
 * @return {*}
 */
const stub = (result: unknown | Error): Ratelimit =>
  ({
    limit: async () => {
      if (result instanceof Error) {
        throw result
      }
      return result
    },
  }) as unknown as Ratelimit

const ctx = () => ({
  request: req(),
  set: { status: undefined as number | string | undefined, headers: {} as Record<string, string | number> },
})

describe('client ip trust order', () => {
  test('trusts cf-connecting-ip only when cf-ray proves it came through Cloudflare', () => {
    expect(
      clientIp(
        req({ 'cf-ray': 'abc123', 'cf-connecting-ip': '203.0.113.7' }),
      ),
    ).toBe('203.0.113.7')

    // Direct-to-origin forgery attempt: both headers present, no cf-ray.
    expect(
      clientIp(
        req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }),
      ),
    ).toBe('198.51.100.4')
  })

  test('falls back to the first x-forwarded-for hop', () => {
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }))).toBe(
      '198.51.100.4',
    )
  })

  test('reports unknown rather than bucketing everyone together silently', () => {
    expect(clientIp(req())).toBe('unknown')
  })
})

describe('tier resolution', () => {
  test('maps role claims longest-first and defaults to free', () => {
    expect(resolveTier('enterprise_admin')).toBe('admin')
    expect(resolveTier('Enterprise')).toBe('enterprise')
    expect(resolveTier('pro')).toBe('pro')
    expect(resolveTier(undefined)).toBe('free')
    expect(resolveTier(42)).toBe('free')
  })
})

describe('budget policy', () => {
  // Both limiters read these, so a change here re-budgets the Express middleware
  // and the BFF at once — which is the point.
  test('scales the function cap by tier and swaps the window per environment', () => {
    expect(rateLimitFunctionMax('free', true)).toBe(100)
    expect(rateLimitFunctionMax('pro', true)).toBe(300)
    expect(rateLimitFunctionMax('admin', true)).toBe(2000)
    expect(rateLimitFunctionMax('free', false)).toBe(50)

    expect(rateLimitWindow(true)).toBe('15 m')
    expect(rateLimitWindow(false)).toBe('1 m')
  })
})

describe('limiter behaviour', () => {
  test('blocks with 429 plus Retry-After and the RateLimit headers', async () => {
    const limit = createLimiter(
      stub({ success: false, limit: 100, remaining: 0, reset: Date.now() + 60_000, reason: 'rateLimit' }),
    )
    const c = ctx()
    const res = await limit(c)

    expect(res?.status).toBe(429)
    expect(c.set.status).toBe(429)
    expect(c.set.headers['Retry-After']).toBe('60')
    expect(c.set.headers['RateLimit-Limit']).toBe('100')
    expect(await res!.text()).toContain('429 Too Many Requests')
  })

  test('reports a deny-list block as 403, not 429', async () => {
    const limit = createLimiter(
      stub({ success: false, limit: 100, remaining: 0, reset: Date.now() + 1000, reason: 'denyList' }),
    )

    expect((await limit(ctx()))?.status).toBe(403)
  })

  test('fails OPEN when the limiter throws', async () => {
    // The regression this guards: without the try/catch a Redis outage throws out
    // of the hook and 500s every page request.
    const c = ctx()
    const limit = createLimiter(stub(new Error('redis down')))

    expect(await limit(c)).toBeUndefined()
    expect(c.set.status).toBeUndefined()
  })

  test('passes through when unconfigured and on health paths', async () => {
    expect(await createLimiter(null)(ctx())).toBeUndefined()

    const healthCtx = {
      request: new Request('http://localhost/health'),
      set: {
        status: undefined as number | string | undefined,
        headers: {} as Record<string, string | number>,
      },
    }

    expect(
      await createLimiter(
        stub({ success: false, limit: 1, remaining: 0, reset: Date.now(), reason: 'rateLimit' }),
      )(healthCtx),
    ).toBeUndefined()
  })

  test('publishes the budget headers on an allowed request', async () => {
    const c = ctx()
    const limit = createLimiter(
      stub({ success: true, limit: 100, remaining: 99, reset: Date.now() + 1000, reason: 'rateLimit' }),
    )

    expect(await limit(c)).toBeUndefined()
    expect(c.set.headers['RateLimit-Remaining']).toBe('99')
  })
})
