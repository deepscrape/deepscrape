/**
 * The tools a chat model may call: the webrain worker routes and two read-only
 * platform reads, in both provider dialects.
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
 * Which tools are OFFERED, and why not all of them
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

  // ---- Platform read tools -------------------------------------------------
  //
  // A second family, and the distinction is the guard rather than the vendor.
  // The webrain tools above reach a scraping worker; these two read this
  // platform's own records, through the SAME services the UI already uses
  // (`BrowserSessionService.list`, `BucketStorageService.list`), so the route's
  // own `perm(...)` and `paid` guards apply unchanged -- exactly the property
  // roadmap 7.1 requires.
  //
  // A machine list IS offered, which reverses an earlier position in this file.
  // `GET /api/machines` is `guard([paid, perm('machine','read')])`, so a free
  // caller is refused -- but that is not the failure class `vision` is in. This
  // one fails for callers who genuinely have no machines to list, and the refusal
  // reaches the model as a readable answer, which is what the tool loop exists to
  // convert. The bar is "fails for EVERYONE", not "fails for some".
  //
  // Nothing here spends. A session cannot be started, extended or closed through
  // these, no machine can be deployed or destroyed, and no presigned URL is ever
  // minted -- `presign` returns a 5-minute credential and is deliberately not
  // exposed.
  {
    name: 'list_sessions',
    description:
      'List the browser sessions the caller currently has open, with mode, browser ' +
      'kind, state and expiry. Use when asked what sessions are running or what is ' +
      'still costing money. Read-only: cannot start, extend or close one.',
    parameters: object({}),
    path: '/api/browser/session',
    available: true,
  },
  {
    name: 'list_storage',
    description:
      'List the files the caller has saved, with key, size and the source URL each ' +
      'was saved from. Covers their own files and the shared ones. Read-only: ' +
      'cannot upload, delete or sign a download link.',
    parameters: object({}),
    path: '/api/storage/list',
    available: true,
  },
  {
    name: 'list_machines',
    description:
      'List the dedicated machines the caller owns, with name, state, region and ' +
      'kind. Use when asked what machines exist or what is running. Needs a paid ' +
      'plan. Read-only: cannot deploy, start, stop or destroy one.',
    parameters: object({}),
    path: '/api/machines',
    available: true,
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
 * One executed tool call, paired with the text the model gets back.
 *
 * Paired rather than two parallel arrays, because the pairing IS the contract: a
 * result belongs to the call whose id it echoes, and two lists can drift out of
 * step in a way one list of pairs cannot.
 */
export interface ToolCallResult {
  readonly call: AiToolCall;
  /** The text handed to the model, already truncated by the caller. */
  readonly content: string;
}

/**
 * The turns an Anthropic conversation needs after a tool round.
 *
 * TWO turns, and both are required. Anthropic rejects a `tool_result` whose
 * `tool_use_id` has no preceding assistant `tool_use` block, and a block array is
 * the only shape that can carry one -- a string content cannot. So the caller
 * cannot skip the echo and send only the results.
 *
 * `input` is the arguments object ALREADY DECODED, because this is a
 * re-serialization of what the model asked for rather than a fresh guess at it.
 *
 * Every call needs a result, refused ones included: a `tool_use` with no matching
 * `tool_result` is itself a 400, so a refusal has to be reported AS a result rather
 * than by omitting it.
 * @param {AiToolCall[]} calls The calls the model emitted, in order.
 * @param {ToolCallResult[]} results One per call, in the same order.
 * @return {Array} The two turns to append.
 */
export const anthropicToolTurns = (
  calls: readonly AiToolCall[],
  results: readonly ToolCallResult[]
): { role: string; content: unknown }[] => [
  {
    role: 'assistant',
    content: calls.map(call => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.args,
    })),
  },
  {
    role: 'user',
    content: results.map(result => ({
      type: 'tool_result',
      tool_use_id: result.call.id,
      content: result.content,
    })),
  },
];

/**
 * The turns an OpenAI-shaped conversation needs after a tool round.
 *
 * A different shape for the same reason the parsers are two functions: here the
 * assistant turn carries a `tool_calls` array beside a `content` of `null`,
 * arguments go back as a JSON STRING, and each result is its own `role: 'tool'`
 * turn joined by `tool_call_id` rather than one combined user turn. Sending
 * Anthropic's shape here is a 400.
 * @param {AiToolCall[]} calls The calls the model emitted, in order.
 * @param {ToolCallResult[]} results One per call, in the same order.
 * @return {Array} The turns to append: one assistant echo, then one per result.
 */
export const openaiToolTurns = (
  calls: readonly AiToolCall[],
  results: readonly ToolCallResult[]
): { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[] => [
  {
    role: 'assistant',
    content: null,
    tool_calls: calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  },
  ...results.map(result => ({
    role: 'tool',
    tool_call_id: result.call.id,
    content: result.content,
  })),
];

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
    const decoded = decodeArguments(fn?.arguments);

    return {
      id: String((call as { id?: unknown })?.id ?? ''),
      name: String(fn?.name ?? ''),
      args: decoded.args,
      ...(decoded.malformed ? { malformed: true } : {}),
    };
  });
};

/**
 * Decode a provider's `arguments` payload into an object.
 *
 * ONE place decides what "unreadable" means, because the non-streaming parser and
 * both streaming accumulators need the same answer. A second copy would be a second
 * opinion on whether a truncated fragment is a refusal or an empty call -- and the
 * first version of this got exactly that wrong by treating a fragment as `{}`.
 * @param {unknown} raw A JSON string, an object, or nothing at all.
 * @return {{args: Record<string, unknown>, malformed: boolean}} The decoded arguments.
 */
const decodeArguments = (
  raw: unknown
): { args: Record<string, unknown>; malformed: boolean } => {
  // Absent is not malformed: a tool that takes no arguments legitimately arrives
  // with the field missing, and refusing that would break every no-arg tool.
  if (raw === undefined || raw === null || raw === '') {
    return { args: {}, malformed: false };
  }

  if (typeof raw === 'object') {
    return Array.isArray(raw)
      ? { args: {}, malformed: true }
      : { args: raw as Record<string, unknown>, malformed: false };
  }

  if (typeof raw !== 'string') {
    return { args: {}, malformed: true };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { args: parsed as Record<string, unknown>, malformed: false }
      : { args: {}, malformed: true };
  } catch {
    return { args: {}, malformed: true };
  }
};

/** Tool calls being assembled from a stream, keyed by the provider's own index. */
export type ToolCallAccumulator = Map<
  number,
  { id: string; name: string; raw: string }
>;

/** A fresh accumulator. */
export const newToolCallAccumulator = (): ToolCallAccumulator => new Map();

/**
 * Fold one OpenAI streaming chunk into the accumulator.
 *
 * OpenAI identifies the call being built by `index`, NOT by `id`: the id arrives
 * once on the first fragment, and the NAME can arrive in a different fragment from
 * the arguments. So id and name are taken from the first fragment that carries each,
 * while arguments are CONCATENATED -- they are fragments of one JSON document, not
 * separate values, and parsing any single one would fail.
 * @param {ToolCallAccumulator} acc The accumulator to mutate.
 * @param {unknown} deltas One chunk's `choices[0].delta.tool_calls`.
 * @return {void}
 */
export const accumulateOpenAi = (
  acc: ToolCallAccumulator,
  deltas: unknown
): void => {
  if (!Array.isArray(deltas)) {
    return;
  }

  for (const entry of deltas) {
    const index = Number((entry as { index?: unknown })?.index ?? 0);
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } })
      ?.function;
    const current = acc.get(index) ?? { id: '', name: '', raw: '' };

    acc.set(index, {
      id: current.id || String((entry as { id?: unknown })?.id ?? ''),
      name: current.name || String(fn?.name ?? ''),
      raw: current.raw + (typeof fn?.arguments === 'string' ? fn.arguments : ''),
    });
  }
};

/**
 * Fold one Anthropic streaming event into the accumulator.
 *
 * Two differences from OpenAI, and both matter here: the id and name arrive on
 * `content_block_start`, BEFORE any arguments, and the arguments come as
 * `input_json_delta.partial_json`. Events for blocks that are not `tool_use` are
 * ignored rather than guessed at, so a text block cannot be mistaken for a call.
 * @param {ToolCallAccumulator} acc The accumulator to mutate.
 * @param {unknown} event One parsed SSE event.
 * @return {void}
 */
export const accumulateAnthropic = (
  acc: ToolCallAccumulator,
  event: unknown
): void => {
  const type = (event as { type?: unknown })?.type;
  const index = Number((event as { index?: unknown })?.index ?? 0);

  if (type === 'content_block_start') {
    const block = (
      event as { content_block?: { type?: unknown; id?: unknown; name?: unknown } }
    )?.content_block;

    if (block?.type === 'tool_use') {
      acc.set(index, {
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        raw: '',
      });
    }
    return;
  }

  if (type === 'content_block_delta') {
    const partial = (event as { delta?: { type?: unknown; partial_json?: unknown } })
      ?.delta;

    if (partial?.type !== 'input_json_delta' || typeof partial.partial_json !== 'string') {
      return;
    }

    const current = acc.get(index);

    // A delta with no start is a protocol surprise rather than a call. Skipping it
    // keeps the accumulator from inventing an entry that has no name, which
    // `finishToolCalls` would then drop anyway.
    if (current) {
      acc.set(index, { ...current, raw: current.raw + partial.partial_json });
    }
  }
};

/**
 * The calls an accumulator assembled, in index order.
 *
 * Ordered by index because that is the order the model emitted them; any other
 * order would hand the model its own results out of sequence, which reads as a
 * different question. A call with no name is dropped: it cannot be dispatched, and
 * it is a fragment the stream never completed rather than a tool the model chose.
 * @param {ToolCallAccumulator} acc The accumulator.
 * @return {AiToolCall[]} The calls, arguments decoded.
 */
export const finishToolCalls = (acc: ToolCallAccumulator): AiToolCall[] =>
  [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => {
      const decoded = decodeArguments(call.raw);

      return {
        id: call.id,
        name: call.name,
        args: decoded.args,
        ...(decoded.malformed ? { malformed: true } : {}),
      };
    })
    .filter(call => call.name.length > 0);

/**
 * The assistant's text in a non-streaming reply.
 *
 * Both dialects return text in a different place, and every caller that renders an
 * answer needs the same string, so it is read here rather than in the component.
 * @param {unknown} reply The parsed response body.
 * @param {'claude' | 'openai'} provider Which dialect to read.
 * @return {string} The text, or an empty string when the reply carried none.
 */
export const replyText = (
  reply: unknown,
  provider: 'claude' | 'openai'
): string => {
  if (provider === 'claude') {
    const content = (reply as { content?: unknown })?.content;

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter(
        (block): block is { text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
      )
      .map(block => block.text)
      .join('');
  }

  const content = (
    reply as { choices?: { message?: { content?: unknown } }[] }
  )?.choices?.[0]?.message?.content;

  return typeof content === 'string' ? content : '';
};
