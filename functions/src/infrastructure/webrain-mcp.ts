/* eslint-disable object-curly-spacing */
/**
 * MCP-over-HTTP client for webrain.
 *
 * Why a client rather than a second REST API
 * -----------------------------------------
 * webrain's contract is MCP; it has no REST surface and the platform plan is
 * explicit that adding one would be "a second thing to keep in sync". So this
 * speaks JSON-RPC 2.0 to the worker and unwraps its result envelope.
 *
 * What the transport actually looks like (verified against a running binary,
 * `scripts/probe-webrain-mcp.ps1` — 11/11):
 *
 *  - `POST /` with a JSON-RPC body. Streamable HTTP means the answer may come
 *    back as SSE, so the response is read as text and the LAST `data:` line is
 * taken as this request's reply. Taking the first would pick up a notification.
 *  - `Accept` must include both `application/json` and `text/event-stream`.
 * - `Authorization: Bearer <token>` is enforced only when the worker was
 * started
 * with `WEBRAIN_HTTP_TOKEN`; an unset token here therefore sends no header, and
 *    that is the correct local behaviour.
 *  - No `initialize` handshake is needed: `tools/list` and `tools/call` are
 *    dispatched directly (observed, not assumed).
 *  - Every result carries a size stamp, the basis for per-tenant accounting, so
 * it is surfaced rather than dropped. It is an OBJECT, not a number — observed
 * as `{"chars":884,"est_tokens":234}` — and the field is `est_tokens`, i.e. an
 * estimate. Treat it as a billing proxy, not a figure to reconcile to the
 * token.
 *
 * Two refusals are deliberately distinguished from generic failures:
 *
 *  - `noStateRefused` — the worker is a SHARED instance (`WEBRAIN_NO_STATE=1`)
 *    and this tool is one of its three stateful names. The caller must show
 *    "upgrade / own container", not "something broke".
 *  - `transportError` — the worker was unreachable. A missing
 * `WEBRAIN_MCP_URL` lands here on purpose: there is no default host, because a
 *    default is how an arbitrary worker gets used without anyone choosing it.
 */

import fetch, { RequestInit } from "node-fetch"
import { env } from "../config/env"
import { withPlatformProxy } from "../domain/webrain-proxy.domain"
import {
  decideWebrainTool,
  isEndpointCookieCall,
  needsCallerOwnWorker,
  needsExclusiveWorker,
  webrainToolRefusalMessage,
  type WebrainToolRefusal,
} from "../domain/webrain-tools.domain"
import {
  webrainMcpToken,
  webrainProxyPool,
} from "./webrain-config.store"
import {webrainPayloadSignals} from "../domain/webrain-signals.domain"
import {acquireWorkerTarget} from "./webrain-worker-acquire"

/** A tool result, normalised out of webrain's MCP envelope. */
export interface WebrainToolResult {
  ok: boolean
  /** The tool's payload as text — webrain puts it in `content[0].text`. */
  text: string
  /** The same payload when it parsed as JSON. Most tools
   * return typed JSON. */
  json?: unknown
  /**
   * The page needed JavaScript, so the browserless fetch returned a shell
   * rather than content.
   *
   * Present ONLY for tools that report it — `scrape` today. `undefined` means
   * "no information about this payload", never "the page fetched fine", and the
   * two are kept apart deliberately: see `domain/webrain-signals.domain.ts`.
   */
  needsJs?: boolean
  /** Visible characters the engine counted; the heuristic's other input. */
  visibleChars?: number
  /**
   * The response's size stamp: `{chars, est_tokens}`. An ESTIMATE, and an
   * object
   * rather than a number — see this file's header. Present only when the
   * worker
   * stamped the result.
   */
  tokens?: { chars?: number; est_tokens?: number }
  /** Server-side duration the worker reported. */
  ms?: number
  /** Human-readable failure reason; absent when `ok`. */
  error?: string
  /** The shared-instance guard refused this tool. */
  noStateRefused?: boolean
  /**
   * The GATEWAY's allowlist refused this tool for the caller's tier.
   *
   * Distinct from `noStateRefused` on purpose, and the distinction is the
   * point:
   * that one is webrain refusing three tools it happens to know are stateful,
   * while this is US refusing before the worker is reached — including the
   * tools
   * webrain does not protect, since `webrain_session(op=list)` is served on a
   * shared worker. A caller that conflates the two would believe the worker
   * was
   * guarding them when it was the gateway.
   */
  toolRefused?: boolean
  /** Why the gateway refused it, when it did. */
  refusal?: WebrainToolRefusal
  /** The worker could not be reached (or no URL is configured). */
  transportError?: boolean
  /** HTTP status, or 0 when the connection itself failed. */
  status: number
}

const baseUrl = (): string => (env.WEBRAIN_MCP_URL || "").replace(/\/+$/, "")

/** Only sent when a token is configured — an unset token means "no auth".
 * @param {string} token The token the store resolved for this call.
 * @return {Record<string, string>} The header, or nothing when unset.
 */
const authHeaders = (token: string): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {}

/**
 * Streamable HTTP may answer as SSE. Returns the last `data:` payload, or the
 * body unchanged when it is already plain JSON.
 * @param {*} raw
 * @return {*}
 */
const unwrapTransport = (raw: string): string => {
  const dataLines = raw.split("\n").filter((line) => /^\s*data:\s*/.test(line))
  if (!dataLines.length) {
    return raw
  }
  return dataLines[dataLines.length - 1].replace(/^\s*data:\s*/, "").trim()
}

const extractText = (result: { content?: unknown } | undefined): string => {
  if (!result || !Array.isArray(result.content)) {
    return ""
  }
  return result.content
    .map((part) => {
      const text = (part as { text?: unknown })?.text
      return typeof text === "string" ? text : ""
    })
    .join("")
}

const transportFailure = (message: string): WebrainToolResult => ({
  ok: false,
  text: "",
  // The caller supplies the message now. This used to be overridden whenever
  // `baseUrl()` was empty, which was correct while that variable was the ONLY
  // worker source. With a pool configured and `WEBRAIN_MCP_URL` deliberately
  // empty, the override would name a variable that is not what failed.
  error: message,
  transportError: true,
  status: 0,
})

/**
 * One MCP tool call.
 *
 * Never throws: this sits behind an HTTP route, and a worker outage must
 * surface
 * as a typed failure the UI can explain, not as an unhandled rejection that
 * hangs
 * the request to its timeout.
 *
 * `accessMode` sits SECOND and is required, so the allowlist cannot be skipped
 * by
 * omission: TypeScript will not let a caller reach the tool name without
 * stating a
 * tier. It accepts `undefined`, which resolves to the free tier and therefore
 * the
 * STRICTEST allowlist — so a caller who passes nothing fails closed rather than
 * open. An optional trailing parameter would have left the guard resting on
 * every
 * future call site remembering it, and the failure mode of forgetting is one
 * shared tenant reading another's sessions, which is silent.
 * @param {*} name
 * @param {*} accessMode
 * @param {*} args
 */
export const webrainTool = async (
  name: string,
  accessMode: string | undefined,
  args: Record<string, unknown> = {}
): Promise<WebrainToolResult> => {
  const decision = decideWebrainTool(accessMode, name, args)
  if (!decision.allowed) {
    return {
      ok: false,
      text: "",
      error: webrainToolRefusalMessage(decision.refusal ?? "unknown-tool"),
      toolRefused: true,
      refusal: decision.refusal ?? "unknown-tool",
      status: 0,
    }
  }

  // A vault tool is refused BEFORE a worker is taken, because no source this
  // function can reach is the caller's own machine -- see `VAULT_TOOLS`. Admin
  // is exempt to match the allowlist's own decision (an operator diagnosing a
  // failure needs the tool that failed), and the smoke probe depends on it.
  //
  // The cookie pair is the one exception, because it is the one pair that does
  // not need the caller's MACHINE: it needs the caller's BROWSER, which is what
  // a caller-supplied `cdp_url` is. It is also the one pair that keeps nothing
  // open -- the jar is in the payload, not in `profiles_dir()`. Both halves are
  // required, and `isEndpointCookieCall` is the single place that says so.
  if (
    decision.tier !== "admin" &&
    !isEndpointCookieCall(name, args) &&
    needsCallerOwnWorker(name)
  ) {
    return {
      ok: false,
      text: "",
      error: webrainToolRefusalMessage("own-worker"),
      toolRefused: true,
      refusal: "own-worker",
      status: 0,
    }
  }

  // One exclusive worker for this call, released in the `finally` below. With
  // no pool configured the single `WEBRAIN_MCP_URL` is still the source;
  // `planWorkerAcquisition` decides, and it deliberately does NOT fall back to
  // that URL once a pool exists -- a fully busy pool must not degrade into the
  // shared worker, which is the sharing the pool was introduced to remove.
  const acquired = await acquireWorkerTarget(baseUrl())
  if (!acquired.ok) {
    return transportFailure(
      acquired.reason === "all_workers_busy" ?
        "every browser worker is currently leased" :
        "no browser worker configured: set WEBRAIN_WORKER_POOL, " +
        "or WEBRAIN_MCP_URL for a single worker"
    )
  }
  const url = acquired.target.url

  // A tool that reads "the current page" needs a worker nobody else is in:
  // on a shared process the caller reads whatever the previous caller left.
  // The check is HERE rather than with the tier decision above because this
  // is the first point at which the worker is known. `leased` is true only
  // when an exclusive lease was taken, and the single `WEBRAIN_MCP_URL` is
  // deliberately unleased -- so refusing at this point costs nothing there,
  // since the unleased path never took a lease to give back.
  if (!acquired.target.leased && needsExclusiveWorker(name)) {
    await acquired.target.release()
    return {
      ok: false,
      text: "",
      error: webrainToolRefusalMessage("shared-worker"),
      toolRefused: true,
      refusal: "shared-worker",
      status: 0,
    }
  }

  // Resolved per call, not at module load: a rotation in Secret Manager has to
  // be visible to the next request on this instance, or the rotate button does
  // not rotate. The store serves both values from a short TTL cache, so this is
  // not a Secret Manager access per call.
  const [token, pool] = await Promise.all([
    webrainMcpToken(),
    webrainProxyPool(),
  ])

  const options: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Both, or webrain's streamable-HTTP transport rejects the request.
      "Accept": "application/json, text/event-stream",
      ...authHeaders(token),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      // Egress is platform-owned: any caller-supplied `proxy` is dropped here
      // and the tier's entry from the platform pool attached instead. The
      // single point every tool call is built, so a future tool cannot forget
      // to opt in and no caller can choose where our request is made from.
      // The pool is the store's per-call read, never an env value frozen at
      // module load. See `domain/webrain-proxy.domain.ts`.
      params: {
        name,
        arguments: withPlatformProxy(name, accessMode, args, pool),
      },
    }),
    // NO `compress` here, and that is load-bearing rather than taste. Bun's
    // fetch would gzip the REQUEST body and send `Content-Encoding: gzip`;
    // webrain's hand-rolled `std::net` server does not decode request-body
    // compression, so it reads binary, cannot parse it, and answers
    // `{"error":{"code":-32700,"message":"Parse error"}}`. Every handler then
    // relays that verbatim as `{"status":"error","error":"Parse error"}`,
    // which names a JSON-RPC code instead of anything a caller can act on.
    //
    // Measured, not inferred: the same tools/call body uncompressed gives a
    // normal result, and gzipped it returns exactly `-32700`. Response
    // decompression is unaffected: the fetch spec, and Bun, decode a
    // compressed RESPONSE without this flag.
  }

  let raw: string
  let status: number
  try {
    const response = await fetch(url, options)
    status = response.status
    raw = await response.text()
  } catch (error) {
    return transportFailure(`worker unreachable: ${String(error)}`)
  } finally {
    // The lease covers the REQUEST, not the parsing below it: the worker is
    // free the moment its body has been read, and holding it through JSON
    // parsing and signal extraction would strand capacity for no benefit.
    // This runs on the error path too, including the `return` above -- the
    // path that would otherwise strand a worker for the whole TTL.
    await acquired.target.release()
  }

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      text: "",
      // The worker answers a bare 401 with an empty body; naming the cause
      // is more useful than echoing nothing.
      error:
        status === 401 ?
          "webrain rejected the worker token (WEBRAIN_HTTP_TOKEN)" :
          `webrain answered ${status}`,
      status,
    }
  }

  let payload: {
    result?: {
      content?: unknown
      isError?: boolean
      tokens?: {
        chars?: number
        est_tokens?: number
      }
      ms?: number
    }
    error?: { message?: string }
  }
  try {
    payload = JSON.parse(unwrapTransport(raw))
  } catch {
    return {
      ok: false,
      text: "",
      error: "webrain returned a body that is not JSON",
      status,
    }
  }

  if (payload.error) {
    return {
      ok: false,
      text: "",
      error: payload.error.message || "webrain JSON-RPC error",
      status,
    }
  }

  const text = extractText(payload.result)
  const isError = payload.result?.isError === true
  // Parsed once: `json` and the signals below read the same payload, and
  // parsing twice would let two fields disagree about one response.
  const json = toJson(text)

  return {
    // The guard's refusal is an error envelope, so `ok` must be false; the
    // flag is what lets a caller tell it apart from a broken request.
    ok: !isError,
    text,
    json,
    // Spread, never defaulted. Assigning `needsJs: false` to a tool that never
    // reports it would assert a static page fetched cleanly — the exact silent
    // failure this signal exists to expose. Absent must stay absent.
    ...webrainPayloadSignals(json),
    tokens: payload.result?.tokens,
    ms: payload.result?.ms,
    // Exact message is `<tool> is disabled on this instance: WEBRAIN_NO_STATE
    // is set`
    // (webrain-mcp/src/lib.rs:151). Matched on the flag name, not the prose:
    // the platform plan quotes a different string that does not exist.
    noStateRefused: isError && /WEBRAIN_NO_STATE/.test(text),
    error: isError ? text : undefined,
    status,
  }
}

const toJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Liveness. Unauthenticated by design (it is answered before the auth check),
 * so
 * this is safe to use as the 6PN-only readiness probe behind a gateway.
 */
export const webrainHealth = async (): Promise<{
  ok: boolean
  status: number
}> => {
  // `baseUrl()` and NOT `acquireWorkerTarget`, deliberately. A liveness probe
  // is not a browser-backed call: it touches `/health`, which never launches a
  // browser, so an exclusive lease here would be burned for a request that
  // cannot use it -- and a monitor polling this would exhaust the pool while
  // reporting everything healthy. The pool serialises browser USE, and a
  // readiness check does not use a browser.
  const url = baseUrl()
  if (!url) {
    return { ok: false, status: 0 }
  }

  try {
    const response = await fetch(`${url}/health`, {
      method: "GET",
      compress: true,
    })
    return { ok: response.status === 200, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}
