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
import { targetUrlFrom } from "../domain/url-guard.domain"
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
 * @return {Promise<WebrainToolResult>} A normalised result, never a rejection.
 */
const callTool = async (
  name: string,
  accessMode: string | undefined,
  args: Record<string, unknown>
): Promise<WebrainToolResult> => {
  try {
    return await webrainTool(name, accessMode, args)
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
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response has been written.
 */
const runRoute = async (
  spec: RouteSpec,
  accessMode: string | undefined,
  res: Response
): Promise<void> => {
  const call = await callTool(spec.tool, accessMode, spec.args)
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
  // The cookie pair. Already payload-based on the worker, so these are what let
  // a logged-in jar move between machines TODAY. Full `state.json` is still
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
