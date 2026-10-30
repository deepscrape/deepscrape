/**
 * The queue's delivery endpoints refuse anything unsigned.
 *
 * This is the direction a green build cannot see: if verification regressed,
 * the worker would be an open endpoint that writes into any tenant's job
 * document on demand, and nothing else in the suite would notice.
 *
 * It also proves the raw body is readable here. A 401 means `request.text()`
 * returned the bytes; Elysia having already consumed the body would surface as
 * a 500 instead — which is why the assertion is on 401 and not merely "not
 * 200". That distinction is the whole point of this file.
 */
import { describe, expect, test } from 'bun:test'
import { api } from './api'

const target = { uid: 'u1', taskId: 't1', url: 'https://example.test' }

const post = (
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> =>
  api.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(target),
    }),
  )

describe('the queue delivery endpoints', () => {
  test('refuse a worker delivery with no signature', async () => {
    const res = await post('/api/jobs/crawl/worker')

    expect(res.status).toBe(401)
  })

  test('answer 503, not 401, to a signature it cannot verify', async () => {
    // 401 is what a forged signature deserves, but it is also what a ROTATED
    // signing key produces, and QStash retires a message on 4xx: the job then
    // hangs In Progress with no DLQ entry. 503 costs a retry and leaves the fault
    // visible in the DLQ, which is the failure a human can actually find.
    // The refusal itself is unchanged — no work is done for an unverified body.
    const res = await post('/api/jobs/crawl/worker', {
      'upstash-signature':
        'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJVcHN0YXNoIn0.deadbeef',
    })

    expect(res.status).toBe(503)
  })

  test('refuse a failure report with no signature', async () => {
    const res = await post('/api/jobs/crawl/failed')

    expect(res.status).toBe(401)
  })
})
