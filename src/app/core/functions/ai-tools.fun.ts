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
 * `AI_MODEL_VENDOR` and `vendorForModel` make.
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
 * Each of those is a DIFFERENT remedy, which is why the refusal carries a
 * `ToolBlock` rather than a bare `false`: the model has to be able to tell the user
 * which one applies. See `ToolBlock`.
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

/**
 * Why a tool is not offered to a chat caller.
 *
 * A reason rather than a bare `false` because the remedies differ and the user is
 * owed the RIGHT one: `plan` is fixed by an upgrade, `session` by opening a browser
 * session and driving it there, and nothing the user can do fixes `unbuilt` or
 * `spend`. A model told only "unavailable" either gives up on a tool the user could
 * have had, or promises an upgrade that would not have helped.
 */
export type ToolBlock = 'plan' | 'session' | 'unbuilt' | 'spend';

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
  /**
   * Offered only to a caller whose access mode is paid.
   *
   * The route enforces the same thing, so this is the OFFER gate rather than the
   * security boundary: `/api/vision` answers 402 for a free caller whether or not
   * the model was offered the tool. It exists because a single static boolean could
   * not express "a paying caller may, a free one may not" -- so a paid customer was
   * denied a tool that would have worked for them, and nothing said why.
   */
  readonly paidOnly?: boolean;
  /**
   * Why this tool is not offered, REQUIRED whenever `available` is false.
   *
   * The pair is pinned by a spec rather than by the type, because a tool switched
   * off with no recorded reason leaves the model with nothing to tell the user.
   */
  readonly blocked?: ToolBlock;
  /**
   * Whether the user must approve this tool before it runs.
   *
   * Set on anything that CHANGES something. The loop executes a model's call the
   * instant it parses it, so without this a write tool would act on the model's
   * say-so alone -- and the same context carries `scrape` and `navigate` output,
   * which is text a third party wrote. A read tool is safe under that; a write
   * tool is not.
   *
   * One flag rather than a `read | write | destroy` enum: the UI does the same
   * thing for every one of them -- show the call, wait for a click -- and a
   * distinction nothing branches on is a distinction that rots.
   */
  readonly requiresConfirm?: boolean;
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
 * The `path` of a tool the CHAT COMPONENT answers rather than a route.
 *
 * Exported so the one exception to "every path names a real route" is STATED rather
 * than spelled. The spec asserts that every other tool's path begins with `/api/` and
 * that exactly ONE tool uses this, so a second route-less tool fails the suite instead
 * of quietly widening the rule.
 *
 * The value is deliberately not a URL. Writing `/api/...` here would satisfy that check
 * while naming an endpoint nothing serves -- the plausible-wrong-answer failure this
 * codebase treats as worse than an error.
 */
export const CLIENT_SIDE_PATH = 'client';

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
    // Reads the CURRENT page of a browser session, so it needs one nobody else is
    // in. Chat never has one; a session the user opened does.
    blocked: 'session',
  },
  {
    name: 'pdf',
    description:
      'Work on a PDF the worker can reach: the page it is on, or a file it ' +
      'already holds. Needs a session whose page and files the caller ' +
      'controls, so it is not offered in chat.',
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
    // An upload route is NOT what this needs, which an earlier version of this
    // entry claimed. `op=page` renders the page the browser is ALREADY on, and
    // the other three ops read a path that `download <url>` can fill, so a URL
    // is enough to put a PDF where this reads. The real blocker is the one
    // `extract` has: it reads a page and a filesystem a session owns.
    blocked: 'session',
  },
  {
    name: 'vision',
    description:
      'Local vision over screenshot pixels on the worker. A paid route: offered to ' +
      'a paid caller, and refused for a free one by both this gate and the route.',
    parameters: object(
      {
        op: enumOf('The vision operation.', ['index', 'retrieve', 'ask']),
        prompt: string('The question to ask about the image.'),
      },
      ['op']
    ),
    path: '/api/vision',
    available: true,
    // The one tool whose availability is per-CALLER rather than static. A single
    // boolean used to deny this to a paying customer it would have worked for,
    // with nothing on screen to say why.
    paidOnly: true,
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
    // Bills the platform key per call, which is a spend decision rather than a chat
    // feature. The caller's own credits do not enter into it.
    blocked: 'spend',
  },

    // ---- Browser escalation --------------------------------------------------
    //
    // These three close the ladder the tools above start. `/api/scrape` is plain
    // HTTP and reports whether a page turned out to be a JavaScript shell;
    // `navigate` is what turns that signal into an answer, `observe` reads a page
    // the caller is already on, and `guide` costs nothing.
    //
    // The other seven webrain tools are deliberately ABSENT, and the reasons are
    // different kinds. `interact`, `batch` and `crawl` are long-running or want a
    // browser the caller is watching. `eval` and `eval_in_frame` run arbitrary
    // JavaScript. `download` and `watch` cost bandwidth proportional to the
    // payload. None belongs inside a chat turn -- and a tool the model is offered
    // is a tool the model WILL call.
    {
      name: 'guide',
      description:
        'Read the browser engine decision guide: which engine or tool fits a job, ' +
        'how to get past a challenge, the extraction matrix. Free, starts no ' +
        'browser, takes no arguments. Call it FIRST when unsure which tool to use.',
      parameters: object({}),
      path: '/api/guide',
      available: true,
    },
    {
      name: 'navigate',
      description:
        'Open a URL in a real browser and return the page state: title, visible ' +
        'text, interactive elements and same-origin links. Use when scrape reported ' +
        'needs_js, or for a JavaScript app, cookie wall or challenge. Paid plan.',
      parameters: object(
        {
          url: string('The absolute URL to open.'),
          css_selector: string('Narrow the returned text to this element.'),
          wait_selector: string('Wait for this CSS selector before reading.'),
        },
        ['url']
      ),
      path: '/api/navigate',
      available: true,
    },
    {
      name: 'observe',
      description:
        'Read the page the browser is CURRENTLY on, without navigating. Choose what ' +
        'to read: state, a11y (accessibility tree), semantic, clean (boiled text), ' +
        'html, console, screenshot, images, media and more. Use after navigate when ' +
        'its visible text is not the shape you need. Paid plan.',
      parameters: object(
        {
          what: enumOf('What to read from the page.', [
            'state',
            'a11y',
            'semantic',
            'html',
            'images',
            'console',
            'flatten',
            'fit',
            'clean',
            'screenshot',
            'pixel',
            'page_info',
            'annotate',
            'media',
          ]),
          selector: string('html: narrow to this CSS selector.'),
          max_nodes: {
            type: 'number',
            description: 'a11y: node cap.',
          },
        },
        ['what']
      ),
      path: '/api/observe',
      available: true,
    },
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

  // ---- Write tools ---------------------------------------------------------
  //
  // The first family here that CHANGES anything, and the reason
  // `requiresConfirm` exists. What is deliberately absent, and why, is recorded
  // in `docs/roadmap/15-chat-write-tools.md` -- read it before adding one,
  // because the reasoning is per-tool and not a blanket rule.
  //
  // Every entry in this family sets `requiresConfirm`, and that is not optional:
  // the chat parks a whole batch when ANY call in it asks for approval, and the
  // flag is how a call asks. An entry here without it runs the moment the model
  // names it.
  //
  // Session and machine lifecycle ONLY, and only in the STOPPING direction.
  // Stopping reduces spend, so the blast radius of a wrong call is a smaller bill
  // rather than a destroyed resource. `destroy` is deliberately not here: a
  // session machine can be destroyed while its RECORD survives, and
  // `chargeSessionMeter` bills from the record -- so a destroyed session machine
  // leaves the customer paying to the ceiling with nothing left to connect to.
  // That is exactly what `refuseSessionOwnedAction()` guards in the machines
  // page, and these tools route through the same service the page uses rather
  // than around it.
  {
    name: 'stop_session',
    description:
      'End a browser session that is open, and stop its meter. Use when asked to ' +
      'stop a session, or to stop something that is still costing money. This ' +
      'runs the final meter charge, so it is the action that STOPS billing. Call ' +
      'list_sessions first to get the id. Cannot be undone.',
    parameters: object(
      {
        session_id: string('The session id, from list_sessions.'),
      },
      ['session_id']
    ),
    path: '/api/browser/session',
    available: true,
    requiresConfirm: true,
  },
  {
    name: 'stop_machine',
    description:
      'Stop a dedicated machine the caller owns, so it stops running. Use when asked ' +
      'to stop a machine, or to stop something that is still costing money. Call ' +
      'list_machines first to get the id. Refused for a machine that belongs to a ' +
      'browser session: call stop_session for that one instead, because stopping the ' +
      'machine leaves the session record billing with nothing left to connect to.',
    parameters: object(
      {
        machine_id: string('The machine id, from list_machines.'),
      },
      ['machine_id']
    ),
    path: '/api/machines/machine/:machineId/stop',
    available: true,
    requiresConfirm: true,
  },
  {
    name: 'suspend_machine',
    description:
      'Suspend a dedicated machine the caller owns: it stops running but is kept so it ' +
      'can be started later. Use when asked to pause or shelve a machine. Call ' +
      'list_machines first to get the id. Refused for a machine that belongs to a ' +
      'browser session -- end the session instead.',
    parameters: object(
      {
        machine_id: string('The machine id, from list_machines.'),
      },
      ['machine_id']
    ),
    path: '/api/machines/machine/:machineId/suspend',
    available: true,
    requiresConfirm: true,
  },
  {
    name: 'delete_file',
    description:
      'Delete one file the caller has saved, by its key. Call list_storage first ' +
      'to get the key. This cannot be undone. Refused for a shared cache object, ' +
      'which the caller does not own, and a key that is already gone is a ' +
      'success rather than an error.',
    parameters: object(
      {
        key: string('The object key, from list_storage.'),
      },
      ['key']
    ),
    path: '/api/storage/delete',
    available: true,
    requiresConfirm: true,
  },
  {
    name: 'save_file',
    description:
      'Fetch a URL once and keep the result as a file the caller can open or ' +
      'download later. Use when asked to save, archive or keep a page. Returns the ' +
      'key that list_storage shows. Keeps the caller\'s own copy; it does not make ' +
      'the file public or shared.',
    parameters: object(
      {
        url: string('The absolute URL to fetch and keep.'),
        filename: string('A display name for the saved file.'),
      },
      ['url']
    ),
    path: '/api/storage/save',
    available: true,
    requiresConfirm: true,
  },
  {
    name: 'set_spend_cap',
    description:
      'Set the caller\'s own spend cap for the current billing period. The unit is ' +
      'CREDITS, not money, and 0 means no cap at all. Use when asked to cap, limit ' +
      'or budget spend; if the user spoke in currency, ask what that is in credits ' +
      'rather than converting. This is a limit on FUTURE spend, so lowering it can ' +
      'stop work that is already running.',
    parameters: object(
      {
        spend_cap_credits: {
          type: 'number',
          description: 'The cap in credits. 0 removes the cap. Whole numbers only.',
        },
      },
      ['spend_cap_credits']
    ),
    path: '/api/billing/policy',
    available: true,
    requiresConfirm: true,
  },
  {
    /**
     * The only tool here with no route.
     *
     * It is answered by the chat component itself, because the model selection is a
     * FORM CONTROL in that component rather than anything the platform stores. That
     * also makes it the one write whose effect the user watches land -- the picker
     * moves as the call runs -- and that visibility is the whole reason a model
     * choosing a model is tolerable at all.
     *
     * `path` is still required by the spec's type; nothing reads it to dispatch,
     * because the switch is on the NAME. `client` says where the change lands rather
     * than pretending to be a URL no request will ever reach.
     */
    name: 'set_model',
    description:
      'Change which model answers the next turns of this conversation. Use when the ' +
      'user asks to switch models, or for a cheaper or stronger one. The value is a ' +
      'model ID exactly as the model picker shows it. If it is not one that is ' +
      'offered, this tool returns the IDs that are, so call it again with one of ' +
      'those instead of guessing. It does not re-answer anything already asked, and ' +
      'it cannot select a model the account holds no key for.',
    parameters: object(
      {
        model: string('The model ID, exactly as the picker shows it.'),
      },
      ['model']
    ),
    path: CLIENT_SIDE_PATH,
    available: true,
    requiresConfirm: true,
  },
];
export const availableTools = (paid = false): readonly AiToolSpec[] =>
  AI_TOOLS.filter(tool => offeredTo(tool, paid));

/**
 * Whether this caller may be offered this tool.
 *
 * A caller with no recorded access mode is treated as free, which is the
 * conservative direction: the offer list shrinks, and the route behind the tool
 * still enforces, so the worst case is a capability withheld rather than granted.
 * @param {AiToolSpec} tool The tool to test.
 * @param {boolean} paid Whether the caller's access mode is a paid one.
 * @return {boolean} True when the model may be offered it.
 */
export const offeredTo = (tool: AiToolSpec, paid: boolean): boolean =>
  tool.available && (!tool.paidOnly || paid);

/**
 * Why a tool cannot be offered to this caller. Never called for one that can.
 * @param {AiToolSpec} tool The refused tool.
 * @param {boolean} paid Whether the caller's access mode is a paid one.
 * @return {ToolBlock | undefined} The remedy, or undefined when none is recorded.
 */
export const blockFor = (tool: AiToolSpec, paid: boolean): ToolBlock | undefined =>
  tool.paidOnly === true && !paid ? 'plan' : tool.blocked;

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
  | {
      ok: false;
      name: string;
      reason: ToolCallRefusal;
      /** Why it was never offered, so the model can name the RIGHT remedy. */
      block?: ToolBlock;
    };

/**
 * Whether a call may run, and against which tool.
 *
 * The order matters for the message, not the outcome: a name that does not exist
 * is a different problem from a real tool that was never offered, and a caller
 * that conflates them cannot tell a hallucinated name from a deliberate refusal.
 * @param {AiToolCall} call The call as the model emitted it.
 * @param {boolean} paid Whether the caller's access mode is a paid one.
 * @return {ToolCallResolution} The tool to run, or why not.
 */
export const resolveToolCall = (
  call: AiToolCall,
  paid = false,
): ToolCallResolution => {
  const tool = toolByName(call.name);

  if (!tool) {
    return { ok: false, name: call.name, reason: 'unknown-tool' };
  }

  if (!offeredTo(tool, paid)) {
    // The reason rides WITH the refusal. A bare "not available" fits none of the
    // four remedies, and the model has no other way to learn which applies.
    return {
      ok: false,
      name: call.name,
      reason: 'not-offered',
      block: blockFor(tool, paid),
    };
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
