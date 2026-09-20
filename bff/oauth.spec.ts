import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { oauthRoutes } from './oauth'

const app = new Elysia().use(oauthRoutes)

const call = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init))

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('/oauth routes', () => {
  test('a path param reaches the handler instead of 404ing', async () => {
    // Proves params plumbing without touching Firestore: an invalid address is
    // rejected by the handler's own validation before any lookup.
    const res = await call('/oauth/provider/email/not-an-email')

    expect(res.status).not.toBe(404)
    expect(res.status).toBe(400)
    // Shape is { error, message }; asserting only the error key keeps this from
    // breaking on copy changes.
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'Invalid email format',
    })
  })

  test('a jwt-guarded route rejects a missing token with 401', async () => {
    const res = await post('/oauth/email/verification', { uid: 'x' })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: 'Unauthorized: Missing or invalid token',
    })
  })

  test('an invalid token yields invalid_token, not a generic 401 body', async () => {
    // The client switches on `code`, so the shape matters as much as the status.
    const res = await post(
      '/oauth/email/verification',
      { uid: 'x' },
      { authorization: 'Bearer not-a-real-token' },
    )
    const body = (await res.json()) as { code?: string }

    expect(res.status).toBe(401)
    expect(body.code).toBe('invalid_token')
  })

  test('all eight routes are registered', async () => {
    // The email lookup is a GET; the other seven are POST. Hitting the GET with a
    // POST legitimately 404s, so check it separately.
    expect((await call('/oauth/provider/email/x')).status).not.toBe(404)

    const postPaths = [
      '/oauth/resolve-identifier',
      '/oauth/provider/phone/check',
      '/oauth/verify-login',
      '/oauth/email/verification',
      '/oauth/phone/verify',
      '/oauth/phone/link',
      '/oauth/phone/update-verification',
    ]

    for (const path of postPaths) {
      const res = await post(path, {})
      expect(res.status).not.toBe(404)
    }
  })
})
