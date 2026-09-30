/* eslint-disable max-len */
import {after, describe, it} from "node:test"
import assert from "node:assert/strict"
import {createServer, type Server, type ServerResponse} from "node:http"
import {Writable} from "node:stream"
import type {Request, Response} from "express"
import {env} from "../config/env"
import {crawl4aiCore} from "./ai_handler"

/**
 * Transport checks for the crawl handler.
 *
 * These pin the two things that were wrong before: the response claimed
 * `application/octet-stream` for a JSON body (forcing the client to buffer an
 * arraybuffer and `JSON.parse` it by hand), and the body was fully buffered
 * before being written. A content-type that lies and a buffered body are both
 * invisible to a type-check and to a build, so they need a run.
 *
 * The handler reads `env.API_CRAWL4AI_URL` per call, so the test points that at a
 * local server. `as const` in `config/env.ts` is a type assertion, not
 * `Object.freeze`, so the write holds at runtime.
 */
const ENV_KEY = "API_CRAWL4AI_URL"
const originalCrawlUrl = (env as unknown as Record<string, string>)[ENV_KEY]

const pointAt = (port: number): void => {
  (env as unknown as Record<string, string>)[ENV_KEY] = `http://127.0.0.1:${port}`
}

/** Conditions captured off the fake response. */
type ResState = {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    headersSent: boolean
    statusCalled: number
    jsonBody: unknown
}

/**
 * A `res` that satisfies both surfaces the handler needs: the express methods it
 * calls, and a Writable for `pipeline()` to pipe the upstream body into.
 *
 * @return {*} The fake response, its captured state, and a body reader.
 */
const makeRes = () => {
  const chunks: Buffer[] = []
  const state: ResState = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    statusCalled: 0,
    jsonBody: undefined,
  }

  const sink = new Writable({
    /**
     * write
     * @param {*} chunk
     * @param {*} _enc
     * @param {*} cb
     */
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })

  const res = sink as unknown as Record<string, unknown>

  res["writeHead"] = (status: number, headers: Record<string, string>) => {
    state.statusCode = status
    state.headers = headers
    state.headersSent = true
    return res
  }
  res["status"] = (code: number) => {
    state.statusCalled = code
    return res
  }
  res["json"] = (payload: unknown) => {
    state.jsonBody = payload
    return res
  }
  // A getter, not a value: Object.assign would snapshot it before writeHead runs.
  Object.defineProperty(res, "headersSent", {get: () => state.headersSent})

  return {res: res as unknown as Response, state, body: () => Buffer.concat(chunks).toString("utf8")}
}

const req = {
  body: {urls: ["https://example.com"]},
  headers: {},
  app: {locals: {}},
} as unknown as Request

/** Runs `run` against a throwaway upstream bound to an ephemeral port.
 * @param {*} handler
 * @param {*} run
 */
const withUpstream = async (
  handler: (res: ServerResponse) => void,
  run: (port: number) => Promise<void>,
): Promise<void> => {
  const server: Server = createServer((_req, res) => handler(res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const {port} = server.address() as { port: number }

  try {
    await run(port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe("crawl4aiCore transport", () => {
  after(() => {
    (env as unknown as Record<string, string>)[ENV_KEY] = originalCrawlUrl
  })

  const upstreamJson = "{\"data\":{\"content\":\"first-second\"}}"

  it("forwards the upstream content-type instead of claiming octet-stream", async () => {
    await withUpstream(
      (up) => {
        up.writeHead(200, {"Content-Type": "application/json"})
        up.end(upstreamJson)
      },
      async (port) => {
        pointAt(port)
        const {res, state} = makeRes()

        await crawl4aiCore(req, res)

        assert.equal(state.headers["Content-Type"], "application/json")
        // The old shape declared the length of a body it had already
        // buffered; a piped response has no length to declare.
        assert.equal("Content-Length" in state.headers, false)
      },
    )
  })

  it("delivers the whole upstream body unchanged", async () => {
    await withUpstream(
      (up) => {
        up.writeHead(200, {"Content-Type": "application/json"})
        // Two writes with no Content-Length: the client can only see a
        // complete body if the handler pipes rather than truncates.
        up.write("{\"data\":{\"content\":\"first-")
        up.end("second\"}}")
      },
      async (port) => {
        pointAt(port)
        const {res, body} = makeRes()

        await crawl4aiCore(req, res)

        assert.equal(body(), upstreamJson)
      },
    )
  })

  it("answers 500 without throwing when the upstream fails", async () => {
    await withUpstream(
      (up) => {
        up.writeHead(500, {"Content-Type": "application/json"})
        up.end("{\"error\":\"upstream\"}")
      },
      async (port) => {
        pointAt(port)
        const {res, state} = makeRes()

        // Must resolve, not reject: an unhandled throw here is a hung request.
        await crawl4aiCore(req, res)

        assert.equal(state.statusCalled, 500)
        assert.deepEqual(state.jsonBody, {error: "Failed to stream on crawl API"})
      },
    )
  })
})
