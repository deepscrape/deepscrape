/* eslint-disable max-len */
/**
 * Pins how the platform reads arachnefly's answer to a deploy.
 *
 * A real HTTP server on an ephemeral port rather than a mocked `node-fetch`,
 * following `handlers/machines.spec.ts`: it is the only way to observe what the
 * upstream actually receives, and it cannot drift from the real client.
 * `deployBrowserMachine` takes its base URL as an argument, so no environment
 * variable has to be set before the import — the fake is handed straight in.
 *
 * The load-bearing rule is that SUCCESS IS "A MACHINE ID CAME BACK", not "the
 * status was 2xx". arachnefly wraps its replies in its own envelope, so a body
 * can name a machine under a non-2xx status and, far more dangerously, a 200
 * can name none. Both directions are pinned below.
 */
import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http"
import type {AddressInfo} from "node:net"
import {
  OBSERVE_FRAME_BODY,
  deployBrowserMachine,
  observeMachineFrame,
  suspendBrowserMachine,
} from "./browser-session.provisioner"

/** What the fake upstream saw on the last request. */
type Seen = {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

let server: Server
let baseUrl: string
let seen: Seen | undefined

/**
 * The default answer: an empty 200.
 * @param {ServerResponse} res The response.
 */
const emptyOk = (res: ServerResponse): void => {
  res.writeHead(200, {"Content-Type": "application/json"})
  res.end("{}")
}

/** How the fake upstream answers the next request. Replaced per test. */
let respond: (res: ServerResponse) => void = emptyOk

/**
 * Answer with a JSON body.
 * @param {ServerResponse} res The response.
 * @param {number} status The HTTP status to send.
 * @param {unknown} payload The body to serialise.
 */
const json = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, {"Content-Type": "application/json"})
  res.end(JSON.stringify(payload))
}

/**
 * The arachnefly envelope around a successful deploy.
 * @param {string} machineId The machine id to report.
 * @return {*} The envelope body.
 */
const deployed = (machineId: string) => ({
  code: 200,
  status: "success",
  message: "Machine deployed Successful",
  data: {
    status: true,
    message: "Machine deployed",
    machine_id: machineId,
  },
})

/**
 * Call the provisioner with the fake upstream and sensible defaults.
 * @param {Record<string, unknown>} overrides Fields to replace.
 * @return {*} The deploy result.
 */
const deploy = (overrides: Record<string, unknown> = {}) =>
  deployBrowserMachine({
    baseUrl: baseUrl,
    token: "caller-firebase-id-token",
    sessionId: "session-1",
    image: "registry.example/browser:1",
    region: "iad",
    ...overrides,
  })

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      seen = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }
      respond(res)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const {port} = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("deployBrowserMachine", () => {
  it("returns the machine id arachnefly reported", async () => {
    respond = (res) => json(res, 200, deployed("machine-abc"))
    const result = await deploy()

    assert.equal(result.ok, true)
    assert.equal(result.ok && result.machineId, "machine-abc")
  })

  it("relays the caller's token and posts the deploy body", async () => {
    respond = (res) => json(res, 200, deployed("machine-abc"))
    await deploy()

    assert.equal(seen?.method, "POST")
    assert.equal(seen?.url, "/api/deploy")
    // The caller's OWN token, verbatim: arachnefly re-verifies it and stamps the
    // machine with the uid it verified, so the platform never deploys under an
    // identity the caller does not hold.
    assert.equal(
      seen?.headers["authorization"],
      "Bearer caller-firebase-id-token",
    )

    const body = JSON.parse(seen?.body ?? "{}")
    assert.equal(body.machineName, "bs-session-1")
    assert.equal(body.imageOption, "default")
    assert.equal(body.defaultImage, "registry.example/browser:1")
    assert.equal(body.region, "iad")
    assert.equal(body.autoStop, "suspend")
    assert.equal(body.autoStart, true)
  })

  it("accepts a machine id even when the status is not 2xx", async () => {
    // arachnefly can create the machine and then fail its own bookkeeping, and
    // the status it sends is its own envelope's. Reading the id is the only
    // check that tracks what happened; a machine that exists is not a failure.
    respond = (res) => json(res, 500, deployed("machine-abc"))
    const result = await deploy()

    assert.equal(result.ok, true)
    assert.equal(result.ok && result.machineId, "machine-abc")
  })

  it("refuses a 2xx that names no machine", async () => {
    // The dangerous inverse: believing this succeeded would store an undefined
    // machine id and leave a session that looks provisioned and has nothing.
    respond = (res) =>
      json(res, 200, {status: "success", code: 200, data: {status: true}})

    const result = await deploy()

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.status, 200)
  })

  it("names the upstream error code and message when refused", async () => {
    respond = (res) =>
      json(res, 400, {
        code: 400,
        status: "error",
        errors: {code: "Parse Error", message: "invalid image option"},
        data: {status: false},
      })

    const result = await deploy()

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.status, 400)
    assert.match(result.ok === false ? result.error : "", /Parse Error/)
    assert.match(result.ok === false ? result.error : "", /invalid image option/)
  })

  it("survives a body that is not JSON", async () => {
    respond = (res) => {
      res.writeHead(502, {"Content-Type": "text/html"})
      res.end("<html>bad gateway</html>")
    }

    const result = await deploy()

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.status, 502)
    assert.match(result.ok === false ? result.error : "", /not JSON/)
  })

  it("reports an unreachable upstream instead of throwing", async () => {
    // Every caller releases a credit reservation on failure, so a thrown error
    // is the shape that gets forgotten.
    const result = await deploy({baseUrl: "http://127.0.0.1:1"})

    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : "", /unreachable/)
  })

  it("refuses a blank image before making any request", async () => {
    // A blank image is our misconfiguration. Failing here keeps Fly's message
    // from being reported as though the caller caused it.
    seen = undefined
    respond = (res) => json(res, 200, deployed("machine-abc"))

    const result = await deploy({image: "   "})

    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : "", /not configured/)
    assert.equal(seen, undefined)
  })

  it("does not double the slash when the base URL ends in one", async () => {
    respond = (res) => json(res, 200, deployed("machine-abc"))
    await deploy({baseUrl: `${baseUrl}/`})

    assert.equal(seen?.url, "/api/deploy")
  })
})

/**
 * Releasing a machine, which is what makes `close` stop costing money.
 *
 * The bug this guards: a session closed without releasing its machine left a
 * running VM the reaper could never see, because `DecideReap` skips `closed`
 * sessions by design. These pin the two things that keep that from returning —
 * the request really reaches arachnefly's suspend route, and a reply that is not
 * a success is never read as one.
 */
describe("suspendBrowserMachine", () => {
  /**
   * Call the releaser with the fake upstream and sensible defaults.
   * @param {Record<string, unknown>} overrides Fields to replace.
   * @return {*} The release result.
   */
  const release = (overrides: Record<string, unknown> = {}) =>
    suspendBrowserMachine({
      baseUrl: baseUrl,
      token: "caller-firebase-id-token",
      machineId: "machine-abc",
      ...overrides,
    })

  it("PUTs arachnefly's suspend route with the caller's token", async () => {
    respond = (res) =>
      json(res, 200, {code: 200, status: "success", data: {status: true}})

    const result = await release()

    assert.equal(result.ok, true)
    // PUT, not POST. arachnefly registers this as `authedApp.Put`, so a POST is
    // a 405 — the kind of edit that looks harmless in a diff.
    assert.equal(seen?.method, "PUT")
    assert.equal(seen?.url, "/api/machine/machine-abc/suspend")
    assert.equal(
      seen?.headers["authorization"],
      "Bearer caller-firebase-id-token",
    )
  })

  it("accepts a success reported under a non-2xx status", async () => {
    respond = (res) =>
      json(res, 500, {code: 500, status: "error", data: {status: true}})

    assert.equal((await release()).ok, true)
  })

  it("refuses a 2xx that reports no success", async () => {
    // The dangerous inverse: reading this as released would mark the session
    // closed and walk away from a machine that is still running.
    respond = (res) =>
      json(res, 200, {code: 200, status: "success", data: {}})

    const result = await release()

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.status, 200)
  })

  it("names the upstream error when the suspend was refused", async () => {
    respond = (res) =>
      json(res, 500, {
        code: 500,
        status: "error",
        errors: {code: "suspendMachineError", message: "machine not found"},
        data: {status: false},
      })

    const result = await release()

    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : "", /suspendMachineError/)
    assert.equal(result.ok === false && result.status, 500)
  })

  it("refuses a blank machine id before making any request", async () => {
    seen = undefined
    respond = (res) => json(res, 200, {data: {status: true}})

    const result = await release({machineId: "  "})

    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : "", /no machine/)
    assert.equal(seen, undefined)
  })

  it("reports an unreachable upstream instead of throwing", async () => {
    const result = await release({baseUrl: "http://127.0.0.1:1"})

    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : "", /unreachable/)
  })

  it("does not let a slash in the id reshape the path", async () => {
    respond = (res) => json(res, 200, {data: {status: true}})
    await release({machineId: "a/b"})

    assert.equal(seen?.url, "/api/machine/a%2Fb/suspend")
  })
})

/**
 * The deploy retry policy.
 *
 * A CREATE is limited to one per second per app with a burst of three, and every
 * tenant shares the app, so a 429 is an ordinary answer under load rather than an
 * exception. These pin both halves of that: a rate limit IS retried — with an
 * injectable delay, so no test sleeps — and nothing else is, because a broken
 * image fails identically however many times it is asked and retrying it would
 * only spend the caller's latency.
 *
 * Retrying this call is safe for a reason the assertions do not show: the machine
 * is named from the session id, and Fly requires a name to be unique within an
 * app, so a retry cannot create a second machine.
 */
describe("deploy retry policy", () => {
  /**
   * Answer each incoming attempt, and count them.
   * @param {*} answer Called with the response and the 1-based attempt number.
   * @return {*} A function returning how many attempts have been made.
   */
  const countingResponder = (
    answer: (res: ServerResponse, attempt: number) => void,
  ): (() => number) => {
    let calls = 0
    respond = (res) => {
      calls++
      answer(res, calls)
    }
    return () => calls
  }

  it("retries a rate-limited deploy, then succeeds", async () => {
    const calls = countingResponder((res, attempt) => {
      if (attempt === 1) {
        json(res, 429, {
          code: 429,
          status: "error",
          errors: {
            code: "Deploy by FlyRequest Failed",
            message: "fly api answered 429",
          },
        })
        return
      }
      json(res, 200, deployed("machine-abc"))
    })

    const result = await deploy({retryDelaysMs: [0, 0]})

    assert.equal(result.ok, true)
    assert.equal(result.ok && result.machineId, "machine-abc")
    assert.equal(calls(), 2)
  })

  it("does not retry a failure that is not a rate limit", async () => {
    const calls = countingResponder((res) => {
      json(res, 500, {
        code: 500,
        status: "error",
        errors: {code: "Parse Error", message: "invalid image option"},
        data: {status: false},
      })
    })

    const result = await deploy({retryDelaysMs: [0, 0]})

    assert.equal(result.ok, false)
    // One attempt, not three: asking again cannot turn a rejected image into an
    // accepted one, so the extra attempts would be latency for nothing.
    assert.equal(calls(), 1)
  })

  it("gives up after the configured attempts, reporting the last failure", async () => {
    const calls = countingResponder((res) => {
      json(res, 429, {
        code: 429,
        status: "error",
        errors: {
          code: "Deploy by FlyRequest Failed",
          message: "fly api answered 429",
        },
      })
    })

    const result = await deploy({retryDelaysMs: [0, 0]})

    assert.equal(result.ok, false)
    // Three attempts: the first, plus two retries.
    assert.equal(calls(), 3)
    // The status has to survive all the way out, because that is what turns this
    // into a 503 capacity_unavailable rather than a 502 deploy_failed.
    assert.equal(result.ok === false && result.status, 429)
  })

  it("makes exactly one attempt when retries are disabled", async () => {
    const calls = countingResponder((res) => {
      json(res, 429, {
        code: 429,
        status: "error",
        errors: {
          code: "Deploy by FlyRequest Failed",
          message: "fly api answered 429",
        },
      })
    })

    await deploy({retryDelaysMs: []})

    // An empty policy means "no retry", not "fall back to the default" — the
    // distinction a caller reaches for when they need to fail fast.
    assert.equal(calls(), 1)
  })
})

/**
 * The frame transport.
 *
 * The bug this guards: a screenshot is BYTES and every other arachnefly reply
 * this module reads is JSON. Reading a frame with the envelope reader would fail
 * on all of them, and reading the status alone would throw the image away. So
 * what is pinned is that the bytes and the upstream's OWN Content-Type survive,
 * that a JSON answer is not relabelled an image, and that a refusal never
 * becomes a frame.
 */
describe("observeMachineFrame", () => {
  /**
   * Call the observer with the fake upstream and sensible defaults.
   * @param {Record<string, unknown>} overrides Fields to replace.
   * @return {*} The frame result.
   */
  const frame = (overrides: Record<string, unknown> = {}) =>
    observeMachineFrame({
      baseUrl: baseUrl,
      token: "caller-firebase-id-token",
      machineId: "machine-abc",
      ...overrides,
    })

  it("POSTs the machine's MCP route with the caller's token", async () => {
    respond = (res) => {
      res.writeHead(200, {"Content-Type": "image/png"})
      res.end(Buffer.from([137, 80, 78, 71]))
    }

    const result = await frame()

    assert.equal(result.ok, true)
    assert.equal(seen?.method, "POST")
    assert.equal(seen?.url, "/api/machine/mcp/machine-abc")
    assert.equal(
      seen?.headers["authorization"],
      "Bearer caller-firebase-id-token",
    )
    // The body is the observe call itself: arachnefly forwards it verbatim to
    // the engine, so a bare POST here would be a silent no-op.
    assert.deepEqual(JSON.parse(seen?.body ?? "{}"), OBSERVE_FRAME_BODY)
  })

  it("relays the bytes and the upstream's content type unchanged", async () => {
    const png = [137, 80, 78, 71, 13, 10, 26, 10]
    respond = (res) => {
      res.writeHead(200, {"Content-Type": "image/png"})
      res.end(Buffer.from(png))
    }

    const result = await frame()

    // Narrowed before the payload is read, so a failure reports which arm the
    // union actually took rather than a TypeError.
    if (!result.ok) throw new Error("expected a frame")
    assert.equal(result.contentType, "image/png")
    assert.deepEqual(Array.from(result.bytes), png)
  })

  it("keeps a JSON answer's content type rather than assuming an image", async () => {
    // The engine may answer base64 inside a JSON-RPC result. Labelling that
    // `image/png` would hand the browser bytes it cannot render.
    respond = (res) =>
      json(res, 200, {jsonrpc: "2.0", id: "frame", result: {content: []}})

    const result = await frame()

    if (!result.ok) throw new Error("expected a frame")
    assert.match(result.contentType, /application\/json/)
  })

  it("never reads a non-2xx as a frame", async () => {
    respond = (res) =>
      json(res, 502, {
        error: "INTERNAL-LEAK-CANARY-9f3a",
        upstream: "fly-machines-prod-01.internal",
      })

    const result = await frame()

    // The dangerous inverse: treating this as a frame would serve the caller
    // another tenant's screen, or an empty image, with a 200.
    if (result.ok) throw new Error("a refusal must not be a frame")
    assert.equal(result.status, 502)
    // The upstream body names internal hosts. It is logged, never relayed.
    assert.ok(!result.error.includes("INTERNAL-LEAK-CANARY"))
    assert.ok(!result.error.includes("fly-machines-prod-01"))
  })

  it("refuses an empty machine id without calling upstream", async () => {
    respond = () => {
      throw new Error("upstream must not be reached for a blank machine id")
    }

    const result = await frame({machineId: "   "})

    if (result.ok) throw new Error("a blank machine id must refuse")
    assert.match(result.error, /no machine to observe/)
  })
})
