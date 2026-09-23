import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { countConsentDecision, toVerdict } from './consent'
import { eventRoutes } from './event'

const app = new Elysia().post('/event/consent', countConsentDecision)

const post = (body: unknown) =>
  app.handle(
    new Request('http://localhost/event/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('consent decision counting', () => {
  test('only the literal granted is a grant', () => {
    expect(toVerdict('granted')).toBe('granted')
    expect(toVerdict('denied')).toBe('denied')
    // The route is unauthenticated, so everything else — including a missing body — is a
    // refusal rather than a crash or an unbounded key.
    expect(toVerdict(undefined)).toBe('denied')
    expect(toVerdict('granted.nope')).toBe('denied')
    expect(toVerdict({ toString: () => 'granted' })).toBe('denied')
    expect(toVerdict('GRANTED')).toBe('denied')
  })

  test('answers 204 without touching Redis or the device', async () => {
    const res = await post({ decision: 'denied' })

    expect(res.status).toBe(204)
    // Nothing is written back: the counter is server-side only. A future change that
    // sets a cookie or returns an id here would take this outside Art. 5(3).
    expect(res.headers.getSetCookie()).toEqual([])
  })

  test('accepts an empty body without failing the request', async () => {
    const res = await post({})

    expect(res.status).toBe(204)
  })

  test('is reachable on the telemetry group it is wired into', async () => {
    // Guards the wiring rather than the counter: a path typo leaves the number silently
    // at zero, which is the failure mode this whole change exists to remove.
    const res = await eventRoutes.handle(
      new Request('http://localhost/event/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'granted' }),
      }),
    )

    expect(res.status).toBe(204)
  })
})
