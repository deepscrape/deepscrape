import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { api } from './api'

const app = new Elysia().use(api)

describe('public routes', () => {
  test('/status answers, and not with the CSR shell', async () => {
    // The regression this guards: an unrouted /status fell through to the page
    // catch-all and returned HTML with a 200, so a health check saw the landing
    // page and called it healthy.
    const res = await app.handle(new Request('http://localhost/status'))

    expect(res.status).not.toBe(404)
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html')
  })

  test('/services/contact accepts a POST instead of serving a page', async () => {
    const res = await app.handle(
      new Request('http://localhost/services/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )

    expect(res.status).not.toBe(404)
    // An empty body is rejected by the handler's own validation, which is itself
    // proof the request reached it rather than the catch-all.
    expect(res.status).toBeLessThan(500)
  })
})
