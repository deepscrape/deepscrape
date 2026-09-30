/* eslint-disable max-len */
/**
 * Guards the Arachnefly forwarding contract in `handlers/machines.ts`.
 *
 * The regression this exists for: each handler used to open-code its own
 * `catch`, and five of them answered with `message: String(error)` — which
 * embeds the upstream's entire JSON error body (internal service names,
 * validation rules, request ids). Three of the nine were fixed and six were
 * not, because there was no single place to notice the rest; `suspendMachine`
 * and `stopMachine` additionally answered with `startMachine`'s copy-pasted
 * "Failed to destroy machine" text. These tests pin the properties every
 * handler must keep:
 *
 *   1. no upstream detail ever reaches the caller;
 *   2. the upstream sees only the server-held token, never the caller's headers;
 *   3. a failure names the operation that actually failed;
 *   4. a handler never writes a second response onto a finished one.
 *
 * A real HTTP server is used rather than a mocked `node-fetch`. The handlers
 * hand it a `URL` plus a `RequestInit`, so an actual socket on an ephemeral port
 * is the least fragile fake — and it is the only way to observe (2) from the
 * receiving end.
 *
 * `../config/env` snapshots `process.env` when first imported, so the upstream
 * URL is written to `process.env` before the dynamic import below.
 */
import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type {AddressInfo} from "node:net"

/** Must never appear in a caller-facing response. */
const CANARY = "INTERNAL-LEAK-CANARY-9f3a"
/** Also upstream-only: an internal hostname and a correlation id. */
const UPSTREAM_HOST = "fly-machines-prod-01.internal"
const UPSTREAM_REQUEST_ID = "req-42"

/** Sentinel the fake upstream 500s on. Satisfies `validIdPattern`. */
const BOOM_ID = "boom"

/** A safe, non-sentinel id for happy-path assertions. */
const OK_ID = "abc123"

type Captured = {
    status: number
    body: string
    headersSent: boolean
}

let server: Server
let upstreamBase: string
let lastUpstream: { url?: string; headers: IncomingHttpHeaders } | undefined
let arachnefly: typeof import("./machines").arachnefly

const next = (() => undefined) as any

/**
 * Minimal Express-`Response` stand-in covering only the surface these handlers
 * touch: `type`, `status`, `json`, `writeHead`, `end`, `headersSent`.
 * @return {*} the fake response and the buffer it wrote into.
 */
const createRes = (): { res: any; captured: Captured } => {
  const captured: Captured = {status: 200, body: "", headersSent: false}
  const res: any = {
    type: () => res,
    status: (code: number) => {
      captured.status = code
      return res
    },
    json: (payload: unknown) => {
      captured.body = JSON.stringify(payload)
      captured.headersSent = true
      return res
    },
    writeHead: (code: number) => {
      captured.status = code
      captured.headersSent = true
      return res
    },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) {
        captured.body = String(chunk)
      }
      return res
    },
    /**
     * headersSent
     */
    get headersSent() {
      return captured.headersSent
    },
  }
  return {res, captured}
}

/**
 * Fake inbound request. `token` stands in for the caller's RAW Firebase ID
 * token, which the middleware chain (`isJwtAuth`) now puts on the PER-REQUEST
 * `req.authToken`.
 *
 * It used to stand in for `req.app.locals["user"]`. That object belongs to the
 * Express APPLICATION, not the request — created once per process and shared by
 * every concurrent request — so one tenant's token was readable by another
 * tenant's in-flight request. Spying the per-request slot is what makes the
 * `forwards the server-held token` assertion below meaningful: it proves the
 * credential that reaches the upstream is the one bound to THIS request.
 * @options.params path parameters, e.g. `req.params.id`.
 * @options.query query parameters, e.g. `req.query.name`.
 * @options.body request body, e.g. `req.body`.
 * @options.token the caller's raw Firebase ID token for this request.
 * @options.headers any other headers to include in the request.
 * @return {*} an object satisfying the handlers' `req` usage.
 * @param {*} options
 */
const createReq = (options: {
    params?: Record<string, string>
    query?: Record<string, unknown>
    body?: unknown
    token?: string
    headers?: Record<string, string>
}): any => ({
  params: options.params ?? {},
  query: options.query ?? {},
  body: options.body,
  headers: options.headers ?? {},
  authToken: options.token ?? "server-held-token",
})

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastUpstream = {url: req.url, headers: req.headers}

    if (req.url?.includes(BOOM_ID)) {
      res.writeHead(500, {"Content-Type": "application/json"})
      res.end(JSON.stringify({
        code: "InternalError",
        internal_message: CANARY,
        requestId: UPSTREAM_REQUEST_ID,
        upstream: UPSTREAM_HOST,
      }))
      return
    }

    res.writeHead(200, {"Content-Type": "application/json"})
    res.end(JSON.stringify({ok: true, upstreamPath: req.url}))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const {port} = server.address() as AddressInfo
  upstreamBase = `http://127.0.0.1:${port}`

  process.env.PRODUCTION = "true"
  process.env.API_ARACHNEFLY_URL = upstreamBase

  ;({arachnefly} = await import("./machines"))
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * Every method that talks to Arachnefly, each building the request that steers
 * it into the upstream's failure path. Table-driven so a new handler added
 * without a leak test is conspicuous by its absence.
 */
const FAILING_CASES: Array<{
    name: string
    build: () => { req: any; call: (req: any, res: any) => Promise<unknown> }
}> = [
  {
    name: "getMachine",
    build: () => ({
      req: createReq({params: {id: BOOM_ID}}),
      call: (req, res) => arachnefly.getMachine(req, res, next),
    }),
  },
  {
    name: "checkImageDeployability",
    build: () => ({
      req: createReq({query: {name: BOOM_ID}}),
      call: (req, res) => arachnefly.checkImageDeployability(req, res, next),
    }),
  },
  {
    name: "waitForState",
    build: () => ({
      req: createReq({
        params: {machineId: BOOM_ID},
        query: {state: "started", instance_id: "inst-1"},
      }),
      call: (req, res) => arachnefly.waitForState(req, res, next),
    }),
  },
  {
    name: "startMachine",
    build: () => ({
      req: createReq({params: {machineId: BOOM_ID}}),
      call: (req, res) => arachnefly.startMachine(req, res),
    }),
  },
  {
    name: "suspendMachine",
    build: () => ({
      req: createReq({params: {machineId: BOOM_ID}}),
      call: (req, res) => arachnefly.suspendMachine(req, res),
    }),
  },
  {
    name: "stopMachine",
    build: () => ({
      req: createReq({params: {machineId: BOOM_ID}}),
      call: (req, res) => arachnefly.stopMachine(req, res),
    }),
  },
  {
    name: "destroyMachine",
    build: () => ({
      req: createReq({params: {machineId: BOOM_ID}, query: {force: "true"}}),
      call: (req, res) => arachnefly.destroyMachine(req, res),
    }),
  },
  {
    name: "executeTask",
    build: () => ({
      req: createReq({params: {machineId: BOOM_ID}, body: {}}),
      call: (req, res) => arachnefly.executeTask(req, res, next),
    }),
  },
]

describe("machines: upstream failures never reach the caller", () => {
  for (const testCase of FAILING_CASES) {
    it(`${testCase.name} withholds the upstream body`, async () => {
      const {req, call} = testCase.build()
      const {res, captured} = createRes()

      await call(req, res)

      assert.equal(captured.status, 500)
      assert.ok(
        !captured.body.includes(CANARY),
        `${testCase.name} leaked the upstream message: ${captured.body}`,
      )
      assert.ok(
        !captured.body.includes(UPSTREAM_HOST),
        `${testCase.name} leaked an internal hostname: ${captured.body}`,
      )
      assert.ok(
        !captured.body.includes(UPSTREAM_REQUEST_ID),
        `${testCase.name} leaked the upstream request id: ${captured.body}`,
      )
    })
  }

  it("names the operation that failed, not a copy-pasted sibling", async () => {
    const suspend = createRes()
    await arachnefly.suspendMachine(
      createReq({params: {machineId: BOOM_ID}}),
      suspend.res,
    )
    assert.match(suspend.captured.body, /suspend/i)
    assert.doesNotMatch(suspend.captured.body, /destroy/i)

    const stop = createRes()
    await arachnefly.stopMachine(createReq({params: {machineId: BOOM_ID}}), stop.res)
    assert.match(stop.captured.body, /stop/i)
    assert.doesNotMatch(stop.captured.body, /destroy/i)
  })

  it("does not write a second response when one was already sent", async () => {
    const {res, captured} = createRes()
    res.json({error: "already answered"})

    await arachnefly.startMachine(createReq({params: {machineId: BOOM_ID}}), res)

    assert.equal(captured.body, JSON.stringify({error: "already answered"}))
  })
})

describe("machines: the upstream sees the server, not the caller", () => {
  it("forwards the server-held token", async () => {
    const {res} = createRes()
    await arachnefly.getMachine(
      createReq({params: {id: OK_ID}, token: "server-held-token"}),
      res,
      next,
    )

    assert.equal(lastUpstream?.headers.authorization, "Bearer server-held-token")
  })

  it("drops the caller's host, cookie and authorization", async () => {
    const {res} = createRes()
    const req = createReq({params: {id: OK_ID}})
    // What an attacker would send hoping for a header relay.
    req.headers = {
      host: "evil.example",
      cookie: "sid=stolen; _csrf_secret=stolen",
      authorization: "Bearer attacker-token",
    }

    await arachnefly.getMachine(req, res, next)

    // `host` must be the address we dialed, not the caller's claim.
    assert.match(String(lastUpstream?.headers.host), /^127\.0\.0\.1:\d+$/)
    assert.equal(lastUpstream?.headers.cookie, undefined)
    assert.equal(lastUpstream?.headers.authorization, "Bearer server-held-token")
  })
})

describe("machines: request validation", () => {
  it("rejects an id longer than the path ceiling", async () => {
    const {res, captured} = createRes()
    await arachnefly.getMachine(
      createReq({params: {id: "a".repeat(65)}}),
      res,
      next,
    )
    assert.equal(captured.status, 400)
    assert.equal(lastUpstream?.url?.includes("a".repeat(65)), false)
  })

  it("reports a missing id as missing, not as malformed", async () => {
    const {res, captured} = createRes()
    await arachnefly.stopMachine(createReq({params: {}}), res)

    assert.equal(captured.status, 400)
    assert.match(captured.body, /Missing required parameter/)
  })

  it("rejects an id that would escape its path segment", async () => {
    const {res, captured} = createRes()
    await arachnefly.startMachine(
      createReq({params: {machineId: "../../etc/passwd"}}),
      res,
    )

    assert.equal(captured.status, 400)
    assert.doesNotMatch(String(lastUpstream?.url), /passwd/)
  })
})

describe("machines: happy path", () => {
  it("passes the upstream body through unchanged", async () => {
    const {res, captured} = createRes()
    await arachnefly.getMachine(createReq({params: {id: OK_ID}}), res, next)

    assert.equal(captured.status, 200)
    const parsed = JSON.parse(captured.body)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.upstreamPath, `/api/machine/${OK_ID}`)
  })

  it("maps each operation onto the arachnefly route it owns", async () => {
    const expectations: Array<[string, string]> = [
      ["startMachine", `/api/machine/${OK_ID}/start`],
      ["suspendMachine", `/api/machine/${OK_ID}/suspend`],
      ["stopMachine", `/api/machine/${OK_ID}/stop`],
    ]

    for (const [method, expectedPath] of expectations) {
      const {res} = createRes()
      await (arachnefly as any)[method](createReq({params: {machineId: OK_ID}}), res)
      assert.equal(lastUpstream?.url, expectedPath)
    }
  })
})
