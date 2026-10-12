/* eslint-disable max-len */
/**
 * The model-facts parsing and lookup rules.
 *
 * This is the port of `spider-rs/llm_models`' merge step, and it is pinned here because
 * its failure mode is invisible: a wrong or missing fact does not throw, it changes a
 * number a user reads, and the pipeline that fills it is a network call to a third
 * party that cannot be exercised in a test. So the parsing, the normalization and the
 * lookup -- the parts that can be wrong quietly -- are pure and asserted against a
 * fixture. Nothing here touches the network.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  factsFor,
  factsForIds,
  indexModelFacts,
  normalizeModelId,
} from "./model-facts.domain"

describe("normalizeModelId", () => {
  it("drops the provider prefix, keeping everything after the LAST slash", () => {
    assert.equal(normalizeModelId("openai/gpt-4o"), "gpt-4o")
    assert.equal(normalizeModelId("groq/llama-3.1-8b-instant"), "llama-3.1-8b-instant")
    // Two prefixes must not leave "anthropic/claude-3" behind.
    assert.equal(normalizeModelId("openrouter/anthropic/claude-3"), "claude-3")
  })

  it("drops a parenthesised date suffix", () => {
    assert.equal(normalizeModelId("gpt-4o (2024-08-06)"), "gpt-4o")
    assert.equal(normalizeModelId("claude-3.5-sonnet(20241022)"), "claude-3.5-sonnet")
  })

  it("lowercases and trims", () => {
    assert.equal(normalizeModelId("  GPT-4O  "), "gpt-4o")
  })

  it("leaves an already-bare id alone", () => {
    assert.equal(normalizeModelId("claude-haiku-5-5"), "claude-haiku-5-5")
  })
})

describe("indexModelFacts", () => {
  const registry = {
    "sample_spec": {mode: "chat"},
    "openai/gpt-4o": {
      mode: "chat",
      max_input_tokens: 128000,
      max_output_tokens: 16384,
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
      supports_vision: true,
    },
    "groq/llama-3.1-8b-instant": {
      mode: "chat",
      max_input_tokens: 131072,
      input_cost_per_token: 0.00000005,
      output_cost_per_token: 0.00000008,
    },
    "text-embedding-3-large": {
      mode: "embedding",
      input_cost_per_token: 0.00000013,
    },
    "claude-3-5-haiku-20241022": {mode: "chat", supports_vision: false},
    "not-an-object": "ignore me",
  }

  it("converts the registry's per-token prices to per-million", () => {
    // The registry publishes USD per TOKEN; every number this platform shows is per MILLION.
    // A factor error here is a 1000x wrong price, so it is asserted rather than reviewed.
    const facts = factsFor(indexModelFacts(registry), "gpt-4o")

    assert.equal(facts?.inputCostPerMTokens, 2.5)
    assert.equal(facts?.outputCostPerMTokens, 10)
  })

  it("keeps the context window and the max output", () => {
    const facts = factsFor(indexModelFacts(registry), "gpt-4o")

    assert.equal(facts?.contextLength, 128000)
    assert.equal(facts?.maxOutputTokens, 16384)
  })

  it("indexes a provider-prefixed key under the bare id a vendor returns", () => {
    // The whole reason LiteLLM is the source: its key and our catalogue id are the same
    // model spelled differently, and normalization is what makes them meet.
    const index = indexModelFacts(registry)

    assert.ok(factsFor(index, "llama-3.1-8b-instant"))
  })

  it("sets a capability only when the registry says true", () => {
    const index = indexModelFacts(registry)

    assert.equal(factsFor(index, "gpt-4o")?.vision, true)
    // `supports_vision: false` means "not known to be multimodal", not a fact worth carrying.
    assert.equal(factsFor(index, "claude-3-5-haiku-20241022")?.vision, undefined)
    assert.equal(factsFor(index, "claude-3-5-haiku-20241022")?.audio, undefined)
  })

  it("skips rows that are not chat models", () => {
    // An embedding's price is per token of a different kind; using it to price a reply
    // would be a fabricated number rather than a missing one.
    assert.equal(factsFor(indexModelFacts(registry), "text-embedding-3-large"), undefined)
  })

  it("drops a row that carries no usable fact at all", () => {
    const index = indexModelFacts({"mystery/model": {mode: "chat", custom: true}})

    assert.equal(index.size, 0)
  })

  it("keeps the first of two keys that normalize to the same id", () => {
    const index = indexModelFacts({
      "openai/gpt-4o": {mode: "chat", input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001},
      "azure/gpt-4o": {mode: "chat", input_cost_per_token: 0.0000099, output_cost_per_token: 0.00009},
    })

    // Deterministic, so the answer does not depend on which duplicate carries the field.
    assert.equal(factsFor(index, "gpt-4o")?.inputCostPerMTokens, 2.5)
  })

  it("keeps a retirement date that sits on a canonical key", () => {
    // `babbage-002` retires 2026-09-28 upstream. A bare, unprefixed key is a first-party
    // retirement, which is the only kind this platform will act on.
    const index = indexModelFacts({"babbage-002": {mode: "chat", deprecation_date: "2026-09-28"}})

    assert.equal(factsFor(index, "babbage-002")?.deprecatedOn, "2026-09-28")
  })

  it("DROPS a retirement date that belongs to a cloud deployment", () => {
    // The measured shape of the registry: of 536 dated chat models only 41 carry a canonical key.
    // The rest look like these two, and their dates describe an Azure or Bedrock DEPLOYMENT going
    // away rather than the first-party model this platform offers. Passing one on would retire a
    // model that still works, which is the failure the strict matcher exists to avoid.
    const index = indexModelFacts({
      "azure/global-standard/gpt-4o-mini": {mode: "chat", input_cost_per_token: 0.0000025, deprecation_date: "2027-04-14"},
      "us.anthropic.claude-sonnet-4-20250514-v1:0": {mode: "chat", input_cost_per_token: 0.000003, deprecation_date: "2026-10-14"},
    })

    // The prefixed key IS still indexed, under the bare id normalization produces...
    assert.ok(factsFor(index, "gpt-4o-mini"))
    // ...and the deployment's date is not attached to it, nor to the dotted id either.
    assert.equal(factsFor(index, "gpt-4o-mini")?.deprecatedOn, undefined)
    assert.equal(factsFor(index, "us.anthropic.claude-sonnet-4-20250514-v1:0")?.deprecatedOn, undefined)
  })

  it("returns an empty index for a document it does not understand", () => {
    assert.equal(indexModelFacts(null).size, 0)
    assert.equal(indexModelFacts("nope").size, 0)
  })
})

describe("factsFor", () => {
  it("does NOT invent a fact for a model it does not know", () => {
    // The rule that replaced the upstream substring fallback: `gpt-4o-mini` must not be
    // priced from the `gpt-4o` row, and a vendor-only model must not be priced at all.
    const index = indexModelFacts({"openai/gpt-4o": {mode: "chat", input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001}})

    assert.equal(factsFor(index, "gpt-4o-mini"), undefined)
    assert.equal(factsFor(index, "llama-3.1-8b-instant"), undefined)
    assert.equal(factsFor(index, "gpt-6-astra"), undefined)
  })

  it("describes only the ids it knows, keyed by the caller's spelling", () => {
    const index = indexModelFacts({"groq/llama-3.1-8b-instant": {mode: "chat", max_input_tokens: 131072}})
    const found = factsForIds(index, ["llama-3.1-8b-instant", "gpt-6-astra"])

    assert.deepEqual(Object.keys(found), ["llama-3.1-8b-instant"])
    assert.equal(found["llama-3.1-8b-instant"].contextLength, 131072)
  })
})
