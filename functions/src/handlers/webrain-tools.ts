/* eslint-disable object-curly-spacing */
/**
 * The webrain tool routes the free tier may reach: `/scrape`, `/search`,
 * `/extract` and `/pdf` -- plus `/session/vault`, the one PAID route here,
 * because it is the same three-step shape behind a different gate.
 *
 * Why one file
 * ------------
 * Each handler is the same three steps as `/serp` — map the body onto the
 * worker's own argument names, call the tool at the caller's tier, then turn
 * the result into a status. Four files would be four copies of that shape and
 * four copies of the refusal mapping; one file keeps the shape visible and the
 * differences (an enum here, a required argument there) next to each other.
 *
 * The argument names are the WORKER'S, read from its own `inputSchema`
 * -------------------------------------------------------------------
 * `webrain-mcp/src/tools.rs` is the source of truth for every name below, and
 * for three of these routes the brief's HTTP shape does not match it. Those
 * mismatches are refused with a 400 that names the real argument rather than
 * forwarded, because a forwarded argument the worker ignores is a request that
 * looks accepted and does nothing:
 *
 *  - `webrain_search` takes `q` and `engine` only — there is no `limit`, so a
 *    `limit` is a 400 that points at `/api/serp`, which does take one.
 *  - `webrain_extract` reads the CURRENT page of a browser session; it has no
 *    `url`. Page-loading is a session operation, so `url` is refused here.
 *  - `webrain_pdf` reads a worker-side file: `path` / `paths`, not a `url`.
 *
 * `proxy` is never mapped on any of them. It is a real argument of several
 * webrain tools and it chooses the worker's egress — the one thing the platform
 * reserves for itself (see `domain/scrape-providers.domain.ts`).
 *
 * Two payload shapes, not one
 * --------------------------
 * `webrain_scrape` answers `{"status":"ok","result":{…}}` while `search` and
 * `extract` answer their result at the top level, and a failure is
 * `{"status":"error","message":…}` in every case. A tool the worker has no
 * executor for answers `{"error":"Unknown tool: …"}` — with no `status` at
 * all — which is why `toolErrorInPayload` reads both fields.
 */
import { Request, Response } from "express"
import {
  integer,
  nonEmptyString,
} from "./serp"
import {
  MAX_TARGETS,
  cdpEndpointFrom,
  cdpEndpointsFrom,
  targetUrlFrom,
} from "../domain/url-guard.domain"
import { isSafeVaultName } from "../domain/vault-entry.domain"
import {
  webrainTool,
  type WebrainToolResult,
} from "../infrastructure/webrain-mcp"

/**
 * webrain's engine vocabulary for `webrain_search`, from its own inputSchema.
 *
 * `auto` is deliberately absent: it exists on `webrain_serp` (which merges two
 * providers) and NOT on `webrain_search`, which drives one engine and returns
 * its results page. Accepting it here would be accepting an argument the worker
 * ignores.
 */
const SEARCH_ENGINES: readonly string[] = [
  "duckduckgo",
  "google",
  "bing",
  "brave",
]

/** `webrain_extract`'s required `mode`, from its own inputSchema. */
const EXTRACT_MODES: readonly string[] = [
  "schema",
  "regex",
  "jsonld",
  "table",
  "autoschema",
  "bm25",
]

/** `webrain_pdf`'s required `op`, from its own inputSchema. */
const PDF_OPS: readonly string[] = ["page", "extract", "render", "images"]

/**
 * The largest `top_k` a bm25 extract honours.
 *
 * webrain's schema advertises no ceiling and defaults to 10. 100 is this
 * gateway's, chosen so a single call cannot ask the worker to rank an unbounded
 * list of items the caller supplied.
 */
const EXTRACT_MAX_TOP_K = 100

/**
 * One route's argument mapping.
 *
 * `echo` is the already-validated value the response carries back for
 * correlation — the url, query, mode or op — because the field the worker
 * names it by is not always the field the caller sent it in (`q` vs `query`).
 */
export type ToolArguments =
  | { ok: true; args: Record<string, unknown>; echo: unknown }
  | { ok: false; error: string }

/** A record, or undefined for anything that is not one.
 * @param {unknown} value The candidate.
 * @return {Record<string, unknown> | undefined} The record, if it is one.
 */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ?
    (value as Record<string, unknown>) :
    undefined

/**
 * The error inside a tool payload, when there is one.
 *
 * Two shapes have to be read. A tool reporting its own failure answers
 * `{"status":"error","message":…}`, which may arrive inside a 200 MCP
 * envelope — without this, a missing `base_selector` would be answered as a
 * success that says failure. A tool the worker has NO executor for answers
 * `{"error":"Unknown tool: …"}` with no `status` field at all, which is what
 * `webrain_pdf op=extract|render|images` produces today (see this file's
 * `pdfArguments`).
 * @param {unknown} json The parsed tool payload.
 * @return {string | undefined} The provider's message, or undefined.
 */
export const toolErrorInPayload = (json: unknown): string | undefined => {
  const record = asRecord(json)
  if (!record) {
    return undefined
  }

  if (record["status"] === "error") {
    return (
      nonEmptyString(record["message"]) ?? "The provider returned an error"
    )
  }

  if (record["status"] === undefined) {
    return nonEmptyString(record["error"])
  }

  return undefined
}

/**
 * The failure the client should see for a tool result, or null on success.
 *
 * The distinction is between a REFUSAL and an OUTAGE, because the remedy
 * differs: a refusal is a plan or configuration question (403, nothing is
 * broken), an outage is a retry (502). Mirrors `serpFailure`; it is separate
 * because the copy names the scraping worker rather than the search worker, and
 * a shared message that fits neither is worse than two that fit one each.
 * @param {WebrainToolResult} call The normalised tool result.
 * @return {*} The answer, or null.
 */
export const toolFailure = (
  call: WebrainToolResult
): { status: number; error: string } | null => {
  if (call.transportError) {
    return { status: 502, error: "The scraping worker is unreachable" }
  }

  if (call.toolRefused) {
    return { status: 403, error: call.error ?? "Not available on your plan" }
  }

  if (call.noStateRefused) {
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
 * One tool call, with the never-throw guarantee re-established.
 *
 * `webrainTool` is documented never to throw and this route depends on it:
 * Express 4 does not forward a rejected async handler, so a throw here would
 * hang the request to its timeout instead of answering it.
 * @param {string} name The worker tool.
 * @param {string | undefined} accessMode The entitlement resolved upstream.
 * @param {Record<string, unknown>} args The worker arguments.
 * @param {string} [uid] The verified caller, so their OWN egress pool applies
 *   when they have configured one.
 * @param {string} [callerToken] The caller's ID token, so a session tool can be
 *   run on the machine they leased instead of on a platform worker.
 * @return {Promise<WebrainToolResult>} A normalised result, never a rejection.
 */
const callTool = async (
  name: string,
  accessMode: string | undefined,
  args: Record<string, unknown>,
  uid?: string,
  callerToken?: string
): Promise<WebrainToolResult> => {
  try {
    return await webrainTool(name, accessMode, args, uid, callerToken)
  } catch (error) {
    console.error(`webrain ${name} call failed:`, error)
    return {
      ok: false,
      text: "",
      error: "The scraping worker is unreachable",
      transportError: true,
      status: 0,
    }
  }
}

/**
 * `POST /scrape` — one static page, no browser.
 *
 * The URL goes past the platform's target guard first: this hands a
 * caller-supplied address to a worker, which is the same trust boundary a crawl
 * crosses.
 *
 * `base_selector` + `fields` are an OPTIONAL CSS schema. With it the worker
 * fetches the full page and parses it browserlessly, which is how a free caller
 * gets structured extraction at all: `webrain_extract` reads the worker's
 * current page, so on a shared pool it cannot say whose page that is. Without a
 * schema this stays the cheap probe it always was.
 *
 * `autoschema` is the other end of the same problem: a caller with no schema
 * yet. It proposes candidate base selectors instead of using one, and it is
 * browserless here, so it serves the shared pool rather than needing its own
 * worker.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const scrapeArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  const url = targetUrlFrom(source?.["url"])
  if (!url) {
    return {
      ok: false,
      error: "A scrape needs an http(s) url that is not a private address",
    }
  }

  const args: Record<string, unknown> = { url }
  const fields = source?.["fields"]
  const baseSelector = nonEmptyString(source?.["base_selector"])

  // Autoschema PROPOSES a selector rather than using one, so pairing it with a
  // schema is a contradiction, not a preference order to resolve silently.
  if (source?.["autoschema"] === true) {
    if (baseSelector) {
      return {
        ok: false,
        error: "autoschema proposes a base_selector; do not send one as well",
      }
    }
    args["autoschema"] = true
    const min = integer(source?.["min_occurrences"])
    if (min !== undefined) {
      args["min_occurrences"] = Math.max(min, 1)
    }
    return { ok: true, args, echo: url }
  }

  if (!baseSelector) {
    // Refused rather than dropped, for the reason `searchArguments` refuses
    // `limit`: a silently ignored argument is how a caller concludes the
    // feature is broken instead of discovering they asked wrongly.
    if (fields !== undefined) {
      return {
        ok: false,
        error:
          "fields needs a base_selector; a schema with no base is unusable",
      }
    }
    return { ok: true, args, echo: url }
  }

  args["base_selector"] = baseSelector
  if (Array.isArray(fields)) {
    args["fields"] = fields
  } else if (fields !== undefined) {
    return { ok: false, error: "fields must be an array of field objects" }
  }

  return { ok: true, args, echo: url }
}

/**
 * `POST /search` — drive one engine and return its results page.
 *
 * `query` is accepted as an alias for the worker's `q`, as `/serp` does.
 * `limit` is REFUSED rather than ignored, and the refusal names the route that
 * can honour it: `webrain_search` has no such argument, so silently dropping it
 * would return a page of however many results the engine chose and let the
 * caller believe it had asked for ten.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const searchArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  if (!source) {
    return { ok: false, error: "Missing search query" }
  }

  const q = nonEmptyString(source["q"]) ?? nonEmptyString(source["query"])
  if (!q) {
    return { ok: false, error: "Missing search query" }
  }

  if (source["limit"] !== undefined) {
    return {
      ok: false,
      error:
        "webrain_search takes no limit; use /api/serp for a bounded list",
    }
  }

  const args: Record<string, unknown> = { q }

  const engine = nonEmptyString(source["engine"])?.toLowerCase()
  if (engine) {
    if (!SEARCH_ENGINES.includes(engine)) {
      return {
        ok: false,
        error:
          `Unknown engine "${engine}"; expected one of ` +
          SEARCH_ENGINES.join(", "),
      }
    }
    args["engine"] = engine
  }

  return { ok: true, args, echo: q }
}

/**
 * `POST /extract` — structured data from the page the worker is on.
 *
 * The HTTP surface uses `selector` and `schema`; the worker's names are
 * `base_selector` and `fields`. Both are translated here rather than forced on
 * the client, and `url` is refused because the tool has no such argument.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const extractArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  if (!source) {
    return { ok: false, error: "Missing extract mode" }
  }

  if (source["url"] !== undefined) {
    return {
      ok: false,
      error:
        "webrain_extract reads the worker's current page and takes no url; " +
        "use /api/scrape for static content",
    }
  }

  const mode = nonEmptyString(source["mode"])?.toLowerCase()
  if (!mode) {
    return { ok: false, error: "Missing extract mode" }
  }
  if (!EXTRACT_MODES.includes(mode)) {
    return {
      ok: false,
      error:
        `Unknown extract mode "${mode}"; expected one of ` +
        EXTRACT_MODES.join(", "),
    }
  }

  const args: Record<string, unknown> = { mode }

  const selector = nonEmptyString(source["selector"])
  if (selector) {
    args["base_selector"] = selector
  }

  if (mode === "schema" && !selector) {
    // The worker's own check is `base_selector required`; refusing here names
    // the field the client actually sends.
    return {
      ok: false,
      error: "mode=schema needs a selector",
    }
  }

  if (Array.isArray(source["schema"])) {
    args["fields"] = source["schema"]
  } else if (mode === "schema" && source["schema"] !== undefined) {
    return { ok: false, error: "schema must be an array of field objects" }
  }

  if (Array.isArray(source["patterns"])) {
    args["patterns"] = source["patterns"]
  }

  if (typeof source["adaptive"] === "boolean") {
    args["adaptive"] = source["adaptive"]
  }

  const query = nonEmptyString(source["query"])
  if (query) {
    args["query"] = query
  }

  if (mode === "bm25" && !query) {
    return { ok: false, error: "mode=bm25 needs a query" }
  }

  if (Array.isArray(source["items"])) {
    args["items"] = source["items"]
  }

  const topK = integer(source["top_k"])
  if (topK !== undefined) {
    args["top_k"] = Math.min(Math.max(topK, 1), EXTRACT_MAX_TOP_K)
  }

  return { ok: true, args, echo: mode }
}

/**
 * `POST /pdf` — PDF work on a worker-side file, or on the current page.
 *
 * `url` is refused: `webrain_pdf` takes `path` / `paths`, which are paths ON or
 * reachable FROM the worker, and mapping a URL onto a path argument would be
 * inventing a fetch nothing performs.
 *
 * `op=extract|render|images` are accepted because they are the worker's own
 * declared vocabulary, even though its dispatcher has no arm for them today and
 * answers `{"error":"Unknown tool: …"}` (see `toolErrorInPayload`). Refusing a
 * value the worker advertises would be this gateway overruling the contract;
 * reporting the worker's own message as a 502 points at the real fault.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const pdfArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  if (!source) {
    return { ok: false, error: "Missing pdf op" }
  }

  if (source["url"] !== undefined) {
    return {
      ok: false,
      error:
        "webrain_pdf reads a file on the worker, not a url; use `path` " +
        "or `paths`",
    }
  }

  const op = nonEmptyString(source["op"])?.toLowerCase()
  if (!op) {
    return { ok: false, error: "Missing pdf op" }
  }
  if (!PDF_OPS.includes(op)) {
    return {
      ok: false,
      error:
        `Unknown pdf op "${op}"; expected one of ` + PDF_OPS.join(", "),
    }
  }

  const args: Record<string, unknown> = { op }

  const path = nonEmptyString(source["path"])
  const paths = Array.isArray(source["paths"]) ?
    source["paths"].filter((entry) => typeof entry === "string") :
    undefined

  if (op !== "page" && !path && !(paths && paths.length)) {
    return { ok: false, error: `op=${op} needs a path or paths` }
  }

  if (path) {
    args["path"] = path
  }
  if (paths && paths.length) {
    args["paths"] = paths
  }

  if (Array.isArray(source["pages"])) {
    const pages = source["pages"].filter(
      (entry) => typeof entry === "number" && Number.isInteger(entry)
    )
    if (pages.length) {
      args["pages"] = pages
    }
  }

  const dpi = source["dpi"]
  if (typeof dpi === "number" && dpi > 0) {
    args["dpi"] = dpi
  }

  const tileSize = integer(source["tile_size"])
  if (tileSize !== undefined && tileSize > 0) {
    args["tile_size"] = tileSize
  }

  return { ok: true, args, echo: op }
}

/** `webrain_vision`'s required `op`, from its own inputSchema. */
const VISION_OPS: readonly string[] = ["index", "retrieve", "ask"]

/**
 * The numeric fields each vision op accepts, from the worker's inputSchema.
 *
 * Which numbers are legal depends on the op (`max_tiles` is an index argument,
 * `k` a retrieve one), so this is a table rather than one pass-through list:
 * forwarding `max_tiles` to `op=ask` would send an argument the worker ignores.
 */
const VISION_NUMERIC: Record<string, readonly string[]> = {
  index: ["max_tiles", "tile_width", "tile_height"],
  retrieve: ["k"],
  ask: ["scale", "x", "y", "w", "h"],
}

/**
 * `POST /vision` — local vision over screenshot pixels.
 *
 * The required field differs per op, so the refusal names the one the caller's
 * op actually needs: `ask` needs `prompt`, `retrieve` needs `query`, `index`
 * needs neither. `op=ask` is the visual-QA/captcha path and runs on the
 * worker's bundled model, so it takes no cloud key and reveals no screenshot to
 * a third party.
 *
 * `tiles` is `op=ask` only and is forwarded as-is: the worker captures each
 * region at `scale` and sends them in ONE request, which is the batched
 * per-tile path. The caller's numbering is their contract with the model, so it
 * is not rewritten here.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const visionArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  const op = nonEmptyString(source?.["op"])?.toLowerCase()

  if (!op) {
    return { ok: false, error: "Missing vision op" }
  }
  if (!VISION_OPS.includes(op)) {
    return {
      ok: false,
      error:
        `Unknown vision op "${op}"; expected one of ` + VISION_OPS.join(", "),
    }
  }

  const prompt = nonEmptyString(source?.["prompt"])
  const query = nonEmptyString(source?.["query"])

  if (op === "ask" && !prompt) {
    return { ok: false, error: "op=ask needs a prompt" }
  }
  if (op === "retrieve" && !query) {
    return { ok: false, error: "op=retrieve needs a query" }
  }

  const args: Record<string, unknown> = { op }

  const tag = nonEmptyString(source?.["tag"])
  if (tag) {
    args["tag"] = tag
  }
  if (prompt) {
    args["prompt"] = prompt
  }
  if (query) {
    args["query"] = query
  }

  for (const field of VISION_NUMERIC[op] ?? []) {
    const value = source?.[field]
    if (typeof value === "number") {
      args[field] = value
    }
  }

  const tiles = source?.["tiles"]
  if (op === "ask" && Array.isArray(tiles)) {
    const kept = tiles.filter((tile) => asRecord(tile))
    if (kept.length) {
      args["tiles"] = kept
    }
  }

  return { ok: true, args, echo: op }
}

/** How one route answers, so the four cannot drift apart. */
interface RouteSpec {
  /** The worker tool name. */
  tool: string
  /** The field echoed back to the caller, for correlation. */
  echo: string
  /** The value echoed, already validated. */
  echoValue: unknown
  /** The mapped worker arguments. */
  args: Record<string, unknown>
}

/**
 * The shared tail of every route here: call, map the failure, answer.
 * @param {RouteSpec} spec The route's tool, echo and arguments.
 * @param {string | undefined} accessMode The entitlement resolved upstream.
 * @param {string | undefined} uid The verified caller, for their egress pool.
 * @param {string | undefined} callerToken The caller's ID token, for their own
 *   leased machine when they have one and the tool may run there.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response has been written.
 */
const runRoute = async (
  spec: RouteSpec,
  accessMode: string | undefined,
  uid: string | undefined,
  callerToken: string | undefined,
  res: Response
): Promise<void> => {
  const call = await callTool(
    spec.tool,
    accessMode,
    spec.args,
    uid,
    callerToken
  )
  const failure = toolFailure(call)

  if (failure) {
    res.status(failure.status).json({
      provider: "webrain",
      status: "error",
      error: failure.error,
      [spec.echo]: spec.echoValue,
      refusal: call.refusal,
      transportError: call.transportError,
    })
    return
  }

  const error = toolErrorInPayload(call.json)
  if (error) {
    res.status(502).json({
      provider: "webrain",
      status: "error",
      error,
      [spec.echo]: spec.echoValue,
    })
    return
  }

  res.status(200).json({
    provider: "webrain",
    status: "ok",
    [spec.echo]: spec.echoValue,
    // The worker's payload, passed through unchanged rather than re-modelled:
    // its shape is the contract, and re-shaping it here is how the two drift.
    data: call.json,
    tokens: call.tokens,
    ms: call.ms,
  })
}

/**
 * A route handler for one argument mapper.
 *
 * Four near-identical handlers would each repeat the 400-then-`runRoute` body;
 * this keeps the difference between them to the mapper, which is the only part
 * that is actually different.
 * @param {unknown} mapper The route's pure argument mapper.
 * @param {string} tool The worker tool name.
 * @param {string} echo The field echoed back for correlation.
 * @return {*} An Express handler.
 */
const route = (
  mapper: (body: unknown) => ToolArguments,
  tool: string,
  echo: string
) =>
  /**
   * The handler.
   * @param {Request} req
   * @param {Response} res
   * @return {Promise<void>} Resolves once the response has been written.
   */
  async (req: Request, res: Response): Promise<void> => {
    const mapped = mapper(req.body)
    if (!mapped.ok) {
      res.status(400).json({ error: mapped.error })
      return
    }

    await runRoute(
      { tool, echo, echoValue: mapped.echo, args: mapped.args },
      req.accessMode,
      req.user?.uid,
      req.authToken,
      res
    )
  }

/**
 * `POST /scrape` — `webrain_scrape`, one static page.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainScrape = route(scrapeArguments, "webrain_scrape", "url")

/** `webrain_session`'s VAULT + auth-state ops, from its own inputSchema. */
const VAULT_OPS: readonly string[] = [
  "profiles",
  "login",
  "save_state",
  "restore_state",
  "close_launch",
  // The cookie pair. Payload-based on the worker -- the jar travels in the
  // request and nothing is opened in `profiles_dir()`, which is what makes them
  // the two ops a non-admin may run, and only while they name their own browser
  // with `cdp_url` (`isEndpointCookieCall`). Full `state.json` is still
  // file-only on the worker, which is why a profile is not portable end to end
  // yet -- see the header of `webrain-vault.spec.ts`.
  "cookies",
  "setcookies",
]

/** The ops that read a CDP port; the rest must not receive one. */
const VAULT_PORTED: readonly string[] = [
  "login",
  "save_state",
  "restore_state",
  "close_launch",
]

/**
 * The fields each op addresses an entry by.
 *
 * `profiles`, `cookies` and `setcookies` have none. The other four address one
 * entry by `service` + `profile`, and `login` additionally needs the page to
 * replay onto; that url goes past the platform's target guard rather than being
 * forwarded, because it is handed to a worker to navigate.
 */
const VAULT_REQUIRED: Record<string, readonly string[]> = {
  profiles: [],
  login: ["service", "profile"],
  save_state: ["service", "profile"],
  restore_state: ["service", "profile"],
  close_launch: ["service", "profile"],
  cookies: [],
  setcookies: [],
}

/**
 * `POST /browser/session/vault` -- the vault: build it, and log in from it.
 *
 * Drives `webrain_session`'s vault ops and NOTHING else. The three sibling
 * tools the tier table also names (`webrain_profiles`, `webrain_login`,
 * `webrain_launch`) are deliberately unreachable here: the worker does not
 * advertise them in `list_tools`, so their argument names are unverifiable, and
 * forwarding a guessed argument is a request that looks accepted and does
 * nothing. `webrain_session` publishes a schema for the same work.
 *
 * Why these five ops ARE the feature: `save_state` is the write (it captures
 * the current logged-in browser state under `service` + `profile`), `login`
 * replays it, `profiles` lists what is stored, `restore_state` re-applies one,
 * and `close_launch` releases the Chrome a login started. So an entry is built
 * by logging in once and saving -- the only path the worker exposes.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const vaultArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  const op = nonEmptyString(source?.["op"])?.toLowerCase()

  if (!op) {
    return { ok: false, error: "Missing vault op" }
  }
  if (!VAULT_OPS.includes(op)) {
    return {
      ok: false,
      error:
        `Unknown vault op "${op}"; expected one of ` +
        VAULT_OPS.join(", "),
    }
  }

  const args: Record<string, unknown> = { op }

  for (const field of VAULT_REQUIRED[op] ?? []) {
    const value = source?.[field]
    // `service` and `profile` are the only fields in that table, and both
    // become a path segment on the worker:
    // `profiles_dir()/<service>/<profile>`. Both are held to the stricter NAME
    // rule rather than merely being non-empty, because a `..` here would climb
    // out of the worker's profile directory. The rule lives in
    // `vault-entry.domain.ts`.
    if (!isSafeVaultName(value)) {
      return {
        ok: false,
        error:
          `op=${op} needs a ${field} of letters, digits, dot, dash, ` +
          "underscore",
      }
    }
    args[field] = value
  }

  if (op === "login") {
    // The same trust boundary /scrape crosses: this is a caller-supplied
    // address handed to a worker, so it goes past the guard.
    const url = targetUrlFrom(source?.["url"])
    if (!url) {
      return {
        ok: false,
        error: "op=login needs an http(s) url that is not private",
      }
    }
    args["url"] = url
  }

  if (op === "setcookies") {
    // Credential material, so an empty or malformed array is refused rather
    // than forwarded: a `setcookies` that sets nothing looks accepted.
    const sent = source?.["cookies"]
    const kept = Array.isArray(sent) ?
      sent.filter((cookie) => asRecord(cookie) !== undefined) :
      []
    if (!kept.length) {
      return { ok: false, error: "op=setcookies needs a cookies array" }
    }
    args["cookies"] = kept
  }

  // Only the four entry ops read a port, and it defaults worker-side; sending
  // it to `profiles` or either cookie op is an argument the worker ignores.
  if (VAULT_PORTED.includes(op)) {
    const port = integer(source?.["port"])
    if (port !== undefined && port > 0) {
      args["port"] = port
    }
  }

  // The cookie pair may name a browser of the caller's own,
  // and that endpoint is
  // the only reason a non-admin may run either op at all -- see
  // `isEndpointCookieCall`. It crosses the same guard `/serp` uses,
  // because it is
  // an address a worker will connect to. A supplied-but-unusable one is REFUSED
  // rather than dropped: dropping it would run the caller against
  // the platform's
  // own browser while the caller believes it is theirs.
  if (op === "cookies" || op === "setcookies") {
    const named = source?.["cdp_url"]
    if (named !== undefined && named !== null && named !== "") {
      const cdpUrl = cdpEndpointFrom(named)
      if (!cdpUrl) {
        return {
          ok: false,
          error:
            "op=" + op +
            " needs a cdp_url of ws(s) or http(s) to a non-private host",
        }
      }
      args["cdp_url"] = cdpUrl
    }
  }

  return { ok: true, args, echo: op }
}

/**
 * `POST /browser/session/vault` -- `webrain_session`'s vault ops, at the
 * caller's OWN worker. The one PAID route in this module; see `bff/api.ts`.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainVault = route(vaultArguments, "webrain_session", "op")

/**
 * `POST /search` — `webrain_search`, one engine's results page.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainSearch = route(searchArguments, "webrain_search", "query")

/**
 * `POST /vision` — `webrain_vision`, local vision over screenshot pixels.
 *
 * PAID only, and not because of confidentiality: `ask` never leaves the worker.
 * It is here because `index` embeds tiles into a named index the worker holds
 * between calls, which is state a shared pool cannot attribute to one caller.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainVision = route(visionArguments, "webrain_vision", "op")

/**
 * `POST /extract` — `webrain_extract`, structured data.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainExtract = route(
  extractArguments,
  "webrain_extract",
  "mode"
)

/**
 * `POST /pdf` — `webrain_pdf`, PDF work.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainPdf = route(pdfArguments, "webrain_pdf", "op")

/**
 * The keys of a body that the worker itself declares, copied unchanged.
 *
 * An allowlist rather than a passthrough, and for the reason this file's header
 * gives about `limit` and `url`: a forwarded argument the worker does not
 * declare is a request that looks accepted and does nothing. Every name passed
 * here is read from that tool's `inputSchema` in `webrain-mcp/src/tools.rs`.
 *
 * Values are deliberately NOT type-checked. The worker validates its own schema
 * and answers `{"status":"error","message":...}` when it refuses, and
 * `toolErrorInPayload` already surfaces that as a 502. Re-checking here would
 * make this file a second copy of `tools.rs` that drifts from it, which is the
 * coupling the domain layer rejects for the same reason.
 * @param {*} source The parsed request body.
 * @param {*} declared The worker's own argument names.
 * @return {*} Only the declared keys actually present.
 */
const declaredOnly = (
  source: Record<string, unknown>,
  declared: readonly string[]
): Record<string, unknown> => {
  const args: Record<string, unknown> = {}

  for (const name of declared) {
    if (name in source) {
      args[name] = source[name]
    }
  }

  return args
}

/**
 * `webrain_navigate`'s optional arguments, from its own inputSchema.
 *
 * `url` is absent because it is mapped past the target guard rather than copied,
 * and so is `proxy`: it chooses the WORKER's egress, which the platform reserves
 * for itself (see `domain/scrape-providers.domain.ts`).
 */
const NAVIGATE_ARGS: readonly string[] = [
  "disable_resources",
  "block_trackers",
  "network_idle",
  "wait_selector",
  "wait_selector_state",
  "wait_timeout_secs",
  "css_selector",
]

/** `webrain_observe`'s required `what`, from its own inputSchema. */
const OBSERVE_WHAT: readonly string[] = [
  "state",
  "a11y",
  "semantic",
  "html",
  "images",
  "console",
  "flatten",
  "fit",
  "clean",
  "screenshot",
  "pixel",
  "page_info",
  "annotate",
  "media",
]

/**
 * `webrain_observe`'s optional arguments, from its own inputSchema.
 *
 * `what` is absent because it is validated against `OBSERVE_WHAT`, and `url`
 * (meaningful only for `what=media`) because it is a caller-supplied address the
 * worker loads, so it crosses the target guard instead of being copied.
 */
const OBSERVE_ARGS: readonly string[] = [
  "role",
  "filter",
  "max_nodes",
  "selector",
  "full_page",
  "dir",
  "tile_width",
  "tile_height",
  "max_tiles",
  "word_threshold",
  "exclude_social",
  "wait_ms",
]

/**
 * `webrain_guide` -- the worker's own decision guide.
 *
 * Takes NO arguments on the worker (`"properties": {}`), so there is nothing to
 * map. A body is ignored rather than forwarded, because a forwarded argument the
 * worker ignores looks accepted and does nothing.
 *
 * The cheapest route in this module, and the one an agent should reach first: it
 * is free, starts no browser, holds no state, and answers from the binary's own
 * documentation rather than from a page.
 * @param {unknown} _body Ignored: the tool declares no arguments.
 * @return {ToolArguments} No arguments.
 */
export const guideArguments = (_body: unknown): ToolArguments => ({
  ok: true,
  args: {},
  echo: "webrain_guide",
})

/**
 * `webrain_navigate` -- go to a URL in a real browser, return page state.
 *
 * Exists because `/api/scrape` is plain HTTP and reports `needs_js` when a page
 * rendered nothing: without this route, that signal names a remedy no caller can
 * reach. The reply already carries the page's visible text, so the common
 * escalation is this one call.
 *
 * `url` goes past the platform's target guard rather than being forwarded -- it
 * is a caller-supplied address handed to a worker, the same boundary `/scrape`
 * and `op=login` cross.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const navigateArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body) ?? {}
  const url = targetUrlFrom(source["url"])

  if (!url) {
    return {
      ok: false,
      error: "navigate needs an http(s) url that is not private",
    }
  }

  return {
    ok: true,
    args: { url, ...declaredOnly(source, NAVIGATE_ARGS) },
    echo: url,
  }
}

/**
 * `webrain_observe` -- read the CURRENT page without navigating.
 *
 * The projection half of the ladder: `navigate` returns visible text, and this
 * adds what it does not (accessibility tree, semantic tree, console, a
 * screenshot, media URLs) for a page the caller is already on.
 *
 * It reads the current page, so it is in `SHARED_UNSAFE_TOOLS` -- see
 * `webrain-tools.domain.ts`, which refuses it on a worker nobody leased. That is
 * also why the session FRAME route asks a session's own machine for its pixels
 * instead of calling this.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const observeArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body) ?? {}
  const what = nonEmptyString(source["what"])?.toLowerCase()

  if (!what || !OBSERVE_WHAT.includes(what)) {
    return {
      ok: false,
      error:
        `Unknown observe what "${what ?? ""}"; expected one of ` +
        OBSERVE_WHAT.join(", "),
    }
  }

  const args: Record<string, unknown> = {
    what,
    ...declaredOnly(source, OBSERVE_ARGS),
  }

  if ("url" in source) {
    const url = targetUrlFrom(source["url"])
    if (!url) {
      return {
        ok: false,
        error: "observe url must be an http(s) url that is not private",
      }
    }
    args["url"] = url
  }

  return { ok: true, args, echo: what }
}

/**
 * `POST /guide` -- `webrain_guide`, the worker's decision guide. FREE.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainGuide = route(guideArguments, "webrain_guide", "tool")

/**
 * `POST /navigate` -- `webrain_navigate`, the browser escalation. PAID.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainNavigate = route(
  navigateArguments,
  "webrain_navigate",
  "url"
)

/**
 * `POST /observe` -- `webrain_observe`, a projection of the current page. PAID.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainObserve = route(
  observeArguments,
  "webrain_observe",
  "what"
)

/**
 * A caller-supplied list of targets, or undefined when ANY entry is unusable.
 *
 * REFUSES the whole list rather than filtering it the way `safeTargetUrls`
 * does, and the difference is deliberate. These routes take an EXPLICIT list --
 * "fetch these five urls" -- so fetching three and answering 200 is a wrong
 * answer delivered as a success. `safeTargetUrls` serves the enqueue path,
 * where a filtered list IS the contract; this serves the direct-call path,
 * where it is not.
 * @param {unknown} value The candidate list.
 * @return {string[] | undefined} The targets, or undefined when unusable.
 */
const targetListFrom = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }
  if (value.length > MAX_TARGETS) {
    return undefined
  }

  const kept: string[] = []
  for (const entry of value) {
    const url = targetUrlFrom(entry)
    if (!url) {
      return undefined
    }
    kept.push(url)
  }
  return kept
}

/**
 * A positive integer, or undefined for anything else.
 *
 * Zero and negatives are treated as absent rather than clamped: `concurrency:
 * 0` is a caller asking for no work, which is a mistake to surface as a default
 * instead of an answer.
 * @param {unknown} value The candidate.
 * @return {number | undefined} The integer, when it is one above zero.
 */
const positiveInteger = (value: unknown): number | undefined => {
  const parsed = integer(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

/** The `webrain_batch` ops this gateway forwards, from its inputSchema. */
const BATCH_OPS: readonly string[] = ["fetch", "extract", "screenshot"]

/**
 * The most tabs one call may run in flight, whatever `concurrency` asks for.
 *
 * A bound, not a preference. Every tab is a browser context on a machine that
 * must also hold the engine, so the number is set by what ONE session machine
 * sustains rather than by what a caller would like. It is also what makes the
 * flat per-call price honest: uncapped, `concurrency: 50` is fifty parallel
 * tabs for the price of one.
 */
const MAX_BATCH_CONCURRENCY = 8

/** `webrain_crawl`'s required `mode`, from its inputSchema. */
const CRAWL_MODES: readonly string[] = ["spider", "sitemap", "scan", "validate"]

/** `webrain_crawl`'s `strategy`, from its inputSchema. */
const CRAWL_STRATEGIES: readonly string[] = ["bfs", "dfs", "bestfirst"]

/** `webrain_download`'s `engine`, from its inputSchema. */
const DOWNLOAD_ENGINES: readonly string[] = ["http", "ytdlp"]

/**
 * The four capacity tools, routed so the agent can reach them.
 *
 * Why they were unrouted, and why that stopped being right
 * -------------------------------------------------------
 * `webrain_batch`, `webrain_crawl`, `webrain_download` and `webrain_watch` are
 * advertised by the worker and named in `PAID_ONLY_TOOLS`, but no route existed
 * for any of them, so `decideWebrainTool` was never asked and the tools were
 * unreachable from the chat. The tier table was already correct about them; it
 * simply had nothing to gate. These routes are the missing half.
 *
 * Three scalars are refused on all four, and for one reason: the worker's
 * filesystem is the PLATFORM'S.
 * -------------------------------------------------------------------------
 * `dir`, `crawldir` and `download.args` each let the caller name a location or
 * a flag on a machine they do not own. `args` is the sharpest -- it is
 * forwarded to ytdlp, so it is an argument list for a tool that writes files
 * and can be told to run a hook. None of them is needed to fetch or to crawl,
 * so they are 400s rather than fields nobody validates. `output` IS forwarded,
 * held to a bare filename by the same rule the vault entries use.
 *
 * `op` is narrowed, not just validated
 * ------------------------------------
 * `webrain_batch`'s own enum carries `interact` and `eval` beside the three
 * this gateway forwards. Both are refused rather than passed through:
 *
 *  - `eval` runs arbitrary JavaScript. A lease is exclusive FOR THE CALL, but
 *    the PROCESS is reused across tenants -- the fact `VAULT_TOOLS` is built on
 *    -- so an eval could read whatever the previous tenant left in it. That
 *    needs a container of its own, not a lease.
 *  - `interact` drives a page an open session holds. `webrain_interact` is the
 *    tool for that, and it already routes through the caller's own machine.
 *
 * `cdp_urls` is a LIST, so it crosses the CDP guard as one
 * ------------------------------------------------------
 * One unusable entry refuses the whole call. The worker round-robins over this
 * list, so dropping an entry would silently send calls to a browser the caller
 * did not name.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const batchArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  const op = nonEmptyString(source?.["op"])?.toLowerCase()
  if (!op) {
    return { ok: false, error: "Missing batch op" }
  }
  if (op === "eval") {
    return {
      ok: false,
      error:
        "op=eval runs arbitrary JavaScript and needs a container of its own",
    }
  }
  // Named, rather than left to the catch-all below. `interact` IS a real op, so
  // "Unknown batch op" was a false statement about it -- it sends a caller
  // hunting for a typo when the op is refused on purpose.
  if (op === "interact") {
    return {
      ok: false,
      error:
        "op=interact drives a page an open session holds; use " +
        "webrain_interact, which routes through the caller's own machine",
    }
  }
  if (!BATCH_OPS.includes(op)) {
    return {
      ok: false,
      error:
        `Unknown batch op "${op}"; expected one of ` + BATCH_OPS.join(", "),
    }
  }

  const urls = targetListFrom(source?.["urls"])
  if (!urls) {
    return {
      ok: false,
      error:
        "A batch needs a urls array of 1-" + MAX_TARGETS +
        " http(s) urls that are not private addresses",
    }
  }

  const args: Record<string, unknown> = { op, urls }

  if (source?.["cdp_urls"] !== undefined && source?.["cdp_urls"] !== null) {
    const endpoints = cdpEndpointsFrom(source["cdp_urls"])
    if (!endpoints) {
      return {
        ok: false,
        error:
          "Every cdp_urls entry must be ws(s) or http(s) to a " +
          "non-private host; one unusable entry refuses the list",
      }
    }
    args["cdp_urls"] = endpoints
  }

  if (source?.["dir"] !== undefined) {
    return {
      ok: false,
      error: "dir is refused: the worker's filesystem is the platform's",
    }
  }

  const output = source?.["output"]
  if (output !== undefined) {
    if (!isSafeVaultName(output)) {
      return {
        ok: false,
        error:
          "output must be a bare filename of letters, digits, dot, dash " +
          "or underscore",
      }
    }
    args["output"] = output
  }

  const fields = source?.["fields"]
  if (fields !== undefined) {
    if (!Array.isArray(fields)) {
      return { ok: false, error: "fields must be an array of field objects" }
    }
    args["fields"] = fields
  }

  const concurrency = positiveInteger(source?.["concurrency"])
  if (concurrency !== undefined) {
    args["concurrency"] = Math.min(concurrency, MAX_BATCH_CONCURRENCY)
  }

  return { ok: true, args, echo: op }
}

/**
 * `POST /crawl` -- `webrain_crawl`, a site walked from one or more seeds.
 *
 * `mode` is required by the worker and validated here. At least one of `url`,
 * `urls` or `seed_url` is required, and all three cross the target guard; a
 * caller may send more than one and every entry is vetted.
 *
 * `allow`, `deny` and `allowed_domains` are forwarded as string lists. They
 * narrow or steer a walk whose SEEDS are already vetted, so they cannot reach
 * an address the seeds could not -- they are a scope filter, not an escape.
 * `crawldir` is refused like `dir`.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const crawlArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  const mode = nonEmptyString(source?.["mode"])?.toLowerCase()
  if (!mode) {
    return { ok: false, error: "Missing crawl mode" }
  }
  if (!CRAWL_MODES.includes(mode)) {
    return {
      ok: false,
      error:
        `Unknown crawl mode "${mode}"; expected one of ` +
        CRAWL_MODES.join(", "),
    }
  }

  const args: Record<string, unknown> = { mode }
  const single = targetUrlFrom(source?.["url"])
  const seeds = targetListFrom(source?.["urls"])
  const seed = targetUrlFrom(source?.["seed_url"])

  if (!single && !seeds && !seed) {
    return {
      ok: false,
      error:
        "A crawl needs a url, a urls array or a seed_url of http(s) urls " +
        "that are not private addresses",
    }
  }
  if (source?.["url"] !== undefined && !single) {
    return { ok: false, error: "url must be a public http(s) address" }
  }
  if (source?.["urls"] !== undefined && !seeds) {
    return {
      ok: false,
      error:
        "Every urls entry must be a public http(s) address; one unusable " +
        "entry refuses the list",
    }
  }
  if (source?.["seed_url"] !== undefined && !seed) {
    return { ok: false, error: "seed_url must be a public http(s) address" }
  }

  // The worker's target field is MODE-SPECIFIC, and that is MEASURED against the
  // real binary rather than inferred from the parameter names:
  //   spider   -> seed_url (a scalar; passing `url` answers "seed_url required")
  //   validate -> urls     (an ARRAY; passing `url` answers "urls required")
  //   scan     -> url      (accepts seed_url too)
  //   sitemap  -> url
  // Forwarding the caller's own spelling, as this did, broke `spider` and
  // `validate` -- 2 of the 4 modes. It failed as `isError: true` inside a 200,
  // so the route stayed "alive" while returning nothing, which is the version of
  // this that never pages anyone.
  // A caller may still send any of the three spellings; each is normalised to the
  // one this mode needs.
  const one = single ?? seed ?? seeds?.[0]
  if (mode === "spider" && one) {
    args["seed_url"] = one
  } else if (mode === "validate") {
    args["urls"] = seeds ?? (one ? [one] : [])
  } else if (one) {
    args["url"] = one
  }

  if (source?.["crawldir"] !== undefined) {
    return {
      ok: false,
      error: "crawldir is refused: the worker's filesystem is the platform's",
    }
  }

  const strategy = nonEmptyString(source?.["strategy"])?.toLowerCase()
  if (strategy) {
    if (!CRAWL_STRATEGIES.includes(strategy)) {
      return {
        ok: false,
        error:
          `Unknown strategy "${strategy}"; expected one of ` +
          CRAWL_STRATEGIES.join(", "),
      }
    }
    args["strategy"] = strategy
  }

  for (const field of ["max_pages", "max_depth"]) {
    const value = positiveInteger(source?.[field])
    if (value !== undefined) {
      args[field] = value
    }
  }
  // Capped rather than forwarded as sent, for the reason the constant records:
  // `concurrency` is tabs in flight at once, and the route charges a flat price.
  const concurrency = positiveInteger(source?.["concurrency"])
  if (concurrency !== undefined) {
    args["concurrency"] = Math.min(concurrency, MAX_BATCH_CONCURRENCY)
  }
  for (const field of ["same_domain", "respect_robots", "no_content"]) {
    if (source?.[field] === true) {
      args[field] = true
    }
  }
  for (const field of ["allow", "deny", "allowed_domains", "keywords"]) {
    const list = source?.[field]
    if (Array.isArray(list)) {
      args[field] = list.filter((entry) => typeof entry === "string")
    }
  }

  return { ok: true, args, echo: mode }
}

/**
 * `POST /download` -- `webrain_download`, files fetched from urls. PAID.
 *
 * `args` is REFUSED. It is forwarded to ytdlp, so it is an argument list for a
 * tool that writes files and accepts `--exec`; a caller does not need it to
 * fetch a url, and the platform cannot enumerate every flag a future ytdlp
 * adds. `dir` is refused for the same reason as everywhere else.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const downloadArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  if (source?.["args"] !== undefined) {
    return {
      ok: false,
      error:
        "args is refused: it is an argument list for ytdlp, not a fetch " +
        "option",
    }
  }
  if (source?.["dir"] !== undefined) {
    return {
      ok: false,
      error: "dir is refused: the worker's filesystem is the platform's",
    }
  }

  const urls = targetListFrom(source?.["urls"])
  if (!urls) {
    return {
      ok: false,
      error:
        "A download needs a urls array of 1-" + MAX_TARGETS +
        " http(s) urls that are not private addresses",
    }
  }

  const args: Record<string, unknown> = { urls }

  const engine = nonEmptyString(source?.["engine"])?.toLowerCase()
  if (engine) {
    if (!DOWNLOAD_ENGINES.includes(engine)) {
      return {
        ok: false,
        error:
          `Unknown engine "${engine}"; expected one of ` +
          DOWNLOAD_ENGINES.join(", "),
      }
    }
    args["engine"] = engine
  }

  const format = nonEmptyString(source?.["format"])
  if (format) {
    args["format"] = format
  }
  const extension = nonEmptyString(source?.["filter_extension"])
  if (extension) {
    args["filter_extension"] = extension
  }
  if (source?.["audio_only"] === true) {
    args["audio_only"] = true
  }

  return { ok: true, args, echo: urls[0] }
}

/**
 * `POST /watch` -- `webrain_watch`, one video watched with a prompt. PAID.
 *
 * The smallest of the four: a vetted url and the caller's own prompt. Both are
 * forwarded as given, because a prompt is the tool's whole input and is not the
 * platform's to rewrite.
 * @param {unknown} body The parsed request body.
 * @return {ToolArguments} The worker arguments, or why the body is refused.
 */
export const watchArguments = (body: unknown): ToolArguments => {
  const source = asRecord(body)
  const url = targetUrlFrom(source?.["url"])
  if (!url) {
    return {
      ok: false,
      error: "A watch needs an http(s) url that is not a private address",
    }
  }

  const args: Record<string, unknown> = { url }
  const prompt = nonEmptyString(source?.["prompt"])
  if (prompt) {
    args["prompt"] = prompt
  }

  return { ok: true, args, echo: url }
}

/**
 * `POST /batch` -- `webrain_batch`. PAID + EXCLUSIVE via the tier table.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainBatch = route(batchArguments, "webrain_batch", "op")

/**
 * `POST /spider` -- `webrain_crawl`. PAID + EXCLUSIVE via the tier table.
 *
 * Named for the SPIDER and not for the route it drives, because `handlers/scrape.ts`
 * already exports a `webrainCrawl` and `/api/crawl` is already the provider-abstracted
 * scrape endpoint (`scrapeMiddleware`, which loops `webrain_scrape` per url). That is a
 * different tool with a different contract; sharing the name would make the two
 * indistinguishable at the import site, and reusing the path would shadow a live route.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainSpider = route(crawlArguments, "webrain_crawl", "mode")

/**
 * `POST /download` -- `webrain_download`. PAID.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainDownload = route(
  downloadArguments,
  "webrain_download",
  "urls"
)

/**
 * `POST /watch` -- `webrain_watch`. PAID.
 * @param {Request} req
 * @param {Response} res
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const webrainWatch = route(watchArguments, "webrain_watch", "url")
