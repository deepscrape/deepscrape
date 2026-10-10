/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * `POST /api/extract/schema` — compile a sentence into a CSS schema.
 *
 * Why this route exists
 * ---------------------
 * webrain can EXECUTE a CSS schema — `webrain_scrape` with `base_selector` +
 * `fields` fetches the FULL page browserlessly and parses it, so it runs on the
 * shared pool and a free caller gets structured extraction at all — and it can
 * PROPOSE candidate containers (`autoschema`). What nothing could do was turn
 * "every product: name, price, link" into that schema. A caller still had to
 * read the markup and hand-write selectors, which is the one step a
 * non-developer cannot take. This is that missing step.
 *
 * One model call per COMPILE, zero per ROW
 * ---------------------------------------
 * That asymmetry is the whole design. The compiled artifact is deterministic,
 * reusable and cacheable, and behaves identically on run 1000 — which is what
 * makes this strictly better than asking a model to extract the rows on every
 * page (crawl4ai's `LLMExtractionStrategy`), where cost and output both vary per
 * run and neither can be cached or metered per row. The model is a COMPILER
 * here, not an extractor.
 *
 * Why the proof step is not optional
 * ----------------------------------
 * A schema that parses but selects nothing is the failure mode, and it is
 * invisible without running it: an empty result is a VALID answer, so nothing
 * looks broken and the caller gets zero rows with a 200. So the compiled schema
 * is executed before it is returned, and a schema that yields no rows is
 * retried once with the failure stated in the prompt.
 *
 * Where the sample comes from
 * ---------------------------
 * `webrain_scrape` `autoschema` returns `sample`: the inner HTML of ONE matched
 * container (`sample_html` in `webrain-core/src/engines.rs`). A whole page is a
 * wasteful prompt and the visible text carries no tags, so neither can be used
 * to write a selector; one record is exactly the context needed, and it is a
 * few KB.
 *
 * ponytail: UNMETERED, and that is the known ceiling. Each compile spends one
 * model call on the platform's key, so the abuse vector is real but bounded
 * (a ~6KB prompt, and the BFF rate limiter sits in front). The knob is one word
 * in `bff/api.ts`: swap `access` for `paid` to make it a paid entitlement, or
 * charge it a credit through `applyBillingCreditMutation` like a crawl. Doing
 * neither is only defensible while free-tier LLM spend is small.
 */
import { Request, Response } from "express"
import fetch from "node-fetch"
import { env } from "../config/env"
import { keyFor } from "./ai_handler"
import { nonEmptyString } from "./serp"
import { targetUrlFrom } from "../domain/url-guard.domain"
import { webrainTool } from "../infrastructure/webrain-mcp"
import { WebrainTier } from "../domain/webrain-tools.domain"

/** A parsed object, or `undefined` for anything that is not one. */
type Obj = Record<string, unknown>

/**
 * A record, or `undefined` for anything that is not one.
 * @param {unknown} value The candidate.
 * @return {Obj | undefined} The value when it is a plain object.
 */
const asRecord = (value: unknown): Obj | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ?
    (value as Obj) :
    undefined

/** Anthropic's messages endpoint, as `ai_handler.ts` already calls it. */
const LLM_URL = "https://api.anthropic.com/v1/messages"

/** Required by the messages API; without it every call 400s. */
const LLM_VERSION = "2023-06-01"

/**
 * The field types a schema may declare.
 *
 * This is crawl4ai's vocabulary, which is the shape `JsonCssExtractionStrategy`
 * in `src/app/core/types/crawl.interface.ts` already models: the schema is an
 * INTERFACE artifact, and the worker's dialect is a boundary concern (see
 * `toWorkerArgs`). Anything outside the set is coerced to `text` rather than
 * forwarded -- an unknown type is ignored downstream, which returns a field that
 * is always empty, i.e. a schema that looks fine and silently loses a column.
 */
const FIELD_TYPES: readonly string[] = [
  "text",
  "attribute",
  "html",
  "regex",
  "nested",
  "list",
  "nested_list",
]

/** The worker's three implemented types, keyed by the schema's own name. */
const WORKER_FIELD_TYPES: Record<string, string> = {
  text: "text",
  attribute: "attr",
  html: "html",
}

/**
 * A compiled schema, in crawl4ai's `JsonCssExtractionStrategy` shape.
 *
 * Declared here as well as in `src/app/core/types/webrain-tools.interface.ts`
 * because the two projects share no type graph; this copy is the authoritative
 * one for the route below.
 */
export interface CompiledSchema {
  /** Optional schema name -- crawl4ai's key, kept when the model supplies one. */
  name?: string
  /** CSS selecting every record. camelCase, as crawl4ai declares it. */
  baseSelector: string
  /** The columns, each selected INSIDE one record. */
  fields: Obj[]
}

/** Matches webrain's own `sample_html` truncation. */
const SAMPLE_MAX = 6000

/** Eight fields is well under this; the cap bounds a runaway reply. */
const MAX_TOKENS = 1200

/** Used when the caller names no goal beyond "get the data". */
const DEFAULT_INTENT = "the repeated records on this page"

/** One retry: the second failure is a page the model cannot read, not a slip. */
const ATTEMPTS = 2

/** The instruction. The output contract is stated once, exactly. */
const SYSTEM = [
  "You write CSS extraction schemas for a scraper that runs WITHOUT a browser",
  "URLSession or JavaScript engine: it parses static HTML with the `scraper` crate.",
  "You are given a natural-language INTENT and the inner HTML of ONE repeated",
  "record from the target page.",
  "",
  "Answer with ONE JSON object and nothing else, using crawl4ai's schema keys:",
  "{\"name\": \"<short schema name>\", \"baseSelector\": \"<css selecting every record>\", \"fields\": [{\"name\": \"<field>\", \"selector\": \"<css INSIDE one record>\", \"type\": \"text\"|\"attribute\"|\"html\", \"attribute\": \"<the attribute name, only when type is attribute>\"}]}",
  "",
  "Rules:",
  "- camelCase `baseSelector`; and for an attribute such as href or src use",
  "  `type: \"attribute\"` with an `attribute` key. Never emit `base_selector`",
  "  or `attr` -- those are the scraper's internal argument names, not the schema's.",
  "- Every field selector is relative to ONE record, never to the document.",
  "- Match the intent's field names. Use lower_snake_case names.",
  "- Choose selectors that appear in the sample. Prefer stable attributes",
  "  (class, itemprop, id) over positional ones (:nth-child) or long chains.",
  "- Omit a field you cannot locate in the sample rather than guessing; an",
  "  invented selector returns an empty column, which is worse than a missing one.",
].join("\n")

/**
 * Ask the model to write a schema. One non-streaming call.
 *
 * Non-streaming on purpose: the caller needs the whole object before it can be
 * used, so a stream would only add code for a spinner nobody asked for.
 * @param {string} apiKey The caller's own key if they stored one, else ours.
 * @param {string} model The model id, named by the caller.
 * @param {string} prompt The intent + sample (+ the previous failure, if any).
 * @return {Promise<string>} The model's reply text.
 */
const askModel = async (
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> => {
  const response = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": LLM_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `model call failed (${response.status}): ${detail.slice(0, 200)}`
    )
  }
  const payload = asRecord(await response.json())
  const content = payload?.["content"]
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .map((block) => nonEmptyString(asRecord(block)?.["text"]) ?? "")
    .join("")
}

/**
 * The first JSON object in `text`.
 *
 * Models wrap answers in ``` fences and prose despite being told not to, so
 * slicing between the outermost braces beats a strict parse that fails on a
 * correct answer.
 * @param {string} text The model's reply.
 * @return {Obj | undefined} The parsed object, or `undefined`.
 */
export const extractSchemaJson = (text: string): Obj | undefined => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    return undefined
  }
  try {
    return asRecord(JSON.parse(text.slice(start, end + 1)))
  } catch {
    return undefined
  }
}

/**
 * One field, in crawl4ai's schema vocabulary.
 *
 * The output is canonical, NOT the worker's: `type: "attribute"` with an
 * `attribute` key is what `JsonCssExtractionStrategy` declares and what a schema
 * pasted from crawlagent already uses. The worker's `attr` is accepted on the
 * way in, because a model that has seen webrain's own documentation may answer
 * in it -- normalising here keeps both dialects understood in exactly one place.
 * @param {unknown} raw One entry of the model's `fields`.
 * @return {Obj | undefined} The normalised field, or `undefined` if unusable.
 */
export const normalizeField = (raw: unknown): Obj | undefined => {
  const field = asRecord(raw)
  if (!field) {
    return undefined
  }
  const name = nonEmptyString(field["name"])
  const selector = nonEmptyString(field["selector"])
  if (!name || !selector) {
    return undefined
  }
  // A model may answer `attr`; the canonical name is `attribute`.
  const named = (nonEmptyString(field["type"]) ?? "text").toLowerCase()
  const type = named === "attr" ? "attribute" : named
  const out: Obj = {
    name,
    selector,
    type: FIELD_TYPES.includes(type) ? type : "text",
  }
  const attribute =
    nonEmptyString(field["attribute"]) ?? nonEmptyString(field["attr"])
  if (attribute) {
    out["attribute"] = attribute
  }
  return out
}

/**
 * The model's answer as a storable schema.
 *
 * Canonical shape only -- see `normalizeField`. `name` is carried through when
 * the model supplies one, because crawl4ai's schema has that key, but nothing
 * downstream requires it.
 * @param {unknown} raw The parsed model reply.
 * @return {CompiledSchema | undefined} The schema, or `undefined` when it is
 * missing a base selector or has no usable field.
 */
export const normalizeSchema = (raw: unknown): CompiledSchema | undefined => {
  const source = asRecord(raw)
  // The worker's spelling is still accepted, so a schema written against
  // webrain's own docs normalises instead of being rejected outright.
  const baseSelector =
    nonEmptyString(source?.["baseSelector"]) ??
    nonEmptyString(source?.["base_selector"])
  if (!baseSelector) {
    return undefined
  }
  const declared = source?.["fields"]
  const rawFields = Array.isArray(declared) ? declared : []
  const fields = rawFields
    .map(normalizeField)
    .filter((field): field is Obj => field !== undefined)
  if (!fields.length) {
    return undefined
  }
  const name = nonEmptyString(source?.["name"])
  return name ? { name, baseSelector, fields } : { baseSelector, fields }
}

/**
 * A canonical schema in the dialect `webrain_scrape` executes.
 *
 * The worker takes FLAT arguments named `base_selector` and `fields`, with the
 * attribute type spelled `attr`, so this is the one place the two vocabularies
 * meet. It lives beside the compiler rather than in a transport layer because it
 * is a fact about this worker's tool contract, not about HTTP.
 *
 * Not `convertKeysToSnakeCase`: that helper renames camelCase INTERFACE keys for
 * the crawler API, and the two transformations are unrelated -- applying it here
 * would rename `baseSelector` correctly and everything else by accident.
 * @param {CompiledSchema} schema The canonical schema.
 * @return {Record<string, unknown>} The worker's arguments.
 */
export const toWorkerArgs = (
  schema: CompiledSchema,
): Record<string, unknown> => ({
  base_selector: schema.baseSelector,
  fields: schema.fields.map((field) => {
    const type = WORKER_FIELD_TYPES[String(field["type"])] ?? "text"
    const out: Obj = {
      name: field["name"],
      selector: field["selector"],
      type,
    }
    const attribute = field["attribute"]
    if (type === "attr" && attribute !== undefined) {
      out["attr"] = attribute
    }
    return out
  }),
})

/**
 * The prompt for one attempt.
 * @param {string} intent What the caller wants out of the page.
 * @param {string} sample Inner HTML of ONE repeated record.
 * @param {string} previous The schema the last attempt produced, if any.
 * @param {number} rows How many records that schema selected.
 * @return {string} The user-turn content.
 */
const buildPrompt = (
  intent: string,
  sample: string,
  previous?: string,
  rows?: number,
): string => {
  const parts = [
    `INTENT: ${intent}`,
    "",
    "ONE RECORD:",
    sample.slice(0, SAMPLE_MAX),
  ]
  if (previous) {
    parts.push(
      "",
      `Your previous answer ${previous} selected ${rows} records. It must`,
      "match elements that are actually present in ONE RECORD above.",
    )
  }
  return parts.join("\n")
}

/**
 * Compile an intent into a schema and PROVE it yields rows.
 *
 * The execution is the deliverable, not a nicety: `rows` is what the caller
 * came for, and a schema that matched nothing is reported as a failure rather
 * than returned as a schema.
 * @param {string} url The page to compile against.
 * @param {string} tier The caller's access mode, for the worker's own allowlist.
 * @param {string} apiKey The model key.
 * @param {string} model The model id.
 * @param {string} intent What the caller wants out of the page.
 * @return {Promise<Obj>} `{ok:true, schema, rows, sample_rows, attempts}` or
 * `{ok:false, error}`.
 */
const compile = async (
  url: string,
  tier: WebrainTier,
  apiKey: string,
  model: string,
  intent: string,
): Promise<Obj> => {
  const probe = await webrainTool("webrain_scrape", tier, {
    url,
    autoschema: true,
  })
  if (!probe.ok) {
    return { ok: false, error: probe.error ?? "the scraping worker is unreachable" }
  }
  const probeJson = asRecord(probe.json)
  const sample = nonEmptyString(probeJson?.["sample"])
  if (!sample) {
    return {
      ok: false,
      error:
        "No repeated container was found on this page, so there is nothing to " +
        "compile a schema against. The page may need JavaScript, in which case " +
        "no CSS schema applies at all.",
    }
  }

  let previous: string | undefined
  let rows = 0
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const reply = await askModel(
      apiKey,
      model,
      buildPrompt(intent, sample, previous, rows)
    )
    const schema = normalizeSchema(extractSchemaJson(reply))
    if (!schema) {
      previous = "was not valid JSON in the required shape,"
      continue
    }
    const check = await webrainTool("webrain_scrape", tier, {
      url,
      ...toWorkerArgs(schema),
    })
    const checkJson = asRecord(check.json)
    const declared = checkJson?.["data"]
    const data = Array.isArray(declared) ? declared : []
    rows = typeof checkJson?.["rows"] === "number" ? checkJson["rows"] : data.length
    if (rows > 0) {
      return {
        ok: true,
        schema,
        rows,
        sample_rows: data.slice(0, 3),
        attempts: attempt + 1,
      }
    }
    previous = JSON.stringify(schema)
  }

  return {
    ok: false,
    error:
      "The compiled schema matched no elements on this page. Nothing is " +
      "returned rather than a schema that would yield an empty result.",
  }
}

/**
 * `POST /api/extract/schema` — `{url, intent, model}` in, schema + rows out.
 * @param {Request} req The Express request.
 * @param {Response} res The Express response.
 * @return {Promise<void>} Resolves once the response is sent.
 */
export const schemaCompiler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const body = asRecord(req.body)
  const url = targetUrlFrom(body?.["url"])
  if (!url) {
    res.status(400).json({
      error: "A compile needs an http(s) url that is not a private address",
    })
    return
  }
  // Required, not defaulted: a model id is a value this gateway must not invent,
  // and the caller is choosing it anyway (the chat exposes the choice).
  const model = nonEmptyString(body?.["model"])
  if (!model) {
    res.status(400).json({ error: "A compile needs a `model` id" })
    return
  }
  const intent = nonEmptyString(body?.["intent"]) ?? DEFAULT_INTENT
  const key = await keyFor(req, "anthropic", env.ANTHROPIC_API_KEY)
  if (!key) {
    res.status(503).json({
      error: "No model key is configured, so schemas cannot be compiled",
    })
    return
  }
  const tier =
    (req as Request & { accessMode?: WebrainTier }).accessMode ?? "free"
  try {
    const result = await compile(url, tier, key, model, intent)
    res.status(result["ok"] ? 200 : 422).json({ url, intent, model, ...result })
  } catch (error) {
    console.error("schema compile failed:", error)
    res.status(502).json({
      error: error instanceof Error ? error.message : "schema compile failed",
    })
  }
}
