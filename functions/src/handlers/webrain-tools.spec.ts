/* eslint-disable object-curly-spacing */
/**
 * The four free-tier route mappers and their failure mapping.
 *
 * Pure for the same reason `/serp`'s are: what is worth pinning is the route's
 * permissiveness and its refusals — that `proxy` is never forwarded, that the
 * worker's real enum values are the only ones accepted, and that an argument
 * the worker does not have is a 400 rather than a field it silently ignores.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  extractArguments,
  pdfArguments,
  scrapeArguments,
  searchArguments,
  toolErrorInPayload,
  toolFailure,
  type ToolArguments,
} from "./webrain-tools"
import { type WebrainToolResult } from "../infrastructure/webrain-mcp"

/** The declared argument set of one mapping result.
 * @param {ToolArguments} mapped The mapping result.
 * @return {Record<string, unknown>} The worker arguments, or an empty set.
 */
const argsOf = (mapped: ToolArguments): Record<string, unknown> =>
  mapped.ok ? mapped.args : {}

/**
 * A tool result with only the fields under test set.
 * @param {*} overrides The fields to override.
 * @return {*} A normalised result.
 */
const result = (
  overrides: Partial<WebrainToolResult>
): WebrainToolResult => ({
  ok: true,
  text: "",
  status: 200,
  ...overrides,
})

describe("scrapeArguments", () => {
  it("forwards a schema, and refuses one it cannot honour", () => {
    const plain = scrapeArguments({ url: "https://example.test/a" })
    assert.equal(plain.ok, true)
    // No schema: the shape is unchanged and no schema keys appear, so the
    // cheap probe path cannot be perturbed by this feature.
    assert.equal(plain.ok ? "base_selector" in plain.args : true, false)
    assert.equal(plain.ok ? "fields" in plain.args : true, false)

    const schema = scrapeArguments({
      url: "https://example.test/a",
      base_selector: ".item",
      fields: [{ name: "title", selector: "h2" }],
    })
    assert.equal(schema.ok, true)
    assert.equal(schema.ok ? schema.args["base_selector"] : undefined, ".item")
    assert.equal(Array.isArray(schema.ok ? schema.args["fields"] : null), true)

    // Refused rather than dropped, matching how `limit` is treated on
    // /search: a silently ignored argument reads as a broken feature.
    assert.equal(
      scrapeArguments({ url: "https://example.test/a", fields: [] }).ok,
      false
    )
    assert.equal(
      scrapeArguments({
        url: "https://example.test/a",
        base_selector: ".item",
        fields: "nope",
      }).ok,
      false
    )
  })

  it("forwards autoschema, refuses it alongside a schema", () => {
    const auto = scrapeArguments({
      url: "https://example.test/a",
      autoschema: true,
      min_occurrences: 5,
    })
    assert.equal(auto.ok, true)
    assert.equal(auto.ok ? auto.args["autoschema"] : undefined, true)
    assert.equal(auto.ok ? auto.args["min_occurrences"] : undefined, 5)

    // One proposes a selector, the other consumes one: sending both is a
    // contradiction rather than an order to resolve on the caller's behalf.
    assert.equal(
      scrapeArguments({
        url: "https://example.test/a",
        autoschema: true,
        base_selector: ".item",
      }).ok,
      false
    )

    // `autoschema: false` is not a request to propose anything.
    const off = scrapeArguments({
      url: "https://example.test/a",
      autoschema: false,
    })
    assert.equal(off.ok, true)
    assert.equal(off.ok ? "autoschema" in off.args : true, false)
  })
  it("maps the url and sends nothing else", () => {
    const mapped = scrapeArguments({ url: " https://example.test/a " })
    assert.equal(mapped.ok, true)
    assert.deepEqual(argsOf(mapped), { url: "https://example.test/a" })
  })

  it("refuses private space and anything unparseable", () => {
    for (const body of [
      undefined,
      {},
      { url: 7 },
      { url: "not a url" },
      { url: "http://169.254.169.254/latest/meta-data" },
      { url: "http://10.0.0.5/x" },
    ]) {
      assert.equal(
        scrapeArguments(body).ok,
        false,
        JSON.stringify(body)
      )
    }
  })
})

describe("searchArguments", () => {
  it("requires a query and accepts the worker's own q", () => {
    assert.equal(searchArguments({}).ok, false)
    assert.equal(searchArguments({ query: "   " }).ok, false)

    const mapped = searchArguments({ q: "tokio rust" })
    assert.equal(mapped.ok, true)
    assert.equal(argsOf(mapped)["q"], "tokio rust")
  })

  it("refuses limit, because the worker has no such argument", () => {
    // `webrain_search` takes q and engine only. Dropping the limit silently
    // would answer with however many results the engine chose while the caller
    // believed it had asked for ten.
    const mapped = searchArguments({ q: "x", limit: 10 })
    assert.equal(mapped.ok, false)
    assert.match(mapped.ok ? "" : mapped.error, /serp/)
  })

  it("accepts only the engines the worker lists, lower-cased", () => {
    // `auto` is a webrain_serp engine and is deliberately not accepted here.
    for (const engine of ["auto", "yahoo", "ddg"]) {
      assert.equal(searchArguments({ q: "x", engine }).ok, false, engine)
    }

    const mapped = searchArguments({ q: "x", engine: "Bing" })
    assert.equal(mapped.ok, true)
    assert.equal(argsOf(mapped)["engine"], "bing")
  })

  it("NEVER forwards proxy, which would let a caller pick our egress", () => {
    const mapped = searchArguments({
      q: "x",
      proxy: "http://user:pass@attacker.test:8080",
    })
    assert.equal(mapped.ok, true)
    assert.equal("proxy" in argsOf(mapped), false)
  })
})

describe("extractArguments", () => {
  it("refuses a url: the tool reads the worker's current page", () => {
    const mapped = extractArguments({
      url: "https://example.test/a",
      mode: "table",
    })
    assert.equal(mapped.ok, false)
    assert.match(mapped.ok ? "" : mapped.error, /current page/)
  })

  it("requires a mode from the worker's own list", () => {
    assert.equal(extractArguments({}).ok, false)
    assert.equal(extractArguments({ mode: "csv" }).ok, false)
    assert.equal(extractArguments({ mode: "table" }).ok, true)
  })

  it("translates selector and schema into the worker's names", () => {
    const mapped = extractArguments({
      mode: "schema",
      selector: ".item",
      schema: [{ name: "price", selector: ".p", type: "text" }],
      base_selector: "ignored",
    })
    assert.equal(mapped.ok, true)
    assert.equal(argsOf(mapped)["base_selector"], ".item")
    assert.deepEqual(argsOf(mapped)["fields"], [
      { name: "price", selector: ".p", type: "text" },
    ])
    // The worker's own name is not read from the body: the HTTP surface has one
    // spelling for each argument, and two would be two things to keep aligned.
    assert.equal(argsOf(mapped)["base_selector"], ".item")
  })

  it("needs a selector for mode=schema and a query for mode=bm25", () => {
    assert.equal(extractArguments({ mode: "schema" }).ok, false)
    assert.equal(extractArguments({ mode: "bm25" }).ok, false)

    const bm25 = extractArguments({ mode: "bm25", query: "pricing" })
    assert.equal(bm25.ok, true)
    assert.equal(argsOf(bm25)["query"], "pricing")
  })

  it("clamps top_k and drops a non-numeric one", () => {
    const high = extractArguments({ mode: "table", top_k: 5000 })
    assert.equal(argsOf(high)["top_k"], 100)

    const junk = extractArguments({ mode: "table", top_k: "10" })
    assert.equal("top_k" in argsOf(junk), false)
  })
})

describe("pdfArguments", () => {
  it("refuses a url: the tool reads a worker-side file", () => {
    const mapped = pdfArguments({
      url: "https://example.test/a.pdf",
      op: "extract",
    })
    assert.equal(mapped.ok, false)
    assert.match(mapped.ok ? "" : mapped.error, /path/)
  })

  it("requires an op from the worker's own list", () => {
    assert.equal(pdfArguments({}).ok, false)
    assert.equal(pdfArguments({ op: "ocr" }).ok, false)
  })

  it("needs a path for the ops that read a file, and none for op=page", () => {
    assert.equal(pdfArguments({ op: "extract" }).ok, false)
    assert.equal(pdfArguments({ op: "render", path: "a.pdf" }).ok, true)
    assert.equal(pdfArguments({ op: "page" }).ok, true)

    const paths = pdfArguments({ op: "extract", paths: ["a.pdf", "b.pdf"] })
    assert.equal(paths.ok, true)
    assert.deepEqual(argsOf(paths)["paths"], ["a.pdf", "b.pdf"])
  })

  it("keeps pages whole-numbered and dpi positive", () => {
    const mapped = pdfArguments({
      op: "render",
      path: "a.pdf",
      pages: [1, "2", 3.5, 4],
      dpi: 0,
      tile_size: 512,
    })
    assert.deepEqual(argsOf(mapped)["pages"], [1, 4])
    assert.equal("dpi" in argsOf(mapped), false)
    assert.equal(argsOf(mapped)["tile_size"], 512)
  })

  it("accepts the ops whose executor the worker does not implement", () => {
    // `op=extract|render|images` are the worker's own declared vocabulary even
    // though its dispatcher has no arm for them; the gateway must not overrule
    // the contract, so the payload's own "Unknown tool" error is what reports
    // it (covered below).
    for (const op of ["page", "extract", "render", "images"]) {
      const mapped = pdfArguments({ op, path: "a.pdf" })
      assert.equal(mapped.ok, true, op)
      assert.equal(argsOf(mapped)["op"], op)
    }
  })
})

describe("toolErrorInPayload", () => {
  it("reads the provider's own error envelope", () => {
    assert.equal(
      toolErrorInPayload(
        { status: "error", message: "base_selector required" }
      ),
      "base_selector required"
    )
  })

  it("reads an error field when there is no status at all", () => {
    // This is the shape the worker's dispatch default returns for a tool it
    // has no executor for, and `/serp`'s narrower check would treat it as
    // success.
    assert.equal(
      toolErrorInPayload({ error: "Unknown tool: webrain_pdf_extract" }),
      "Unknown tool: webrain_pdf_extract"
    )
  })

  it("leaves a healthy payload alone", () => {
    assert.equal(toolErrorInPayload({ status: "ok", result: {} }), undefined)
    assert.equal(toolErrorInPayload(undefined), undefined)
    assert.equal(toolErrorInPayload({ status: "ok", error: "" }), undefined)
  })
})

describe("toolFailure", () => {
  it("separates a refusal from an outage", () => {
    const refused = toolFailure(
      result({ ok: false, toolRefused: true, error: "Not on your plan" })
    )
    assert.equal(refused?.status, 403)

    const outage = toolFailure(
      result({ ok: false, transportError: true, status: 0 })
    )
    assert.equal(outage?.status, 502)
  })

  it("treats a shared-worker refusal as an outage, not a plan", () => {
    const noState = toolFailure(result({ ok: false, noStateRefused: true }))
    assert.equal(noState?.status, 502)
    assert.match(noState?.error ?? "", /shared pool/)
  })

  it("returns null for a successful call", () => {
    assert.equal(toolFailure(result({})), null)
  })
})
