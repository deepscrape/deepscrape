import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {
  extractSchemaJson,
  normalizeField,
  normalizeSchema,
  toWorkerArgs,
} from "./schema-compiler"

// The compiler's own logic is the parsing and the normalisation; the model call
// and the execution are I/O. Those two are what a regression would break
// silently -- a field whose type is dropped returns an empty column forever.

describe("extractSchemaJson", () => {
  it("reads a bare JSON object", () => {
    assert.deepEqual(extractSchemaJson("{\"base_selector\":\"li\"}"), {
      base_selector: "li",
    })
  })

  it("reads through the code fence a model adds anyway", () => {
    const fenced = "Here you go:\n```json\n{\"base_selector\":\"li\"}\n```"
    assert.deepEqual(extractSchemaJson(fenced), {base_selector: "li"})
  })

  it("returns undefined for prose with no object", () => {
    assert.equal(extractSchemaJson("I cannot help with that."), undefined)
  })

  it("returns undefined for malformed JSON", () => {
    assert.equal(extractSchemaJson("{not json}"), undefined)
  })
})

describe("normalizeField", () => {
  it("defaults the type to text", () => {
    assert.deepEqual(normalizeField({name: "title", selector: "h2"}), {
      name: "title",
      selector: "h2",
      type: "text",
    })
  })

  // The canonical shape is crawl4ai's, so a schema copied out of crawlagent is
  // already valid here and nothing has to be translated to store one.
  it("keeps crawl4ai's attribute spelling rather than the worker's", () => {
    assert.deepEqual(
      normalizeField({
        name: "link",
        selector: "h3 a",
        type: "attribute",
        attribute: "href",
      }),
      {name: "link", selector: "h3 a", type: "attribute", attribute: "href"}
    )
  })

  // The worker's dialect is still understood on the
  // way in, because a model that
  // has read webrain's own docs may answer in it.
  it("accepts the worker's attr spelling and normalises it", () => {
    assert.deepEqual(
      normalizeField({
        name: "link",
        selector: "a",
        type: "attr",
        attr: "href",
      }),
      {name: "link", selector: "a", type: "attribute", attribute: "href"}
    )
  })

  // An unknown type is IGNORED by the worker, so the field would come back
  // empty on every row and nothing would look broken.
  it("coerces an unknown type to text rather than forwarding it", () => {
    const field = normalizeField({
      name: "p",
      selector: ".price",
      type: "integer",
    })
    assert.equal(field?.["type"], "text")
  })

  it("drops a field with no name or no selector", () => {
    assert.equal(normalizeField({selector: "h2"}), undefined)
    assert.equal(normalizeField({name: "title"}), undefined)
    assert.equal(normalizeField("h2"), undefined)
  })
})

describe("normalizeSchema", () => {
  it("reads crawl4ai's baseSelector and keeps it canonical", () => {
    const schema = normalizeSchema({
      baseSelector: "article.product_pod",
      fields: [{name: "title", selector: "h3 a"}],
    })
    assert.equal(schema?.baseSelector, "article.product_pod")
    assert.equal(schema?.fields.length, 1)
  })

  it("still reads the worker's base_selector spelling", () => {
    const schema = normalizeSchema({
      base_selector: "li",
      fields: [{name: "t", selector: "h2"}],
    })
    assert.equal(schema?.baseSelector, "li")
  })

  it("keeps the optional schema name", () => {
    const schema = normalizeSchema({
      name: "Products",
      baseSelector: "li",
      fields: [{name: "t", selector: "h2"}],
    })
    assert.equal(schema?.name, "Products")
  })

  it("refuses a schema with no usable field", () => {
    assert.equal(
      normalizeSchema({base_selector: "li", fields: []}),
      undefined
    )
    assert.equal(normalizeSchema({base_selector: "li"}), undefined)
  })

  it("refuses a schema with no selector", () => {
    assert.equal(
      normalizeSchema({fields: [{name: "t", selector: "h2"}]}),
      undefined
    )
  })

  it("keeps the good fields when one is unusable", () => {
    const schema = normalizeSchema({
      base_selector: "li",
      fields: [{name: "good", selector: "h2"}, {selector: "h3"}],
    })
    assert.equal(schema?.fields.length, 1)
    assert.equal(schema?.fields[0]["name"], "good")
  })
})

// The one place the two vocabularies meet. A wrong translation here is exactly
// the silent-empty-column failure the normalisation exists to prevent.
describe("toWorkerArgs", () => {
  it("renames the selector and the attribute type", () => {
    const args = toWorkerArgs({
      baseSelector: "article.product_pod",
      fields: [
        {name: "link", selector: "h3 a", type: "attribute", attribute: "href"},
      ],
    })
    assert.equal(args["base_selector"], "article.product_pod")
    assert.deepEqual(args["fields"], [
      {name: "link", selector: "h3 a", type: "attr", attr: "href"},
    ])
  })

  it("does not carry an attribute on a text field", () => {
    const args = toWorkerArgs({
      baseSelector: "li",
      fields: [{name: "t", selector: "h2", type: "text"}],
    })
    assert.deepEqual(args["fields"], [
      {name: "t", selector: "h2", type: "text"},
    ])
  })

  it("drops a type the worker cannot execute rather than forwarding it", () => {
    const args = toWorkerArgs({
      baseSelector: "li",
      fields: [{name: "t", selector: "h2", type: "regex"}],
    })
    const fields = args["fields"] as Record<string, unknown>[]
    assert.equal(fields[0]["type"], "text")
  })
})
