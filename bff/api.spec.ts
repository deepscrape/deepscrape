import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { api } from './api'

const app = new Elysia().use(api)

const call = (path: string, method = 'GET') =>
  app.handle(new Request(`http://localhost${path}`, { method }))

/**
 * Every live route from `ReverseAPIProxy`, with concrete path params. The port
 * transcribed 23 registrations by hand, so the table is the thing most likely to
 * be wrong — and a dropped '/api' prefix or a typo'd segment shows up as a 404.
 */
const ROUTES: Array<[string, string]> = [
  ['GET', '/api/orgs'],
  ['GET', '/api/orgs/org-1'],
  ['GET', '/api/orgs/org-1/members'],
  ['GET', '/api/orgs/invitations/me'],
  ['GET', '/api/orgs/org-1/invitations'],
  ['GET', '/api/jina/example.com'],
  ['GET', '/api/machines/machine/machine-1'],
  ['GET', '/api/machines/check-image'],
  ['GET', '/api/machines/machine/waitforstate/machine-1'],
  ['POST', '/api/orgs'],
  ['POST', '/api/orgs/org-1/invitations'],
  ['POST', '/api/orgs/invitations/invitation-1/accept'],
  ['POST', '/api/anthropic/messages'],
  ['POST', '/api/openai/chat/completions'],
  ['POST', '/api/groq/chat/completions'],
  ['POST', '/api/crawl'],
  ['POST', '/api/machines/deploy'],
  ['PUT', '/api/orgs/org-1'],
  ['PUT', '/api/machines/machine/machine-1/start'],
  ['PUT', '/api/machines/machine/machine-1/suspend'],
  ['PUT', '/api/machines/machine/machine-1/stop'],
  ['DELETE', '/api/orgs/org-1/members/user-1'],
  ['DELETE', '/api/machines/machine/machine-1'],
]

describe('/api routes', () => {
  test('every route is registered and reaches the jwt guard', async () => {
    const failures: string[] = []

    for (const [method, path] of ROUTES) {
      const res = await call(path, method)

      // Without a token the chain is the limiter, then isJwtAuth -> 401. Anything
      // else means the request never got that far: 404 = the table is wrong,
      // 500 = the bridge or a bound handler is broken.
      if (res.status !== 401) {
        failures.push(`${method} ${path} -> ${res.status}`)
      }
    }

    expect(failures).toEqual([])
  })

  test('a missing token reports the Express body verbatim', async () => {
    // The frontend switches on this shape, so it is not just about the status.
    const res = await call('/api/orgs')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: 'Unauthorized: Missing or invalid token',
    })
  })

  test('an invalid token yields invalid_token, not a generic 401 body', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/orgs', {
        method: 'GET',
        headers: { authorization: 'Bearer not-a-real-token' },
      }),
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'invalid_token' })
  })

  test('an unregistered method on a real path is still a 404', async () => {
    // Guards against a route registered so loosely that it swallows everything.
    expect((await call('/api/orgs', 'DELETE')).status).toBe(404)
    expect((await call('/api/nope', 'GET')).status).toBe(404)
  })

  test('the jina route keeps the url as a single param', async () => {
    // The ported route used `:url`, so a slash inside would not match. Encoded is
    // the shape the client sends.
    const res = await call('/api/jina/https%3A%2F%2Fexample.com')

    expect(res.status).toBe(401)
  })
})
