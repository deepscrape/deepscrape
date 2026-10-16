/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Deploying one browser machine, through arachnefly.
 *
 * Why the BFF asks arachnefly rather than Fly directly
 * ---------------------------------------------------
 * The caller's Firebase ID token is relayed verbatim, and arachnefly re-verifies
 * it (`FireAuthMiddleware`, `interfaces/controller/middleware.go`) and stamps
 * the machine's metadata with the uid it verified. A Fly token is never handed
 * to this process, so the platform cannot deploy on a caller's behalf under an
 * identity the caller does not have — it can only ask for what the caller could
 * have asked for directly.
 *
 * Success is "a machine id came back", not "the status was 2xx"
 * ------------------------------------------------------------
 * arachnefly wraps everything in its own envelope
 * (`domain.HTTPResponse`: `{code, status, message, data, errors}`) and can
 * answer a non-2xx status whose body still names a machine, or a 2xx whose body
 * names none. Reading `data.machine_id` is the only check that tracks what
 * actually happened, so the HTTP status is carried for the log and nothing else.
 *
 * The unclosed gap this cannot see
 * --------------------------------
 * arachnefly creates the Fly machine and *then* writes its own record. If that
 * write fails it answers 500 with no machine id, so a machine can exist that
 * this function cannot name, and the caller gets a failure while the VM runs.
 * Machine names are derived from the session id (`machineNameFor`) precisely so
 * that case is reconcilable by name later — but nothing reconciles it today, and
 * this module cannot fix it from here.
 *
 * Why there is no timeout of its own
 * ----------------------------------
 * A deploy is a slow upstream call and a client will often give up first. Adding
 * a local deadline would abandon a request whose machine may already exist,
 * which is the failure above; leaving it to the runtime's own limit keeps the
 * honest thing (wait, then report what came back) in one place.
 */
import fetch, {RequestInit} from "node-fetch"
import {
  machineRequestFor,
  type BrowserMachineRequest,
} from "../domain/browser-session.domain"

/** What a deploy attempt produced. */
export type DeployMachineResult =
  | {ok: true; machineId: string}
  | {ok: false; error: string; status?: number}

/** What the caller must supply to deploy one session's machine. */
export type DeployMachineInput = {
  /** Arachnefly's base URL, resolved by the caller from config. */
  baseUrl: string
  /** The caller's Firebase ID token, relayed verbatim. */
  token: string
  /** The session the machine belongs to; also names the machine. */
  sessionId: string
  /** The container image, from config. Empty is a refusal, not a default. */
  image: string
  /** The Fly region to place the machine in. */
  region: string
  /**
   * Milliseconds to wait before each retry. Omitted takes the default policy; an
   * empty array means a single attempt and no retry at all.
   *
   * Injectable so a test can exercise the retry without sleeping through it.
   */
  retryDelaysMs?: readonly number[]
}

/**
 * How long to wait before each deploy retry. Two retries, no more.
 *
 * The shape follows the limit it exists for: Fly allows a burst of three CREATEs
 * and then one per second, so waiting a low number of seconds rides out exactly
 * the burst that produces the 429. A longer ladder would hold a caller's HTTP
 * request open for no extra benefit — past a couple of seconds the honest answer
 * is to hand back capacity_unavailable and let them come back.
 */
const DEFAULT_DEPLOY_RETRY_DELAYS_MS: readonly number[] = [1000, 3000]

/**
 * The slice of the envelope every arachnefly route wraps its reply in.
 *
 * The name is historical — it started as the deploy reply — but deploy, suspend
 * and destroy all answer with the same shape (`domain.HTTPResponse`), just with
 * different payload fields. One reader for all three is the point.
 */
type ArachneflyEnvelope = {
  status?: unknown
  message?: unknown
  data?: {machine_id?: unknown; status?: unknown} | null
  errors?: {code?: unknown; message?: unknown} | null
}

/**
 * One sentence naming an upstream refusal, for the log.
 * @param {ArachneflyEnvelope} payload The parsed envelope.
 * @param {number} status The HTTP status arachnefly answered with.
 * @param {string} missing What the reply should have carried.
 * @return {string} The sentence to report.
 */
const refusalText = (
  payload: ArachneflyEnvelope,
  status: number,
  missing: string,
): string => {
  const code = asNonEmptyString(payload.errors?.code) ?? ""
  const detail = asNonEmptyString(payload.errors?.message) ?? ""
  const named = [code, detail].filter(Boolean).join(": ")
  return named || `arachnefly answered ${status} without ${missing}`
}

/** What one arachnefly call produced. */
type ArachneflyReply =
  | {ok: true; status: number; payload: ArachneflyEnvelope}
  | {ok: false; error: string; status?: number}

/**
 * Send one request to arachnefly, and hand back its status and envelope.
 *
 * The single place the upstream is contacted, so the envelope is parsed once and
 * a second caller cannot invent its own reading of it. Never throws: every
 * caller has something to release on failure, and a thrown error is the shape
 * that gets forgotten.
 *
 * There is deliberately no timeout. A deploy is slow, a client will often give
 * up first, and a local deadline would abandon a request whose machine may
 * already exist — the failure mode this module's header describes.
 * @param {*} args The method, path and optional body.
 * @return {Promise<ArachneflyReply>} The reply, or why there is none.
 */
const callArachnefly = async (args: {
  baseUrl: string
  token: string
  method: "POST" | "PUT"
  path: string
  body?: unknown
}): Promise<ArachneflyReply> => {
  const url = `${args.baseUrl.replace(/\/+$/, "")}${args.path}`
  const options: RequestInit = {
    method: args.method,
    headers: {
      "Authorization": `Bearer ${args.token}`,
      "Content-Type": "application/json",
    },
  }
  if (args.body !== undefined) {
    options.body = JSON.stringify(args.body)
  }

  let raw: string
  let status: number
  try {
    const response = await fetch(url, options)
    status = response.status
    raw = await response.text()
  } catch (error) {
    return {ok: false, error: `arachnefly unreachable: ${String(error)}`}
  }

  try {
    const payload = JSON.parse(raw) as ArachneflyEnvelope
    return {ok: true, status: status, payload: payload}
  } catch {
    return {
      ok: false,
      status: status,
      error: "arachnefly returned a body that is not JSON",
    }
  }
}

/**
 * A non-empty string, or undefined for anything else.
 *
 * Firestore and Fly are stores, not validators, and an upstream that changes its
 * field case would otherwise produce `undefined` where an id is expected — which
 * is how a machine id ends up stored as the string "undefined".
 * @param {*} value The untrusted value.
 * @return {string | undefined} The string, or undefined.
 */
const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Deploy the machine a session needs.
 *
 * Never throws: a network failure and a refusal both come back as
 * `{ok: false}`, because every caller has to release a reservation on failure
 * and a thrown error is the shape that gets forgotten.
 * @param {DeployMachineInput} input The deploy request.
 * @return {Promise<DeployMachineResult>} The machine id, or why not.
 */
export const deployBrowserMachine = async (
  input: DeployMachineInput,
): Promise<DeployMachineResult> => {
  const image = input.image.trim()
  if (!image) {
    // Refused here rather than sent: arachnefly's `GetImageSource` answers an
    // error for an unknown option, but a blank image is our misconfiguration,
    // and failing at the last moment with Fly's message would blame the caller.
    return {ok: false, error: "browser machine image is not configured"}
  }

  // A CREATE is limited to one per second per APP with a burst of three, and every
  // tenant shares the app — so a 429 here is ordinary under load, not an
  // exception. Retrying is worth doing, and it is SAFE for one specific reason:
  // the machine is named from the session id and Fly requires a name to be unique
  // within an app, so a retry cannot produce a second machine. The worst a retry
  // can do is be refused for the duplicate name — which is also why this is the
  // one call in the platform where a blind retry is acceptable.
  const delays = input.retryDelaysMs ?? DEFAULT_DEPLOY_RETRY_DELAYS_MS
  const body: BrowserMachineRequest = machineRequestFor(
    input.sessionId,
    image,
    input.region,
  )

  let last: DeployMachineResult = {
    ok: false,
    error: "the deploy was never attempted",
  }

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1])
    }

    const result = await sendDeploy(input, body)
    if (result.ok) {
      return result
    }
    last = result

    // Only a rate limit earns another attempt: it is the one answer that says the
    // request was fine and the timing was not. A broken image or a rejected token
    // fails identically however many times it is asked, so retrying those would
    // only spend the caller's latency and multiply our load.
    if (result.status !== 429) {
      return result
    }
  }

  return last
}

/**
 * Wait, without pulling in a timer dependency.
 * @param {number} ms How long to wait.
 * @return {Promise<void>} Resolves once the wait is over.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One deploy attempt: send the request, and read the reply.
 *
 * Split out from `deployBrowserMachine` so the retry reads as a retry, and so the
 * interpretation of a reply lives in exactly one place. `sendDeploy` never
 * decides whether to try again — that is the caller's judgement, because only the
 * caller knows the policy.
 * @param {DeployMachineInput} input The deploy request.
 * @param {BrowserMachineRequest} body The body to send.
 * @return {Promise<DeployMachineResult>} The machine id, or why not.
 */
const sendDeploy = async (
  input: DeployMachineInput,
  body: BrowserMachineRequest,
): Promise<DeployMachineResult> => {
  const reply = await callArachnefly({
    baseUrl: input.baseUrl,
    token: input.token,
    method: "POST",
    path: "/api/deploy",
    body: body,
  })
  if (!reply.ok) {
    return reply.status === undefined ?
      {ok: false, error: reply.error} :
      {ok: false, error: reply.error, status: reply.status}
  }

  const machineId = asNonEmptyString(reply.payload.data?.machine_id)
  if (machineId) {
    return {ok: true, machineId: machineId}
  }

  return {
    ok: false,
    status: reply.status,
    error: refusalText(reply.payload, reply.status, "a machine id"),
  }
}

/** What the caller must supply to release one session's machine. */
export type ReleaseMachineInput = {
  /** Arachnefly's base URL, resolved by the caller from config. */
  baseUrl: string
  /** The caller's Firebase ID token, relayed verbatim. */
  token: string
  /** The Fly machine id arachnefly returned at deploy time. */
  machineId: string
}

/** Whether a machine was released. */
export type ReleaseMachineResult =
  | {ok: true}
  | {ok: false; error: string; status?: number}

/**
 * Suspend a session's machine, so it stops costing compute.
 *
 * **Suspend, not destroy, and the choice is load-bearing.** arachnefly's destroy
 * path gates on `Machine.CanDelete()`, so a machine still in a transition
 * answers 400 — and closing a session moments after opening it is exactly when
 * that happens. Suspend carries no such gate: it forwards to Fly and succeeds.
 * Suspending a running machine stops CPU and memory billing, which is the
 * dominant cost; the disk survives and goes on costing a fraction of it.
 *
 * That residual is chosen, not missed. A destroy sweep wants a TTL so it cannot
 * race a caller who reopens, and inventing that here would be a second policy
 * for the same machine.
 *
 * This exists because closing a session did NOT release its machine. The reaper
 * skips `closed` sessions by design (`ReapReasonClosed`), so a session closed
 * without this call left a running VM nothing would ever look at again — the
 * close path is the only thing that can release it, which is why the failure
 * case below refuses to mark the session closed.
 * @param {ReleaseMachineInput} input The machine to release.
 * @return {Promise<ReleaseMachineResult>} Whether it was released.
 */
export const suspendBrowserMachine = async (
  input: ReleaseMachineInput,
): Promise<ReleaseMachineResult> => {
  const machineId = input.machineId.trim()
  if (!machineId) {
    return {ok: false, error: "no machine to release"}
  }

  const reply = await callArachnefly({
    baseUrl: input.baseUrl,
    token: input.token,
    method: "PUT",
    path: `/api/machine/${encodeURIComponent(machineId)}/suspend`,
  })
  if (!reply.ok) {
    return reply.status === undefined ?
      {ok: false, error: reply.error} :
      {ok: false, error: reply.error, status: reply.status}
  }

  // A boolean, not a machine id: destroy and suspend report `data.status` where
  // deploy reports `data.machine_id`. Same envelope, different field.
  if (reply.payload.data?.status === true) {
    return {ok: true}
  }

  return {
    ok: false,
    status: reply.status,
    error: refusalText(reply.payload, reply.status, "a success status"),
  }
}

/** What the caller must supply to observe one session's machine. */
export type MachineFrameInput = {
  /** Arachnefly's base URL, resolved by the caller from config. */
  baseUrl: string
  /** The caller's Firebase ID token, relayed verbatim. */
  token: string
  /** The Fly machine id arachnefly returned at deploy time. */
  machineId: string
}

/** One frame, or why there is none. */
export type MachineFrameResult =
  | {ok: true; contentType: string; bytes: Uint8Array}
  | {ok: false; error: string; status?: number}

/**
 * The MCP request that asks a machine's own engine for one screenshot.
 *
 * Exported so the shape is testable without reaching a machine. `id` is a
 * literal rather than a counter: the transport answers one call at a time, so a
 * mismatched id would be a bug in this module, not a multiplexing concern.
 */
export const OBSERVE_FRAME_BODY = {
  jsonrpc: "2.0",
  id: "frame",
  method: "tools/call",
  params: {name: "webrain_observe", arguments: {what: "screenshot"}},
}

/**
 * Ask ONE leased machine's engine for a single screenshot of its current page.
 *
 * Why this does not go through `callArachnefly`
 * -------------------------------------------
 * That helper parses arachnefly's JSON envelope, and a frame is not JSON — it is
 * bytes. Reading it as JSON would fail, and reading the status alone would throw
 * the image away, so this is a second reader rather than a second opinion on the
 * first one. The upstream's `Content-Type` is relayed, never assumed: the engine
 * decides whether a screenshot comes back as image bytes or base64 inside a
 * JSON-RPC result, and guessing here would label it wrongly.
 *
 * Why it is safe to send a caller's token to this path
 * ---------------------------------------------------
 * `/api/machine/mcp/:id` sits behind arachnefly's ownership middleware, which
 * checks the machine against the uid that token carries. A machine id belonging
 * to another tenant is therefore a 404 upstream, so the id in the session record
 * is an address and never a credential.
 *
 * Never throws, matching its siblings: the route above it has to answer, and an
 * unhandled rejection would hold the request to its timeout instead.
 * @param {MachineFrameInput} input The machine to observe.
 * @return {Promise<MachineFrameResult>} The frame, or why not.
 */
export const observeMachineFrame = async (
  input: MachineFrameInput,
): Promise<MachineFrameResult> => {
  const machineId = input.machineId.trim()
  if (!machineId) {
    return {ok: false, error: "no machine to observe"}
  }

  const url = `${input.baseUrl.replace(/\/+$/, "")}/api/machine/mcp/` +
    encodeURIComponent(machineId)

  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.token}`,
        "Content-Type": "application/json",
        // Streamable HTTP may answer as SSE, so both are acceptable.
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(OBSERVE_FRAME_BODY),
    })
  } catch (error) {
    return {ok: false, error: `arachnefly unreachable: ${String(error)}`}
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!response.ok) {
    // Status only. The upstream body names internal services and validation
    // rules, and this is the path a caller reaches by guessing a machine id.
    return {
      ok: false,
      status: response.status,
      error: `arachnefly answered ${response.status}`,
    }
  }

  return {
    ok: true,
    contentType: response.headers.get("content-type") || "image/png",
    bytes: bytes,
  }
}

/** What the caller must supply to run one tool on a session's own machine. */
export type MachineToolInput = {
  /** Arachnefly's base URL, resolved by the caller from config. */
  baseUrl: string
  /** The caller's Firebase ID token, relayed verbatim. */
  token: string
  /** The Fly machine id arachnefly returned at deploy time. */
  machineId: string
  /** One of `SESSION_TOOLS`; the route refuses anything else long before here. */
  tool: string
  /** The tool's arguments, already stripped of anything egress-bearing. */
  args: Record<string, unknown>
}

/** One tool result, or why there is none. */
export type MachineToolResult =
  | {ok: true; json: unknown}
  | {ok: false; error: string; status?: number}

/**
 * The MCP request that runs one tool on a machine's own engine.
 *
 * Exported so the shape is testable without reaching a machine, exactly as
 * `OBSERVE_FRAME_BODY` is. `id` is a literal rather than a counter: the transport
 * answers one call at a time, so a mismatched id would be a bug in this module,
 * not a multiplexing concern.
 * @param {string} tool The MCP tool name.
 * @param {Record<string, unknown>} args The tool's arguments.
 * @return {*} The JSON-RPC body.
 */
export const machineToolBody = (
  tool: string,
  args: Record<string, unknown>,
) => ({
  jsonrpc: "2.0",
  id: "tool",
  method: "tools/call",
  params: {name: tool, arguments: args},
})

/** Streamable HTTP may answer as SSE. Returns the last `data:` payload, or the
 * body unchanged when it is already plain JSON.
 * @param {string} raw The response body.
 * @return {string} The JSON to parse.
 */
const unwrapMachineBody = (raw: string): string => {
  const dataLines = raw.split("\n").filter((line) => /^\s*data:\s*/.test(line))
  if (!dataLines.length) {
    return raw
  }
  return dataLines[dataLines.length - 1].replace(/^\s*data:\s*/, "").trim()
}

/**
 * Run ONE tool on ONE leased machine's own engine.
 *
 * The frame reader's sibling, and split from it for the reason that one gives: a
 * screenshot is BYTES and this is JSON, so reading both through one function
 * would mean one of the two readers lying about the other's payload. A tool that
 * answers bytes (a screenshot requested through `webrain_observe`) therefore
 * lands here as a JSON parse failure rather than as a corrupted success, which is
 * why the frame path keeps its own reader.
 *
 * Why it is safe to send a caller's token to this path
 * ---------------------------------------------------
 * The same argument `observeMachineFrame` makes: `/api/machine/mcp/:id` sits
 * behind arachnefly's ownership middleware, which checks the machine against the
 * uid the token carries. A machine id belonging to another tenant is a 404
 * upstream, so the id in the session record is an address and never a credential.
 *
 * Never throws, matching its siblings: the route above it has to answer, and an
 * unhandled rejection would hold the request to its timeout instead.
 * @param {MachineToolInput} input The machine and the call.
 * @return {Promise<MachineToolResult>} The parsed result, or why not.
 */
export const callMachineTool = async (
  input: MachineToolInput,
): Promise<MachineToolResult> => {
  const machineId = input.machineId.trim()
  if (!machineId) {
    return {ok: false, error: "no machine to drive"}
  }

  const url = `${input.baseUrl.replace(/\/+$/, "")}/api/machine/mcp/` +
    encodeURIComponent(machineId)

  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.token}`,
        "Content-Type": "application/json",
        // Streamable HTTP may answer as SSE, so both are acceptable.
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(machineToolBody(input.tool, input.args)),
    })
  } catch (error) {
    return {ok: false, error: `arachnefly unreachable: ${String(error)}`}
  }

  const raw = await response.text()

  if (!response.ok) {
    // Status only. The upstream body names internal services and validation
    // rules, and this is the path a caller reaches by guessing a machine id.
    return {
      ok: false,
      status: response.status,
      error: `arachnefly answered ${response.status}`,
    }
  }

  try {
    return {ok: true, json: JSON.parse(unwrapMachineBody(raw))}
  } catch {
    return {
      ok: false,
      status: response.status,
      error: "the machine did not answer JSON",
    }
  }
}
