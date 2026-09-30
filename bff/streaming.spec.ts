import { describe, expect, test } from 'bun:test'
import { createBridge, runChain, toResponse } from './bridge'

/**
 * The streaming path through the bridge.
 *
 * These exist because the failure they guard against is SILENT: an SSE handler
 * whose body is buffered returns 200 with the frames in it, the client's readers
 * take their text from `partialText` on a progress event and ignore the final
 * response, and the UI simply never updates. Nothing throws, nothing logs, and the
 * request looks healthy from every angle except the one the user is looking at.
 *
 * So the assertions are about the SHAPE of the body, not just its contents.
 * @param {*} req
 * @param {*} res
 */

const sseHandler = async (req: never, res: never) => {
  const r = res as unknown as {
    setHeader: (k: string, v: unknown) => void
    flushHeaders: () => void
    write: (chunk: string) => void
    end: () => void
  }
  r.setHeader('Content-Type', 'text/event-stream')
  r.setHeader('Cache-Control', 'no-cache')
  r.flushHeaders()
  r.write('data: {"a":1}\n\n')
  r.write('data: {"a":2}\n\n')
  r.write('data: [DONE]\n\n')
  r.end()
}

/** A guard that refuses, the way `requirePaidAccess` does.
 * @param {*} req
 * @param {*} res
 */
const refusingGuard = async (req: never, res: never) => {
  const r = res as unknown as { status: (c: number) => { json: (b: unknown) => void } }
  r.status(403).json({ error: 'Payment required' })
}

const request = (): Request => new Request('http://localhost/api/job/stream/task-1')

describe('bridge streaming', () => {
  test('a handler that writes SSE produces a streamed body, not a buffer', async () => {
    const response = await runChain(
      { request: request() },
      [sseHandler as never],
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')

    // The body must be a stream: a buffered string can arrive as a single
    // `Response` event, which is exactly the case the client ignores.
    expect(response.body).not.toBeNull()
    expect(typeof (response.body as ReadableStream).getReader).toBe('function')

    const text = await response.text()
    expect(text).toContain('data: {"a":1}')
    expect(text).toContain('data: [DONE]')
  })

  test('frames arrive in the order they were written', async () => {
    const response = await runChain({ request: request() }, [sseHandler as never])
    const text = await response.text()

    const first = text.indexOf('"a":1')
    const second = text.indexOf('"a":2')
    const done = text.indexOf('[DONE]')

    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(done).toBeGreaterThan(second)
  })

  test('a refusal still returns buffered JSON with its own status, not a 200 stream', async () => {
    // The paid gate must not be reported as a successful stream. This is the
    // ordering guarantee `runChain` provides: the guard runs before the handler,
    // and a guard that answers stops the chain.
    const response = await runChain(
      { request: request() },
      [refusingGuard as never, sseHandler as never],
    )

    expect(response.status).toBe(403)
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')

    const body = await response.json() as { error?: string }
    expect(body.error).toBe('Payment required')
  })

  test('a handler that only writes and never calls end is not reported as empty', async () => {
    // `write` marks the response as sent. Express leaves it open, but this bridge
    // finalises once at the end of the chain, so a missing `end()` must not turn a
    // complete body into "Handler produced no response".
    const handler = async (req: never, res: never) => {
      const r = res as unknown as {
        setHeader: (k: string, v: unknown) => void
        write: (chunk: string) => void
      }
      r.setHeader('Content-Type', 'text/event-stream')
      r.write('data: {"only":true}\n\n')
    }

    const response = await runChain({ request: request() }, [handler as never])

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"only":true')
  })

  test('a non-streaming handler keeps its buffered JSON body', async () => {
    // The streaming branch must not capture ordinary routes.
    const handler = async (req: never, res: never) => {
      const r = res as unknown as { json: (b: unknown) => void }
      r.json({ ok: true })
    }

    const response = await runChain({ request: request() }, [handler as never])
    expect(await response.json()).toEqual({ ok: true })
  })

  test('a handler that answers nothing is still a 500, not an empty 200', () => {
    const { state } = createBridge(request(), undefined)
    const response = toResponse(state)

    expect(response.status).toBe(500)
  })
})
