import {
  AI_TOOLS,
  CLIENT_SIDE_PATH,
  accumulateAnthropic,
  accumulateOpenAi,
  anthropicToolCalls,
  anthropicToolTurns,
  anthropicTools,
  availableTools,
  finishToolCalls,
  newToolCallAccumulator,
  openaiToolCalls,
  openaiToolTurns,
  openaiTools,
  replyText,
  resolveToolCall,
  toolByName,
  type AiToolCall,
} from './ai-tools.fun';

/**
 * The gate on model output.
 *
 * A tool call is untrusted input: the model can name a tool that does not exist,
 * name one that was never offered, or emit arguments that are not an object. The
 * dispatcher runs `resolveToolCall` before anything executes, so these cases are
 * where a hallucinated name turns into a refusal instead of a request.
 */
describe('resolveToolCall', () => {
  const call = (name: string, args: unknown = {}): AiToolCall => ({
    id: 'call-1',
    name,
    args: args as Record<string, unknown>,
  });

  it('resolves an offered tool', () => {
    const resolved = resolveToolCall(call('scrape', { url: 'https://example.com' }));

    expect(resolved.ok).toBeTrue();
    if (resolved.ok) {
      expect(resolved.tool.path).toBe('/api/scrape');
    }
  });

  it('reports a name that is not a tool at all', () => {
    // A hallucinated name and a deliberate refusal are different problems, and a
    // caller that conflates them cannot tell them apart in the transcript.
    expect(resolveToolCall(call('send_email')).ok).toBeFalse();
    const resolved = resolveToolCall(call('send_email'));
    if (!resolved.ok) {
      expect(resolved.reason).toBe('unknown-tool');
    }
  });

  it('reports a real tool that was never offered', () => {
    const resolved = resolveToolCall(call('pdf', { op: 'page' }));

    expect(resolved.ok).toBeFalse();
    if (!resolved.ok) {
      expect(resolved.reason).toBe('not-offered');
    }
  });

  it('reports arguments that are not an object', () => {
    // The model can emit null, a string, or an array where an object belongs.
    for (const bad of [null, 'https://example.com', ['url']]) {
      const resolved = resolveToolCall(call('scrape', bad));
      expect(resolved.ok).toBeFalse();
      if (!resolved.ok) {
        expect(resolved.reason).toBe('bad-arguments');
      }
    }
  });
});

describe('offered tools', () => {
  it('offers only the tools marked available', () => {
    // An inventory rather than a filter check, deliberately: `availableTools()`
    // already filters, so this pins WHICH tools a model is handed. Adding one
    // above means editing this list, which is the moment to ask whether it
    // belongs in a chat turn at all.
    const offered = availableTools().map(tool => tool.name);

    expect(offered).toEqual([
      'search',
      'scrape',
      'serp',
      'guide',
      'navigate',
      'observe',
      'list_sessions',
      'list_storage',
      'list_machines',
      'stop_session',
      'stop_machine',
      'suspend_machine',
      'delete_file',
      'save_file',
      'set_spend_cap',
      'set_model',
    ]);
  });

  it('defines every tool it offers', () => {
    // The failure this prevents: a name offered to a model with no spec behind
    // it, which the dispatcher would then refuse at call time.
    for (const tool of availableTools()) {
      expect(toolByName(tool.name)).toBe(tool);
    }
  });

  it('offers a paid-only tool to a paid caller and not to a free one', () => {
    // The defect this fixes: `vision` is a paid ROUTE, and one static boolean denied it
    // to a paying customer it would have worked for -- with nothing on screen to say
    // why. The route still enforces the plan, so this is the OFFER gate, not the
    // boundary; the worst a bug here can do is withhold a capability.
    const names = (paid: boolean): readonly string[] =>
      availableTools(paid).map(tool => tool.name);

    expect(names(true)).toContain('vision');
    expect(names(false)).not.toContain('vision');
  });

  it('names a reason for every tool it does not offer', () => {
    // The invariant the TYPE cannot express, which is why it is pinned here: a tool
    // switched off with no recorded reason hands the model a bare "unavailable" that
    // fits none of the four remedies.
    for (const tool of AI_TOOLS) {
      if (tool.available) {
        continue;
      }

      expect(tool.blocked).withContext(`${tool.name} is off with no reason`).toBeDefined();
      // `plan` is DERIVED from `paidOnly`, so a statically-blocked tool must not claim
      // it: that would tell the user to upgrade for something an upgrade cannot buy.
      expect(tool.blocked).not.toBe('plan');
    }
  });

  it('carries the reason on the refusal, and resolves the plan one per caller', () => {
    // `plan` is the only reason that depends on WHO is asking, so the same call
    // resolves two ways -- which is the whole point of the union.
    const call = (name: string) => ({ id: 'c1', name, args: {} });

    // `pdf` is `session`, NOT `unbuilt`. The gate used to claim the platform
    // needs an upload route for it, which it does not: `op=page` renders the page
    // the browser is already on, and the other ops read a path that
    // `download <url>` can fill, so a URL is enough to put a PDF where it reads.
    // The real blocker is the one `extract` has -- a page and a filesystem a
    // session owns.
    expect(resolveToolCall(call('pdf'), false))
      .toEqual(jasmine.objectContaining({ block: 'session' }));
    expect(resolveToolCall(call('extract'), false))
      .toEqual(jasmine.objectContaining({ block: 'session' }));
    expect(resolveToolCall(call('extract_schema'), false))
      .toEqual(jasmine.objectContaining({ block: 'spend' }));
    expect(resolveToolCall(call('vision'), false))
      .toEqual(jasmine.objectContaining({ block: 'plan' }));

    // And the same call the same caller was refused a moment ago now runs.
    expect(resolveToolCall(call('vision'), true).ok).toBeTrue();
  });

  it('gives every tool either a real route or the client-side sentinel', () => {
    // `available: false` means the route cannot serve a chat caller, not that the
    // route is absent -- so a typo in `path` would have surfaced as a 404. That check
    // still holds for every tool that HAS a route. The single exception is the tool
    // the component answers itself, which has no route to typo.
    for (const tool of AI_TOOLS) {
      if (tool.path !== CLIENT_SIDE_PATH) {
        expect(tool.path.startsWith('/api/')).toBeTrue();
      }
    }

    // Pinned to exactly ONE, so the exception cannot quietly become the norm: if a
    // second route-less tool is ever added, this fails and forces the decision rather
    // than letting the rule evaporate one entry at a time.
    expect(
      AI_TOOLS.filter(tool => tool.path === CLIENT_SIDE_PATH).map(tool => tool.name)
    ).toEqual(['set_model']);
  });
});

describe('provider payloads', () => {
  const specs = availableTools();

  it('names the schema field differently per provider', () => {
    // Anthropic calls it `input_schema`, OpenAI calls it `parameters`. Getting
    // this wrong is a 400 from the provider, not a silent failure.
    expect(Object.keys(anthropicTools(specs)[0])).toContain('input_schema');
    expect(anthropicTools(specs)[0]['parameters']).toBeUndefined();
    expect(
      (openaiTools(specs)[0]['function'] as Record<string, unknown>)['parameters']
    ).toBeDefined();
    expect(openaiTools(specs)[0]['input_schema']).toBeUndefined();
  });

  it('wraps each OpenAI tool in a function envelope', () => {
    expect(openaiTools(specs)[0]['type']).toBe('function');
  });
});

describe('reply parsing', () => {
  it('reads Anthropic tool_use blocks, whose input is already an object', () => {
    const calls = anthropicToolCalls({
      content: [
        { type: 'text', text: 'looking that up' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } },
      ],
    });

    expect(calls).toEqual([{ id: 'tu_1', name: 'search', args: { q: 'x' } }]);
  });

  it('reads OpenAI tool_calls, whose arguments are a JSON string', () => {
    const calls = openaiToolCalls({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_a',
                function: { name: 'scrape', arguments: '{"url":"https://e.com"}' },
              },
            ],
          },
        },
      ],
    });

    expect(calls).toEqual([
      { id: 'call_a', name: 'scrape', args: { url: 'https://e.com' } },
    ]);
  });

  it('survives a malformed arguments string rather than throwing', () => {
    // OpenAI streams `arguments` as concatenated fragments, so a truncated one is
    // expected rather than exceptional. It must become bad-arguments, and it must
    // not lose the sibling call beside it.
    const calls = openaiToolCalls({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'a', function: { name: 'scrape', arguments: '{"url":' } },
              { id: 'b', function: { name: 'search', arguments: '{"q":"ok"}' } },
            ],
          },
        },
      ],
    });

    expect(calls.length).toBe(2);
    expect(calls[0].args).toEqual({});
    expect(calls[1].args).toEqual({ q: 'ok' });
    expect(resolveToolCall(calls[0]).ok).toBeFalse();
    expect(resolveToolCall(calls[1]).ok).toBeTrue();
  });

  it('returns nothing for a reply with no tool calls', () => {
    expect(anthropicToolCalls({ content: [{ type: 'text', text: 'hi' }] })).toEqual([]);
    expect(openaiToolCalls({ choices: [{ message: { content: 'hi' } }] })).toEqual([]);
    // Defensive shapes: a caller passing an error body must not throw.
    expect(anthropicToolCalls(null)).toEqual([]);
    expect(openaiToolCalls({})).toEqual([]);
    expect(openaiToolCalls({ choices: [] })).toEqual([]);
  });
});

/**
 * The streaming accumulators.
 *
 * This is where the fragments get assembled, and it is the part a streamed reply
 * turns into a dispatch. OpenAI sends arguments split MID-TOKEN and identifies the
 * call by `index`, not by `id`; Anthropic sends the name before the arguments and
 * the arguments as `partial_json`. Getting either wrong produces a call that parses
 * to nothing, which is the failure the `malformed` flag exists to make visible.
 */
describe('streaming tool-call assembly', () => {
  it('joins OpenAI argument fragments, taking id and name from the first chunk', () => {
    const acc = newToolCallAccumulator();

    accumulateOpenAi(acc, [
      {
        index: 0,
        id: 'call_a',
        function: { name: 'scrape', arguments: '{"url":"https://e' },
      },
    ]);
    accumulateOpenAi(acc, [{ index: 0, function: { arguments: '.com"}' } }]);

    expect(finishToolCalls(acc)).toEqual([
      { id: 'call_a', name: 'scrape', args: { url: 'https://e.com' } },
    ]);
  });

  it('keeps parallel OpenAI calls apart by index', () => {
    const acc = newToolCallAccumulator();

    accumulateOpenAi(acc, [
      { index: 0, id: 'a', function: { name: 'search', arguments: '{"q":"x"}' } },
      { index: 1, id: 'b', function: { name: 'scrape', arguments: '{"url":"u"}' } },
    ]);

    expect(finishToolCalls(acc).map(call => call.id)).toEqual(['a', 'b']);
  });

  it('assembles Anthropic calls from content_block_start plus partial_json', () => {
    const acc = newToolCallAccumulator();

    accumulateAnthropic(acc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'search' },
    });
    accumulateAnthropic(acc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    });
    accumulateAnthropic(acc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"cats"}' },
    });

    expect(finishToolCalls(acc)).toEqual([
      { id: 'tu_1', name: 'search', args: { q: 'cats' } },
    ]);
  });

  it('ignores text blocks and deltas that have no start', () => {
    const acc = newToolCallAccumulator();

    accumulateAnthropic(acc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    });
    accumulateAnthropic(acc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
    });

    // A text block is not a call, and a delta with no start cannot invent one.
    // Either mistake would dispatch a tool the model never chose.
    expect(finishToolCalls(acc)).toEqual([]);
  });

  it('marks a truncated stream rather than treating it as no arguments', () => {
    const acc = newToolCallAccumulator();

    accumulateOpenAi(acc, [
      { index: 0, id: 'a', function: { name: 'scrape', arguments: '{"url":' } },
    ]);

    const calls = finishToolCalls(acc);

    expect(calls[0].malformed).toBeTrue();
    expect(resolveToolCall(calls[0]).ok).toBeFalse();
  });

  it('drops a call that never received a name', () => {
    const acc = newToolCallAccumulator();

    // A fragment with no name cannot be dispatched, and it is an incomplete stream
    // rather than a tool the model chose.
    accumulateAnthropic(acc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    });

    expect(finishToolCalls(acc)).toEqual([]);
  });
});

describe('replyText', () => {
  it('reads text blocks for Claude and message.content for OpenAI', () => {
    expect(
      replyText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 'claude')
    ).toBe('ab');
    expect(replyText({ choices: [{ message: { content: 'hi' } }] }, 'openai')).toBe('hi');
  });

  it('returns an empty string rather than throwing on an unexpected shape', () => {
    expect(replyText(null, 'claude')).toBe('');
    expect(replyText({}, 'openai')).toBe('');
    // A tool-only Claude reply carries no text block at all.
    expect(
      replyText({ content: [{ type: 'tool_use', id: 'x', name: 'search' }] }, 'claude')
    ).toBe('');
  });
});

/**
 * The turns a tool round appends to the conversation.
 *
 * These shapes are protocol contracts rather than preferences: Anthropic rejects a
 * `tool_result` with no preceding assistant `tool_use` block, and OpenAI rejects
 * Anthropic's shape outright. Neither failure is visible to `tsc` or to a component
 * test -- it appears only against a live provider, which is what makes it worth
 * pinning here.
 */
describe('tool result turns', () => {
  const calls: AiToolCall[] = [
    { id: 'a', name: 'search', args: { q: 'x' } },
    { id: 'b', name: 'pdf', args: { op: 'page' } },
  ];
  const results = [
    { call: calls[0], content: '{"status":"ok"}' },
    { call: calls[1], content: 'The tool "pdf" is not available here.' },
  ];

  it('echoes every call before reporting any result, for Claude', () => {
    const turns = anthropicToolTurns(calls, results);

    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].content).toEqual([
      { type: 'tool_use', id: 'a', name: 'search', input: { q: 'x' } },
      { type: 'tool_use', id: 'b', name: 'pdf', input: { op: 'page' } },
    ]);
    expect(turns[1].role).toBe('user');
    expect(turns[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: '{"status":"ok"}' },
      {
        type: 'tool_result',
        tool_use_id: 'b',
        content: 'The tool "pdf" is not available here.',
      },
    ]);
  });

  it('answers a refused call too, because a missing result is a 400', () => {
    // The refusal IS the result. Omitting it would leave a `tool_use` block with
    // nothing answering it, which Anthropic rejects before it reads the question.
    const refused = anthropicToolTurns([calls[1]], [results[1]]);
    const blocks = refused[1].content as { tool_use_id: string }[];

    expect(blocks.length).toBe(1);
    expect(blocks[0].tool_use_id).toBe('b');
  });

  it('uses a different shape for OpenAI, with arguments as a JSON string', () => {
    const turns = openaiToolTurns(calls, results);

    expect(turns.length).toBe(3);
    expect(turns[0].role).toBe('assistant');
    // `null`, not an empty string: an assistant turn that carries calls has no text.
    expect(turns[0].content).toBeNull();
    expect(turns[0].tool_calls).toEqual([
      {
        id: 'a',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"x"}' },
      },
      {
        id: 'b',
        type: 'function',
        function: { name: 'pdf', arguments: '{"op":"page"}' },
      },
    ]);
    // ONE turn per result, each joined back by id -- not one combined user turn.
    expect(turns[1]).toEqual({
      role: 'tool',
      tool_call_id: 'a',
      content: '{"status":"ok"}',
    });
    expect(turns[2]).toEqual({
      role: 'tool',
      tool_call_id: 'b',
      content: 'The tool "pdf" is not available here.',
    });
  });
});
