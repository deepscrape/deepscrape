/* eslint-disable object-curly-spacing */
/**
 * Structured web search — the `/serp` route.
 *
 * Why this handler exists
 * ----------------------
 * `webrain_serp` is the one search tool that returns TYPED results
 * (`{position, title, url, domain, snippet}`) instead of a results page, and
 * it is in `SHARED_POOL_TOOLS` — a stateless read a shared worker can serve
 * for many tenants. Those two facts are why it is the natural first surface a
 * FREE caller can reach, and why the route in front of it does not require a
 * paid plan.
 *
 * The free/paid boundary is NOT here
 * ----------------------------------
 * This handler forwards whatever tier the request resolved to
 * (`req.accessMode`), and `decideWebrainTool` (domain/webrain-tools.domain.ts)
 * decides whether that tier may call the tool. A second check here would be a
 * second place for the two to disagree, and the allowlist is the one that has
 * to be right.
 *
 * What is deliberately not accepted
 * ---------------------------------
 * `proxy` is a real `webrain_serp` argument, and it is not read from the body.
 * It routes the worker's engine fetches through a caller-chosen URL, i.e. it
 * lets a tenant pick the platform's egress — the one thing the gateway
 * reserves for itself (see domain/scrape-providers.domain.ts). Not mapping it
 * is why this file is a mapping rather than a pass-through.
 */
import { Request, Response } from "express"
import {
  webrainTool,
  type WebrainToolResult,
} from "../infrastructure/webrain-mcp"

/**
 * webrain's engine vocabulary, taken from the tool's own MCP inputSchema
 * (webrain-mcp/src/tools.rs). `duckduckgo | auto` are pure HTTP, so they cost
 * the worker a request; `google | brave` are JS-gated and make it drive a
 * browser. `bing` is the one engine that can go either way depending on
 * `browser`: it has a working HTTP path and a deeper browser path, and the
 * browserless one is the default.
 */
const SERP_ENGINES: readonly string[] = [
  "duckduckgo",
  "bing",
  "google",
  "brave",
  "auto",
]

/** The largest `limit` the worker's MCP call honours. */
const SERP_MAX_LIMIT = 50

/** The most transient-failure retries the worker accepts. */
const SERP_MAX_RETRIES = 5

/**
 * A trimmed, non-empty string, or undefined.
 *
 * Exported so the sibling free-tier routes (`webrain-tools.ts`) share this one
 * answer to "did the caller send a value?" instead of each growing its own
 * copy.
 * `""` and whitespace have to be rejected alongside `undefined`: webrain's own
 * `q` check is `q.trim().is_empty()`, so a whitespace query is a refusal at
 * the worker rather than a search, and answering it as a 400 here is clearer
 * than a 502 carrying the worker's message.
 * @param {*} value The candidate.
 * @return {*} The trimmed value, or undefined.
 */
export const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

/**
 * A whole number, or undefined for anything else.
 *
 * Strict on purpose: JSON has a single number type, so a numeric STRING is a
 * client bug worth reporting rather than coercing, and the worker's own
 * `as_u64()` read would silently drop it to the worker's default.
 * @param {*} value The candidate.
 * @return {*} The integer, or undefined.
 */
export const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined

/** The argument mapping for one request. */
export type SerpArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Maps a request body onto `webrain_serp`'s arguments.
 *
 * Pure, so the field mapping — including the argument that is deliberately
 * never mapped (`proxy`, see this file's header) — is testable without a live
 * worker.
 *
 * `q` is the worker's own name. `query` is accepted as an alias so the HTTP
 * surface does not force the client to adopt the worker's single-letter
 * vocabulary; the value is passed on as `q` either way.
 * @param {*} body The parsed request body.
 * @return {*} The worker arguments, or why the body is unusable.
 */
export const serpArguments = (body: unknown): SerpArguments => {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Missing search query" }
  }

  const source = body as Record<string, unknown>
  const q = nonEmptyString(source["q"]) ?? nonEmptyString(source["query"])
  if (!q) {
    return { ok: false, error: "Missing search query" }
  }

  const args: Record<string, unknown> = { q }

  const engine = nonEmptyString(source["engine"])?.toLowerCase()
  if (engine) {
    if (!SERP_ENGINES.includes(engine)) {
      return {
        ok: false,
        error:
          `Unknown engine "${engine}"; expected one of ` +
          SERP_ENGINES.join(", "),
      }
    }
    args["engine"] = engine
  }

  // `browser` picks the execution path for `bing`: absent or false keeps the
  // pure-HTTP path (the worker's default, measured at ~10 results), true lets
  // the worker attach or launch a guest Chrome and page deeper. Mapped rather
  // than defaulted here so the worker stays the single place that decides what
  // "absent" means. `google`/`brave` need a browser whatever this says, and
  // `duckduckgo` has no browser path yet, so for those an explicit value is
  // inert — the worker ignores it.
  if (typeof source["browser"] === "boolean") {
    args["browser"] = source["browser"]
  }

  const limit = integer(source["limit"])
  if (limit !== undefined) {
    // webrain's schema advertises 1..=100 but its MCP call clamps to 1..=50
    // (webrain-mcp/src/tools.rs), and 50 is what its docs publish as the
    // ceiling. Clamping here means a reply cannot silently be smaller than
    // the number that was asked for.
    args["limit"] = Math.min(Math.max(limit, 1), SERP_MAX_LIMIT)
  }

  const page = integer(source["page"])
  if (page !== undefined) {
    args["page"] = Math.max(page, 0)
  }

  if (typeof source["safe"] === "boolean") {
    args["safe"] = source["safe"]
  }

  const region = nonEmptyString(source["region"])
  if (region) {
    args["region"] = region
  }

  if (typeof source["fallback"] === "boolean") {
    args["fallback"] = source["fallback"]
  }

  const retries = integer(source["retries"])
  if (retries !== undefined) {
    args["retries"] = Math.min(Math.max(retries, 0), SERP_MAX_RETRIES)
  }

  return { ok: true, args }
}

/**
 * The failure the client should see for a tool result, or null on success.
 *
 * The distinction being drawn is between a REFUSAL and an OUTAGE, because the
 * remedy differs: a refusal is a plan question (403, nothing is broken), an
 * outage is a retry (502). Reporting both as "search failed" sends a free
 * user to support for a decision they can act on themselves.
 *
 * Pure, so the mapping is pinned by a test instead of by a live worker.
 * @param {*} call The normalised tool result.
 * @return {*} The status and message to answer with, or null.
 */
export const serpFailure = (
  call: WebrainToolResult
): { status: number; error: string } | null => {
  if (call.transportError) {
    return { status: 502, error: "The search worker is unreachable" }
  }

  if (call.toolRefused) {
    // Refused by the gateway's allowlist, so this is a plan question rather
    // than a fault. The message comes from the allowlist itself
    // (webrainToolRefusalMessage), so the two cannot drift.
    return {
      status: 403,
      error: call.error ?? "Not available on your plan",
    }
  }

  if (call.noStateRefused) {
    // A shared worker refusing a stateful tool. `webrain_serp` is stateless,
    // so reaching this means the pool is shaped differently than this route
    // expects — worth naming rather than reporting as a generic failure.
    return {
      status: 502,
      error: "Needs a private worker; the shared pool holds no sessions",
    }
  }

  if (!call.ok) {
    return {
      status: 502,
      error: call.error ?? "The provider returned no result",
    }
  }

  return null
}

/**
 * The error inside a `{"status":"error"}` payload, when there is one.
 *
 * `webrainTool`'s `ok` reads the MCP envelope's `isError`, while the SERP tool
 * reports its own failures as `{"status":"error","message":…}` in a payload
 * that may still arrive in a 200 envelope. Without this, `engine=google` on a
 * worker that cannot launch a browser would be answered as a 200 carrying
 * `{"status":"error"}` — a success that says failure.
 * @param {*} json The parsed tool payload.
 * @return {*} The provider's message, or undefined when the payload is fine.
 */
const providerError = (json: unknown): string | undefined => {
  if (!json || typeof json !== "object") {
    return undefined
  }
  const record = json as Record<string, unknown>
  if (record["status"] !== "error") {
    return undefined
  }
  return (
    nonEmptyString(record["message"]) ?? "The provider returned an error"
  )
}

/**
 * One `webrain_serp` call.
 *
 * `webrainTool` is documented never to throw, and this route depends on that:
 * Express 4 does not forward a rejected async handler, so a throw here would
 * hang the request to its timeout instead of answering it. The catch is the
 * belt for that brace — it turns a broken contract into the same typed
 * transport failure a refused connection already produces.
 * @param {*} accessMode The entitlement resolved for the request.
 * @param {*} args The worker arguments.
 * @param {string} [uid] The verified caller, so their OWN egress pool applies
 *   when they have configured one.
 * @return {*} A normalised result, never a rejection.
 */
const callSerp = async (
  accessMode: string | undefined,
  args: Record<string, unknown>,
  uid?: string
): Promise<WebrainToolResult> => {
  try {
    return await webrainTool("webrain_serp", accessMode, args, uid)
  } catch (error) {
    console.error("webrain serp call failed:", error)
    return {
      ok: false,
      text: "",
      error: "The search worker is unreachable",
      transportError: true,
      status: 0,
    }
  }
}

/**
 * `POST /serp` — a structured web search at the caller's own tier.
 *
 * Registered on both hosts with the same guard (`resolveAccess` plus
 * `crawl.execute`); see `bff/api.ts` and `infrastructure/syncaiapi.ts` for why
 * that guard is `access` and not `paid`.
 * @param {*} req
 * @param {*} res
 */
export const webrainSerp = async (
  req: Request,
  res: Response
): Promise<void> => {
  const mapped = serpArguments(req.body)
  if (!mapped.ok) {
    res.status(400).json({ error: mapped.error })
    return
  }

  const call = await callSerp(req.accessMode, mapped.args, req.user?.uid)
  const failure = serpFailure(call)

  if (failure) {
    res.status(failure.status).json({
      provider: "webrain",
      status: "error",
      error: failure.error,
      query: mapped.args["q"],
      refusal: call.refusal,
      transportError: call.transportError,
    })
    return
  }

  const error = providerError(call.json)
  if (error) {
    res.status(502).json({
      provider: "webrain",
      status: "error",
      error,
      query: mapped.args["q"],
    })
    return
  }

  res.status(200).json({
    provider: "webrain",
    status: "ok",
    query: mapped.args["q"],
    // The worker's typed SERP payload, passed through unchanged rather than
    // re-modelled: `{query, engine, source, results, per_engine, request_id,
    // ms, skipped}` is the contract, and re-shaping it here is how the two
    // drift.
    data: call.json,
    tokens: call.tokens,
    ms: call.ms,
  })
}
