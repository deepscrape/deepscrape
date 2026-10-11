import {
  AI_TOOLS,
  anthropicToolCalls,
  anthropicTools,
  availableTools,
  openaiToolCalls,
  openaiTools,
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
    const offered = availableTools().map(tool => tool.name);

    expect(offered).toEqual(['search', 'scrape', 'serp']);
  });

  it('defines every tool it offers', () => {
    // The failure this prevents: a name offered to a model with no spec behind
    // it, which the dispatcher would then refuse at call time.
    for (const tool of availableTools()) {
      expect(toolByName(tool.name)).toBe(tool);
    }
  });

  it('marks each unavailable tool with a route that exists', () => {
    // `available: false` means the route cannot serve a chat caller, not that the
    // route is absent. A typo in `path` would surface as a 404 instead.
    for (const tool of AI_TOOLS) {
      expect(tool.path.startsWith('/api/')).toBeTrue();
    }
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
