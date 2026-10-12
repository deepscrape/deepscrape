/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
/**
 * Per-model facts, derived from a public registry rather than maintained by hand.
 *
 * Why this file exists
 * -------------------
 * `src/app/core/functions/aiapi.fun.ts` carries a cost table that says of itself that
 * several rows are guesses and that "guessing at model ids is how this list rots". Two
 * hardcoded `claude-3-5-haiku-20241022` defaults survived the vendor expansion and left
 * two pickers rendering nothing. Model facts maintained by hand are a defect class, not
 * a chore: every one of them goes stale silently, and the wrong number is displayed.
 *
 * This inverts that. The facts come from a registry that is regenerated from the
 * vendors' own published prices, so the answer is right for a model shipped after this
 * file was written -- which no table committed here can be.
 *
 * The source, and why it is this one
 * ---------------------------------
 * `spider-rs/llm_models` (Rust) aggregates OpenRouter + LiteLLM + Chatbot Arena and
 * emits a const array in a COMPILED BINARY. Ported here as a pipeline, not a
 * dependency: the value is the data, and the data is three public URLs. Adopting the
 * crate would mean a toolchain and an artifact format nothing in this stack reads.
 *
 *   - LiteLLM is the source here because its keys are provider-PREFIXED
 *     (`groq/llama-3.1-8b-instant`), which after normalization is exactly the id a
 *     vendor's own `/models` returns. It is the only one of the three that covers the
 *     BYOK vendors (qwen, kimi, fireworks) as well as the platform-funded ones.
 *   - NOT taken yet: OpenRouter adds image/audio/video modality flags (needs a UI that
 *     gates a task by capability before it is worth shipping) and Chatbot Arena adds
 *     quality rankings (needs a router that picks a model by score). Both are one more
 *     `Object.entries` loop in `indexModelFacts` when something reads them.
 *   - `redirect: "error"` for the same reason the vendor catalogues do it: the host is a
 *     constant here, and a redirect is the one thing that would move the request off it.
 *
 * Deliberately no Firestore and no credentials, which is why this is a domain file and
 * not an `infrastructure/` client: an unauthenticated public read that is cached in
 * module scope needs no store and no secret to resolve. Anything that needs a key
 * belongs elsewhere.
 */
import fetch from "node-fetch"

/** Facts about one model. Every field is optional: absent means UNKNOWN, never false. */
export interface ModelFacts {
  /** True only when the registry says so. Absent is "not known to be multimodal". */
  vision?: boolean
  audio?: boolean
  video?: boolean
  pdf?: boolean
  /** Tokens the model accepts in one request. */
  contextLength?: number
  maxOutputTokens?: number
  /** USD per 1 MILLION input tokens. The unit is in the name on purpose -- see `rateFor`. */
  inputCostPerMTokens?: number
  outputCostPerMTokens?: number
}

/** Facts keyed by NORMALIZED model id, so a lookup is one map hit. */
export type ModelFactsIndex = ReadonlyMap<string, ModelFacts>

/** The registry. Public, unauthenticated, regenerated upstream. */
export const MODEL_FACTS_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

/**
 * How long a good snapshot is reused, and how long a failed one is remembered.
 *
 * The failure TTL is not a nicety: without it one blip on a cold start would serve an
 * empty index for the whole success window, and every cost figure in the product would
 * read zero for six hours with nothing in the logs after the first line.
 */
const MODEL_FACTS_TTL_MS = 6 * 60 * 60 * 1000
const MODEL_FACTS_RETRY_MS = 5 * 60 * 1000

const EMPTY_FACTS: ModelFactsIndex = new Map()

interface RawEntry {
  mode?: unknown
  max_input_tokens?: unknown
  max_output_tokens?: unknown
  input_cost_per_token?: unknown
  output_cost_per_token?: unknown
  supports_vision?: unknown
  supports_audio_input?: unknown
  supports_video_input?: unknown
  supports_pdf_input?: unknown
}

interface FactsSnapshot {
  at: number
  index: ModelFactsIndex
  /** False when the read failed, so it is retried on the short TTL. */
  ok: boolean
}

let snapshot: FactsSnapshot | null = null
let inFlight: Promise<FactsSnapshot> | null = null

/**
 * Reduce a model id to the string the registry and a vendor both use.
 *
 * Lowercase, drop the provider prefix, drop a parenthesised date. Nothing else: this is
 * deliberately STRICTER than the upstream implementation, which falls back to substring
 * matching in both directions. A fuzzy hit produces a confident WRONG price, and a
 * displayed price that is wrong is worse than no price at all -- the caller already
 * handles "unknown" (`calculateOpenAICost` falls back to its table, and then to zero).
 * @param {string} id The model id, in any of the forms the sources use.
 * @return {string} The normalized id.
 */
export const normalizeModelId = (id: string): string => {
  let value = id.trim().toLowerCase()

  // Last slash, not first: `openrouter/anthropic/claude-3` must yield `claude-3`.
  const slash = value.lastIndexOf("/")
  if (slash >= 0) {
    value = value.slice(slash + 1)
  }

  // `gpt-4o (2024-08-06)` and `claude-3.5-sonnet(20241022)`.
  const paren = value.lastIndexOf("(")
  if (paren > 0) {
    value = value.slice(0, paren).trimEnd()
  }

  return value
}

const asPositive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * Per-token USD (the registry's unit) to per-million USD (this platform's unit).
 *
 * Rounded at 1e-6 because the raw product carries float noise (`2.4999999999999996`),
 * and these numbers travel to a browser as JSON.
 * @param {number} perToken Cost in USD for one token.
 * @return {number} Cost in USD per million tokens.
 */
const toPerMillion = (perToken: number): number => Math.round(perToken * 1e12) / 1e6

/**
 * One registry entry as facts, or `undefined` when it is not a chat model at all.
 * @param {RawEntry} entry The registry's row.
 * @return {ModelFacts | undefined} The facts, or undefined for a row no picker offers.
 */
const entryToFacts = (entry: RawEntry): ModelFacts | undefined => {
  // Embeddings, rerankers, image generators and audio models are listed here too, and their
  // "cost per token" is a different unit entirely -- a picker never offers one, and pricing a
  // chat reply from it would be a fabricated number.
  if (typeof entry.mode === "string" && entry.mode !== "chat" && entry.mode !== "completion") {
    return undefined
  }

  const facts: ModelFacts = {}

  const input = asPositive(entry.input_cost_per_token)
  const output = asPositive(entry.output_cost_per_token)
  const context = asPositive(entry.max_input_tokens)
  const maxOutput = asPositive(entry.max_output_tokens)

  if (input !== undefined) {
    facts.inputCostPerMTokens = toPerMillion(input)
  }
  if (output !== undefined) {
    facts.outputCostPerMTokens = toPerMillion(output)
  }
  if (context !== undefined) {
    facts.contextLength = context
  }
  if (maxOutput !== undefined) {
    facts.maxOutputTokens = maxOutput
  }

  // Only ever set TRUE. A capability a gate will refuse on needs "known false" as well, and
  // that is the gate's problem to solve -- carrying a `false` for every text model in the
  // fleet would triple this payload to answer a question nothing asks yet.
  if (entry.supports_vision === true) {
    facts.vision = true
  }
  if (entry.supports_audio_input === true) {
    facts.audio = true
  }
  if (entry.supports_video_input === true) {
    facts.video = true
  }
  if (entry.supports_pdf_input === true) {
    facts.pdf = true
  }

  // A row with nothing usable is dropped rather than stored as an empty object, so
  // `factsFor` returning something always means "there is a fact here".
  return Object.keys(facts).length > 0 ? facts : undefined
}

/**
 * Build the lookup index from the registry document.
 *
 * Pure, and exported for that reason: the parsing and the collision rule are the parts
 * that can be wrong in a way nobody notices, so they are tested without a network.
 * @param {unknown} registry The parsed registry document.
 * @return {ModelFactsIndex} Facts keyed by normalized id.
 */
export const indexModelFacts = (registry: unknown): ModelFactsIndex => {
  const index = new Map<string, ModelFacts>()

  if (!registry || typeof registry !== "object") {
    return index
  }

  for (const [key, value] of Object.entries(registry as Record<string, unknown>)) {
    if (key === "sample_spec" || !value || typeof value !== "object") {
      continue
    }

    const facts = entryToFacts(value as RawEntry)
    if (!facts) {
      continue
    }

    const id = normalizeModelId(key)
    // FIRST WINS. The registry lists one model under several providers (`openai/gpt-4o`,
    // `azure/gpt-4o`, `openrouter/openai/gpt-4o`); they agree on everything a picker shows, and
    // overwriting would make the answer depend on which duplicate happens to carry the field.
    if (id.length > 0 && !index.has(id)) {
      index.set(id, facts)
    }
  }

  return index
}

/**
 * Facts for one model id, or `undefined` when the registry does not have it.
 * @param {ModelFactsIndex} index The index, from `modelFacts`.
 * @param {string} id The model id as the caller holds it.
 * @return {ModelFacts | undefined} The facts, or undefined. Never invented.
 */
export const factsFor = (index: ModelFactsIndex, id: string): ModelFacts | undefined =>
  index.get(normalizeModelId(id))

/**
 * Facts for a set of ids, keyed by the CALLER's spelling so the client can look up what
 * it holds without normalizing on its side.
 * @param {ModelFactsIndex} index The index, from `modelFacts`.
 * @param {string[]} ids The ids to describe.
 * @return {Object} Facts keyed by the id AS THE CALLER SPELLED IT, for the ids the registry knows.
 */
export const factsForIds = (
  index: ModelFactsIndex,
  ids: readonly string[],
): Record<string, ModelFacts> => {
  const found: Record<string, ModelFacts> = {}

  for (const id of ids) {
    const facts = factsFor(index, id)
    if (facts) {
      found[id] = facts
    }
  }

  return found
}

const loadModelFacts = async (): Promise<FactsSnapshot> => {
  // Serving the previous snapshot on a failed refresh is the point of keeping it: facts
  // that are a few hours old beat no facts, and the alternative -- emptying the index --
  // would turn a registry outage into a wrong price everywhere.
  const stale = snapshot?.index ?? EMPTY_FACTS

  try {
    const response = await fetch(MODEL_FACTS_URL, { redirect: "error" })
    if (!response.ok) {
      console.error("Model facts registry answered", response.status)
      return { at: Date.now(), index: stale, ok: false }
    }

    const index = indexModelFacts(await response.json())
    // An empty index is a FAILED read, not a successful one: the document always carries
    // thousands of rows, so zero means we parsed something we did not understand and the
    // short TTL should apply.
    if (index.size === 0) {
      return { at: Date.now(), index: stale, ok: false }
    }

    return { at: Date.now(), index, ok: true }
  } catch (error) {
    console.error("Model facts registry failed:", error)
    return { at: Date.now(), index: stale, ok: false }
  }
}

/**
 * The model-facts index, cached in module scope.
 *
 * Module scope is the right home on Cloud Run with `min-instances 1`: one read per warm
 * instance per window rather than one per request. Concurrent first-callers share the
 * in-flight promise, so a burst of requests at cold start is still one outbound GET.
 *
 * Never throws. A caller that gets no facts behaves exactly as before this existed.
 * @return {Promise<ModelFactsIndex>} The index, possibly empty.
 */
export const modelFacts = async (): Promise<ModelFactsIndex> => {
  if (snapshot) {
    const ttl = snapshot.ok ? MODEL_FACTS_TTL_MS : MODEL_FACTS_RETRY_MS
    if (Date.now() - snapshot.at < ttl) {
      return snapshot.index
    }
  }

  if (!inFlight) {
    inFlight = loadModelFacts()
    void inFlight.then((loaded) => {
      snapshot = loaded
      inFlight = null
    })
  }

  return (await inFlight).index
}

/**
 * How long a catalogue request will wait for the registry before giving up on it.
 *
 * Short on purpose. The facts are an ENRICHMENT of a reply that is already useful without them,
 * and the ids must not be delayed by a third party that is not the vendor being asked about. The
 * read keeps going in the background either way, so the cost of one timeout is a single request
 * served without facts and every later one served from the cache it filled.
 */
const MODEL_FACTS_WAIT_MS = 1500

/**
 * The index, or an empty one when the registry has not answered in time.
 *
 * The independent-failure half of the contract this file documents: a wedged registry degrades a
 * catalogue reply instead of failing it.
 * @param {number} timeoutMs How long to wait. Defaults to `MODEL_FACTS_WAIT_MS`.
 * @return {Promise<ModelFactsIndex>} The index, possibly empty.
 */
export const modelFactsWithin = async (timeoutMs = MODEL_FACTS_WAIT_MS): Promise<ModelFactsIndex> => {
  let timer: ReturnType<typeof setTimeout> | undefined

  const expiry = new Promise<ModelFactsIndex>((resolve) => {
    timer = setTimeout(() => resolve(EMPTY_FACTS), timeoutMs)
  })

  const index = await Promise.race([modelFacts(), expiry])
  clearTimeout(timer)
  return index
}
