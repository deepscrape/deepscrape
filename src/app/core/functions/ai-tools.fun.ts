/**
 * The webrain tools a chat model may call, in both provider dialects.
 *
 * Why this is not the panel's table
 * ---------------------------------
 * `tools-panel.component.ts` already describes these routes, and the shapes look
 * similar enough that reusing it is the obvious move. It is the wrong one: that
 * table carries i18n KEYS (`TOOLS.FIELD_QUERY`) and widget KINDS (`select`,
 * `flag`) because its consumer is a form renderer. A model needs English prose
 * and JSON Schema, because its consumer is a language model. Same routes, two
 * different audiences -- one is UI copy, the other is API documentation -- so
 * this is a second axis rather than a second copy, the same distinction
 * `AI_MODEL_VENDOR` and `isGroqModel` make.
 *
 * Which tools are OFFERED, and why not all seven
 * ---------------------------------------------
 * Every tool below is defined, but only the `available` ones reach a model. The
 * rest fail for most callers for reasons the ROUTE owns, not the model:
 *
 *  - `extract` reads the CURRENT page of a browser session, and `pdf` reads a
 *    path on the worker. Neither can succeed without an exclusive worker, so on
 *    the shared pool they answer `502`. Offering them would hand the model a
 *    tool that reliably fails and encourage it to retry.
 *  - `vision` is behind the `paid` guard, so a free caller gets `402`.
 *  - `extract_schema` bills a model call on the platform key per invocation,
 *    which is a spend decision rather than a chat feature.
 *
 * Flipping one to `available: true` is the whole change needed to offer it; the
 * refusal path below then stops rejecting it, because both read the same flag.
 *
 * Model output is NOT trusted
 * ---------------------------
 * A tool call arrives as model output, which is untrusted input at a trust
 * boundary: a model can name a tool that does not exist, or one that was never
 * offered, or invent arguments. `resolveToolCall` is the gate, and the dispatcher
 * calls it before anything runs. Nothing reaches a route because a model asked.
 */

/** One tool the model may be offered. */
export interface AiToolSpec {
  /** The name the model calls, which is also the spec's identity. */
  readonly name: string;
  /** English, because the consumer is a model and not a translation catalogue. */
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly parameters: Record<string, unknown>;
  /** The route the call executes against. Used by the dispatcher, never the model. */
  readonly path: string;
  /**
   * Whether this tool is offered to a model.
   *
   * `false` is not "unfinished": it is the answer for a route that cannot serve
   * a chat caller. See the module comment for each reason.
   */
  readonly available: boolean;
}

/** A tool call the model asked for, normalised across both dialects. */
export interface AiToolCall {
  /** The provider's id for this call, echoed back with the result. */
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /**
   * Set when the provider sent arguments this could not read.
   *
   * Kept as a flag rather than an empty object, because those are different
   * things and only one of them is harmless. OpenAI streams `arguments` as
   * concatenated fragments, so a truncated one is expected; treating it as `{}`
   * would let the call run with no arguments at all, which for a tool like
   * `scrape` is a 400 the model cannot interpret rather than a refusal it can
   * correct.
   */
  readonly malformed?: boolean;
}

/** An object-typed JSON Schema with named properties. */
const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required: [...required],
});

const string = (description: string): Record<string, unknown> => ({
  type: 'string',
  description,
});

const enumOf = (
  description: string,
  values: readonly string[]
): Record<string, unknown> => ({
  type: 'string',
  description,
  enum: [...values],
});

/**
 * The tools, in the order a model sees them.
 *
 * Descriptions say what the tool RETURNS, not just what it does: a model picks
 * between `search` and `scrape` by outcome ("a results page" versus "one page's
 * text"), and a description that only names the verb leaves that decision to
 * guesswork.
 */
export const AI_TOOLS: readonly AiToolSpec[] = [
  {
    name: 'search',
    description:
      'Search the web and return a results page: titles, URLs and snippets. ' +
      'Use when you need to find pages on a topic. To read one known page, use scrape instead.',
    parameters: object(
      {
        q: string('The search query.'),
        engine: enumOf('Which engine to ask.', [
          'duckduckgo',
          'google',
          'bing',
          'brave',
        ]),
      },
      ['q']
    ),
    path: '/api/search',
    available: true,
  },
  {
    name: 'scrape',
    description:
      'Fetch ONE page by URL and return its readable text. Use when you know the ' +
      'address. Reports whether the page turned out to be a JavaScript shell with no content.',
    parameters: object({ url: string('The absolute URL to fetch.') }, ['url']),
    path: '/api/scrape',
    available: true,
  },
  {
    name: 'serp',
    description:
      'Ask a search engine and return its results for a query, with per-engine ' +
      'breakdown. Similar to search; prefer search unless you need an engine-specific view.',
    parameters: object(
      {
        query: string('The query to ask the engine.'),
        engine: enumOf('Which engine to ask.', [
          'duckduckgo',
          'google',
          'bing',
          'brave',
        ]),
      },
      ['query']
    ),
    path: '/api/serp',
    available: true,
  },
  {
    name: 'extract',
    description:
      'Extract structured data from the CURRENT browser page. Takes no URL, and ' +
      'needs a private browser worker, so it is not offered in chat.',
    parameters: object(
      {
        mode: enumOf('The extraction strategy.', [
          'schema',
          'regex',
          'jsonld',
          'table',
          'autoschema',
          'bm25',
        ]),
        selector: string('CSS selector, required for the schema mode.'),
        top_k: { type: 'number', description: 'How many rows to keep.' },
      },
      ['mode']
    ),
    path: '/api/extract',
    available: false,
  },
  {
    name: 'pdf',
    description:
      'Work on a PDF the WORKER can reach. The platform has no upload route, so ' +
      'a caller cannot put a file where this tool reads, and it is not offered in chat.',
    parameters: object(
      {
        op: enumOf('The PDF operation.', ['page', 'extract', 'render', 'images']),
        path: string('Path on the worker.'),
        dpi: { type: 'number', description: 'Render resolution.' },
      },
      ['op']
    ),
    path: '/api/pdf',
    available: false,
  },
  {
    name: 'vision',
    description:
      'Local vision over screenshot pixels on the worker. A paid route, so a free ' +
      'caller is refused before the tool is consulted.',
    parameters: object(
      {
        op: enumOf('The vision operation.', ['index', 'retrieve', 'ask']),
        prompt: string('The question to ask about the image.'),
      },
      ['op']
    ),
    path: '/api/vision',
    available: false,
  },
  {
    name: 'extract_schema',
    description:
      'Compile a sentence into a reusable extraction schema, proved against the ' +
      'page. Costs a model call on the platform key per invocation.',
    parameters: object(
      {
        url: string('The page to compile against.'),
        intent: string('What to extract, in a sentence.'),
        model: string('The model id to compile with.'),
      },
      ['url', 'intent', 'model']
    ),
    path: '/api/extract/schema',
    available: false,
  },
];

/** The specs a model may be offered. */
export const availableTools = (): readonly AiToolSpec[] =>
  AI_TOOLS.filter(tool => tool.available);

/** The spec for a name, or null when no such tool exists at all. */
export const toolByName = (name: unknown): AiToolSpec | null =>
  typeof name === 'string'
    ? (AI_TOOLS.find(tool => tool.name === name) ?? null)
    : null;

/** Why a model's tool call was refused. */
export type ToolCallRefusal = 'unknown-tool' | 'not-offered' | 'bad-arguments';

/** What resolving one call produced. */
export type ToolCallResolution =
  | { ok: true; tool: AiToolSpec; call: AiToolCall }
  | { ok: false; name: string; reason: ToolCallRefusal };

/**
 * Whether a call may run, and against which tool.
 *
 * The order matters for the message, not the outcome: a name that does not exist
 * is a different problem from a real tool that was never offered, and a caller
 * that conflates them cannot tell a hallucinated name from a deliberate refusal.
 * @param {AiToolCall} call The call as the model emitted it.
 * @return {ToolCallResolution} The tool to run, or why not.
 */
export const resolveToolCall = (call: AiToolCall): ToolCallResolution => {
  const tool = toolByName(call.name);

  if (!tool) {
    return { ok: false, name: call.name, reason: 'unknown-tool' };
  }

  if (!tool.available) {
    return { ok: false, name: call.name, reason: 'not-offered' };
  }

  // Two ways the arguments can be unusable, and both are refused rather than
  // passed on: the model can emit `null` or a string where an object belongs, and
  // the provider can hand back a truncated JSON string that decoded to an empty
  // object. Refusing here keeps the failure in the conversation, where the model
  // can correct itself, instead of becoming a 400 from the route.
  if (
    call.malformed === true ||
    call.args === null ||
    typeof call.args !== 'object' ||
    Array.isArray(call.args)
  ) {
    return { ok: false, name: call.name, reason: 'bad-arguments' };
  }

  return { ok: true, tool, call };
};

/** What Anthropic expects in a request's `tools` field. */
export const anthropicTools = (
  specs: readonly AiToolSpec[]
): Record<string, unknown>[] =>
  specs.map(spec => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }));

/** What OpenAI and Groq expect in a request's `tools` field. */
export const openaiTools = (
  specs: readonly AiToolSpec[]
): Record<string, unknown>[] =>
  specs.map(spec => ({
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));

/**
 * The tool calls in an Anthropic reply.
 *
 * Anthropic arrives already parsed: `content` is an array of typed blocks and a
 * call is one with `type: "tool_use"`, whose `input` is an OBJECT. Nothing is
 * decoded here.
 * @param {unknown} reply The parsed response body.
 * @return {AiToolCall[]} Every call in it, in order.
 */
export const anthropicToolCalls = (reply: unknown): AiToolCall[] => {
  const content = (reply as { content?: unknown })?.content;

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter(
      (block): block is { id: string; name: string; input: unknown } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_use'
    )
    .map(block => ({
      id: String(block.id),
      name: String(block.name),
      args: (block.input ?? {}) as Record<string, unknown>,
    }));
};

/**
 * The tool calls in an OpenAI-shaped reply.
 *
 * The asymmetry from Anthropic is the whole reason this file has two parsers:
 * here `arguments` is a JSON STRING that the model built by concatenating
 * fragments, so it can arrive malformed. A parse failure is reported as bad
 * arguments rather than thrown, because one unreadable call must not lose the
 * others or kill the turn.
 * @param {unknown} reply The parsed response body.
 * @return {AiToolCall[]} Every call in it, in order.
 */
export const openaiToolCalls = (reply: unknown): AiToolCall[] => {
  const choice = (reply as { choices?: unknown })?.choices;

  if (!Array.isArray(choice) || choice.length === 0) {
    return [];
  }

  const calls = (choice[0] as { message?: { tool_calls?: unknown } })?.message
    ?.tool_calls;

  if (!Array.isArray(calls)) {
    return [];
  }

  return calls.map(call => {
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } })
      ?.function;
    const raw = fn?.arguments;
    let args: Record<string, unknown> = {};
    let malformed = false;

    if (typeof raw === 'string' && raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);

        // A parsed `null`, array or scalar is not an arguments object either.
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          malformed = true;
        }
      } catch {
        malformed = true;
      }
    } else if (raw !== null && typeof raw === 'object') {
      args = raw as Record<string, unknown>;
    }
    // A missing `raw` stays valid: a tool that takes no arguments legitimately
    // arrives with the field absent, and that is not a parse failure.

    return {
      id: String((call as { id?: unknown })?.id ?? ''),
      name: String(fn?.name ?? ''),
      args,
      // Omitted rather than `false`, so a well-formed call still compares equal to
      // the plain `{id, name, args}` shape a caller builds.
      ...(malformed ? { malformed: true } : {}),
    };
  });
};
