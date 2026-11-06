import { attachmentPrompt, buildHistory, buildRequest, filesInContent, formatParams, isAtBottom, notOfferedText, pickerTab, reasoningParams, refusalText, sessionMatches, sessionTitle, toChatMessage, toChatSession, tokenUsage, toolResultText, toolsForMode } from './chatai.component';
import type { ChatMessage } from './chatai.component';
import { availableTools } from 'src/app/core/functions';

describe('buildHistory', () => {
    it('appends the prompt after the existing turns', () => {
        const history = buildHistory(
            [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello' },
            ],
            'next',
        );

        expect(history).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'next' },
        ]);
    });

    it('drops the blank assistant turn a failed stream leaves behind', () => {
        const history = buildHistory(
            [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: '   ' },
            ],
            'next',
        );

        expect(history.map(message => message.content)).toEqual(['hi', 'next']);
    });

    it('replays an earlier turn image, so a follow-up can refer to it', () => {
        const history = buildHistory(
            [{ id: 'u1', role: 'user', content: 'what is this' }],
            'and the axis labels?',
            'claude',
            id => (id === 'u1' ? [{ mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' }] : []),
        );

        expect(Array.isArray(history[0].content)).toBe(true);
        expect(history[1].content).toBe('and the axis labels?');
    });

    it('replays a restored turn from a link, because a reload holds no bytes', () => {
        const history = buildHistory(
            [{ id: 'u1', role: 'user', content: 'what is this' }],
            'and now?',
            'openai',
            id => (id === 'u1' ? [{ mime: 'image/png', url: 'https://s.example/x.png' }] : []),
        );

        const parts = history[0].content as { image_url: { url: string } }[];

        expect(parts[0].image_url.url).toBe('https://s.example/x.png');
    });

    it('leaves a turn with no images a plain string', () => {
        const history = buildHistory(
            [{ id: 'u1', role: 'user', content: 'hi' }],
            'next',
            'claude',
            () => [],
        );

        expect(history[0].content).toBe('hi');
    });
});

describe('buildRequest', () => {
    it('sends the messages untouched for Claude, which takes the system turn separately', () => {
        const messages = [{ role: 'user', content: 'hi' }];

        expect(buildRequest('claude', messages, 'SYS'))
            .toEqual({ provider: 'claude', vendor: 'anthropic', messages });
    });

    it('inlines the system turn for OpenAI/Groq, which ignore their sys argument otherwise', () => {
        expect(buildRequest('openai', [{ role: 'user', content: 'hi' }], 'SYS')).toEqual({
            provider: 'openai',
            vendor: 'openai',
            messages: [
                { role: 'system', content: 'SYS' },
                { role: 'user', content: 'hi' },
            ],
        });
    });

    it('carries the vendor a vendor-specific code names, so the call reaches that vendor', () => {
        // The protocol is shared and the COMPANY is not: without this the request would be
        // posted to OpenAI with a DeepSeek model id on the caller's key.
        const request = buildRequest('deepseek', [{ role: 'user', content: 'hi' }], 'SYS');

        expect(request.provider).toBe('openai');
        expect(request.vendor).toBe('deepseek');
    });

    it('carries the custom vendor, whose endpoint belongs to the caller', () => {
        const request = buildRequest('custom', [{ role: 'user', content: 'hi' }], 'SYS');

        expect(request.provider).toBe('openai');
        expect(request.vendor).toBe('custom');
    });
});

describe('refusalText', () => {
    it('names the problem, so the model can correct itself', () => {
        // The three reasons are genuinely different problems, and the model is given a
        // different instruction for each. A refusal that said only "error" would leave it
        // nothing to act on -- which is the whole reason to refuse rather than drop.
        expect(refusalText({ ok: false, name: 'send_email', reason: 'unknown-tool' }))
            .toContain('send_email');
        expect(refusalText({ ok: false, name: 'pdf', reason: 'not-offered' }))
            .toContain('not available');
        expect(refusalText({ ok: false, name: 'scrape', reason: 'bad-arguments' }))
            .toContain('valid JSON');
    });

    it('names WHICH remedy, because the four are not interchangeable', () => {
        // "Not available here" is true in all four cases and useful in none: it either
        // talks the user out of a capability they could have had, or promises an upgrade
        // that would not have helped. Each line has to name the thing that would fix it.
        expect(notOfferedText({ ok: false, name: 'vision', reason: 'not-offered', block: 'plan' }))
            .toContain('paid plan');
        expect(notOfferedText({ ok: false, name: 'extract', reason: 'not-offered', block: 'session' }))
            .toContain('browser session');
        expect(notOfferedText({ ok: false, name: 'extract_schema', reason: 'not-offered', block: 'spend' }))
            .toContain('platform');
        expect(notOfferedText({ ok: false, name: 'pdf', reason: 'not-offered', block: 'unbuilt' }))
            .toContain('not available');
    });

    it('still answers for a refusal with no reason recorded', () => {
        // Reachable because `block` is optional: an older resolution, or a tool switched
        // off before a reason was required, must still produce a usable line rather than
        // an empty string the model cannot act on.
        expect(notOfferedText({ ok: false, name: 'pdf', reason: 'not-offered' }).length)
            .toBeGreaterThan(0);
    });
});

describe('toolResultText', () => {
    it('passes a small answer through as JSON', () => {
        expect(toolResultText({ status: 'ok' })).toBe('{"status":"ok"}');
    });

    it('caps a large answer rather than spending the context window on it', () => {
        // One scrape of a large page would otherwise fill the context on a single tool
        // result, and the caller pays for that again on the answering round.
        const huge = toolResultText({ text: 'x'.repeat(20000) });

        expect(huge.length).toBeLessThan(6200);
        expect(huge.endsWith('[truncated]')).toBeTrue();
    });

    it('returns an empty string for a value JSON cannot represent', () => {
        expect(toolResultText(undefined)).toBe('');
    });
});

describe('isAtBottom', () => {
    const box = (scrollHeight: number, scrollTop: number, clientHeight: number) =>
        ({ scrollHeight, scrollTop, clientHeight });

    it('is true at the end of a fully scrolled transcript', () => {
        expect(isAtBottom(box(1000, 400, 600))).toBeTrue();
    });

    it('is false once the user has scrolled up past the tolerance', () => {
        // The behaviour this guards: a streaming reply must not pull the reader back down.
        expect(isAtBottom(box(1000, 300, 600))).toBeFalse();
    });

    it('tolerates a fractional offset, which a non-integer pixel ratio produces', () => {
        // An exact `=== 0` test reads as "scrolled up" on a transcript that is visibly at the
        // bottom, and the follow effect would then stop following for good.
        expect(isAtBottom(box(1000, 399.5, 600))).toBeTrue();
    });

    it('is true when the transcript is shorter than the viewport', () => {
        // scrollHeight === clientHeight means nothing to scroll; that is the bottom.
        expect(isAtBottom(box(200, 0, 600))).toBeTrue();
    });
});

describe('tokenUsage', () => {
    it('normalises the OpenAI-family shape', () => {
        expect(tokenUsage({ prompt_tokens: 10, completion_tokens: 4 }))
            .toEqual({ input: 10, output: 4, cached: 0 });
    });

    it('reads the nested cache count those vendors report', () => {
        expect(tokenUsage({
            prompt_tokens: 10,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 8 },
        })).toEqual({ input: 10, output: 4, cached: 8 });
    });

    it('reads DeepSeek, which uses a flat field instead of the nested one', () => {
        expect(tokenUsage({
            prompt_tokens: 10,
            completion_tokens: 4,
            prompt_cache_hit_tokens: 7,
        })).toEqual({ input: 10, output: 4, cached: 7 });
    });

    it('reads Claude, which names the counts differently', () => {
        expect(tokenUsage({ input_tokens: 12, output_tokens: 3 }))
            .toEqual({ input: 12, output: 3, cached: 0 });
    });

    it('reads Anthropic cache reads, reported under their own name', () => {
        // Without this the `cached` figure is always 0 on the vendor whose cache we now ask for,
        // which is the one place a saving would actually be visible.
        expect(tokenUsage({
            prompt_tokens: 12,
            completion_tokens: 3,
            cache_read_input_tokens: 900,
        })).toEqual({ input: 12, output: 3, cached: 900 });
    });

    it('does not count a cache WRITE as a saving', () => {
        // A write is billed at 1.25x. Counting it as cached would overstate what the cache saved.
        expect(tokenUsage({
            prompt_tokens: 12,
            completion_tokens: 3,
            cache_creation_input_tokens: 900,
        })).toEqual({ input: 12, output: 3, cached: 0 });
    });

    it('is null when a chunk carried no counts, so no line renders', () => {
        expect(tokenUsage(null)).toBeNull();
        expect(tokenUsage({})).toBeNull();
    });
});

describe('toChatMessage', () => {
    const turn = (tools: unknown) => ({ id: 'a', role: 'assistant', content: 'answer', at: 1, tools });

    it('defaults a run stored before the status field existed to ok', () => {
        // Those runs really did execute; guessing `failed` would libel a conversation that worked.
        const message = toChatMessage(turn([{ name: 'search', summary: '12' }]));

        expect(message?.tools).toEqual([{ name: 'search', summary: '12', status: 'ok' }]);
    });

    it('keeps the status a run was stored with', () => {
        const message = toChatMessage(turn([{ name: 'vision', summary: '0', status: 'refused' }]));

        expect(message?.tools?.[0]?.status).toBe('refused');
    });

    it('normalises a status it does not recognise instead of rendering an untoneable chip', () => {
        const message = toChatMessage(turn([{ name: 'scrape', summary: '0', status: 'exploded' }]));

        expect(message?.tools?.[0]?.status).toBe('ok');
    });

    it('drops a tool entry that is not shaped like a run', () => {
        const message = toChatMessage(turn([{ name: 'search' }, 'nope', {}]));

        expect(message?.tools).toEqual([]);
    });
});

describe('formatParams', () => {
    it('sends response_format for the vendors whose guides document the field', () => {
        expect(formatParams(true, 'deepseek')).toEqual({ response_format: { type: 'json_object' } });
        expect(formatParams(true, 'openai')).toEqual({ response_format: { type: 'json_object' } });
    });

    it('sends nothing for a vendor that would refuse the field', () => {
        // A wrong field here is a 400 on the caller's key, so the guard is on the WIRE as well as
        // on the switch: the model can be changed after JSON was turned on.
        expect(formatParams(true, 'anthropic')).toEqual({});
        expect(formatParams(true, 'groq')).toEqual({});
        expect(formatParams(true, 'openrouter')).toEqual({});
    });

    it('sends nothing when the switch is off', () => {
        expect(formatParams(false, 'deepseek')).toEqual({});
    });
});

describe('toChatSession pinning', () => {
    const stored = (pinned?: unknown) => ({
        id: 's1',
        title: 'crawl',
        at: 1,
        messages: [{ id: 'm', role: 'user', content: 'hi', at: 1 }],
        pinned,
    });

    it('keeps a pinned conversation pinned across a reload', () => {
        expect(toChatSession(stored(true))?.pinned).toBe(true);
    });

    it('reads a conversation saved before pinning existed as unpinned', () => {
        // Absent is the ordinary case for every row written before the flag, and it must not read
        // as "pinned" the first time a user reloads.
        expect(toChatSession(stored(undefined))?.pinned).toBe(false);
    });
});

describe('toChatMessage media', () => {
    const turn = (media: unknown) => ({ id: 'u1', role: 'user', content: 'hi', at: 1, media });

    it('keeps a filed image, which is what makes a replay possible after a reload', () => {
        const message = toChatMessage(turn([{ key: 'k/1.png', mime: 'image/png', name: 'a.png' }]));

        expect(message?.media).toEqual([{ key: 'k/1.png', mime: 'image/png', name: 'a.png' }]);
    });

    it('keeps a filed PDF, which is a document rather than a rejected image type', () => {
        const message = toChatMessage(turn([{ key: 'k/1.pdf', mime: 'application/pdf', name: 'a.pdf' }]));

        expect(message?.media).toEqual([{ key: 'k/1.pdf', mime: 'application/pdf', name: 'a.pdf' }]);
    });

    it('drops a type neither dialect accepts, rather than failing the request later', () => {
        const message = toChatMessage(turn([{ key: 'k/1.tiff', mime: 'image/tiff', name: 'a.tiff' }]));

        expect(message?.media).toBeUndefined();
    });

    it('drops an entry with no key, which no request could ever resolve', () => {
        const message = toChatMessage(turn([{ mime: 'image/png', name: 'a.png' }]));

        expect(message?.media).toBeUndefined();
    });
});

describe('sessionMatches', () => {
    const session = {
        id: 's1',
        title: 'prices on example.com',
        at: 1,
        messages: [
            { id: 'm1', role: 'user' as const, content: 'what does it cost', at: 1 },
            { id: 'm2', role: 'assistant' as const, content: 'It costs twenty euros.', at: 2 },
        ],
    };

    it('keeps everything while the box is empty', () => {
        expect(sessionMatches(session, '')).toBe(true);
        expect(sessionMatches(session, '   ')).toBe(true);
    });

    it('matches the title', () => {
        expect(sessionMatches(session, 'example')).toBe(true);
    });

    it('matches a TURN, which is the whole reason the title is not enough', () => {
        // A conversation is remembered by what was said in it as often as by the question that
        // opened it, and the title is only that question's first line.
        expect(sessionMatches(session, 'twenty euros')).toBe(true);
    });

    it('ignores case and surrounding space', () => {
        expect(sessionMatches(session, '  EXAMPLE  ')).toBe(true);
    });

    it('rejects a conversation that holds none of it', () => {
        expect(sessionMatches(session, 'kubernetes')).toBe(false);
    });
});

describe('sessionTitle', () => {
    const message = (role: 'user' | 'assistant', content: string): ChatMessage =>
        ({ id: 'm', role, content, at: 0 });

    it('names the conversation after the first question, not the first turn', () => {
        const title = sessionTitle([
            message('assistant', 'Hi, ask me anything'),
            message('user', 'crawl example.com'),
        ]);

        expect(title).toBe('crawl example.com');
    });

    it('collapses a pasted multi-line prompt to one line', () => {
        expect(sessionTitle([message('user', '  one\n\ntwo   three ')])).toBe('one two three');
    });

    it('shortens a long question and says so', () => {
        // A menu row is one line; a pasted paragraph would otherwise become the widest thing in it.
        const title = sessionTitle([message('user', 'x'.repeat(200))]);

        expect(title.endsWith('…')).toBeTrue();
        expect(title.length).toBeLessThan(200);
    });

    it('returns nothing for a conversation with no text', () => {
        expect(sessionTitle([message('assistant', '   ')])).toBe('');
    });
});

describe('toChatSession', () => {
    const stored = (over: Record<string, unknown>) => ({
        id: 's1',
        title: 'title',
        at: 5,
        messages: [{ id: 'm', role: 'user', content: 'hello', at: 0 }],
        ...over,
    });

    it('round-trips a valid stored conversation', () => {
        const session = toChatSession(stored({}));

        expect(session?.id).toBe('s1');
        expect(session?.messages.length).toBe(1);
    });

    it('re-caps a title so a hand-edited row cannot fill the menu', () => {
        const session = toChatSession(stored({ title: 'y'.repeat(500) }));

        expect(session?.title.length).toBe(60);
    });

    it('drops a conversation whose turns are all unreadable', () => {
        expect(toChatSession(stored({ messages: [{}, 'nope'] }))).toBeNull();
    });

    it('rejects a row with no id', () => {
        expect(toChatSession(stored({ id: '' }))).toBeNull();
    });
});

describe('toolsForMode', () => {
    const all = availableTools();

    it('offers nothing in ask mode, which is what the mode is for', () => {
        expect(toolsForMode(all, 'ask')).toEqual([]);
    });

    it('drops every write tool in plan mode, and keeps the reads', () => {
        const plan = toolsForMode(all, 'plan');

        expect(plan.length).toBeGreaterThan(0);
        expect(plan.length).toBeLessThan(all.length);
        expect(plan.some(tool => tool.requiresConfirm === true)).toBe(false);
    });

    it('passes the tier list through untouched in agent mode', () => {
        expect(toolsForMode(all, 'agent')).toBe(all);
    });
});

describe('pickerTab', () => {
    it('keeps the tab the user tapped while that vendor still has models', () => {
        expect(pickerTab(['anthropic', 'groq'], 'groq', 'anthropic')).toBe('groq');
    });

    it('falls back to the selected model when the tapped vendor returned nothing', () => {
        // The reported gap: the tap was remembered, the catalogue came back empty for that
        // vendor, and the panel sat on an empty list that claimed to still be loading.
        expect(pickerTab(['anthropic'], 'groq', 'anthropic')).toBe('anthropic');
    });

    it('falls back to the first tab when the selected model is not in the catalogue yet', () => {
        // Before the live pass arrives the control still holds its placeholder code.
        expect(pickerTab(['anthropic'], '', 'claude')).toBe('anthropic');
    });

    it('returns the selected vendor rather than an empty label while nothing has loaded', () => {
        expect(pickerTab([], '', 'claude')).toBe('claude');
    });
});

describe('reasoningParams', () => {
    it('sends nothing at all for the default, so a request is unchanged', () => {
        expect(reasoningParams('deepseek', 'deepseek-chat', 'default')).toEqual({});
    });

    it('turns DeepSeek thinking off, because a tool round cannot replay its reasoning', () => {
        expect(reasoningParams('deepseek', 'deepseek-reasoner', 'off'))
            .toEqual({ thinking: { type: 'disabled' } });
    });

    it('invents no effort field for DeepSeek, which documents none', () => {
        expect(reasoningParams('deepseek', 'deepseek-reasoner', 'high')).toEqual({});
    });

    it('leaves Anthropic alone, whose thinking is off until something enables it', () => {
        expect(reasoningParams('anthropic', 'claude', 'high')).toEqual({});
    });

    it('withholds reasoning_effort from a model that would reject it', () => {
        expect(reasoningParams('openai', 'gpt-4o', 'high')).toEqual({});
    });

    it('sends reasoning_effort to the models that document it', () => {
        expect(reasoningParams('openai', 'o3-mini', 'high'))
            .toEqual({ reasoning_effort: 'high' });
    });

    it('maps effort onto the Gemini compatibility endpoint, and omits an unhonourable off', () => {
        expect(reasoningParams('gemini', 'gemini-3-flash', 'low'))
            .toEqual({ reasoning_effort: 'low' });

        // Gemini cannot turn thinking off on its 3 family, so `off` must not send a value.
        expect(reasoningParams('gemini', 'gemini-3-flash', 'off')).toEqual({});
    });
});

describe('attachmentPrompt', () => {
    it('returns the question untouched when nothing is attached', () => {
        expect(attachmentPrompt('hello', [])).toBe('hello');
    });

    it('tags each file and keeps the question after it', () => {
        const prompt = attachmentPrompt('summarise', [
            { name: 'a.csv', text: 'x,y', truncated: false },
        ]);

        expect(prompt).toBe('<file name="a.csv">\nx,y\n</file>\n\nsummarise');
    });

    it('leaves an image out of the text, which travels as content instead', () => {
        const prompt = attachmentPrompt('what is this', [
            { name: 'a.png', text: '', truncated: false, mime: 'image/png' },
        ]);

        expect(prompt).toBe('what is this');
    });
});

describe('filesInContent', () => {
    const dataUrl = 'data:image/png;base64,AAA';

    it('leaves a plain question a plain string', () => {
        expect(filesInContent('openai', 'hi', [])).toBe('hi');
    });

    it('builds the Claude image block with the bare base64, not the data URL', () => {
        const content = filesInContent('claude', 'describe', [
            { mime: 'image/png', dataUrl },
        ]) as { type: string; source: { data: string; media_type: string } }[];

        expect(content[0].type).toBe('image');
        expect(content[0].source.data).toBe('AAA');
        expect(content[0].source.media_type).toBe('image/png');
    });

    it('builds the OpenAI image_url part with the data URL intact', () => {
        const content = filesInContent('openai', 'describe', [
            { mime: 'image/png', dataUrl },
        ]) as { type: string; image_url: { url: string } }[];

        expect(content[0].type).toBe('image_url');
        expect(content[0].image_url.url).toBe(dataUrl);
    });

    it('puts the image before the text, which is the order Claude documents', () => {
        const content = filesInContent('claude', 'describe', [
            { mime: 'image/png', dataUrl },
        ]) as { type: string }[];

        expect(content.map(part => part.type)).toEqual(['image', 'text']);
    });

    it('names a replay as a source URL for Claude, which fetches it itself', () => {
        const content = filesInContent('claude', 'describe', [
            { mime: 'image/png', url: 'https://s.example/x.png' },
        ]) as { source: { type: string; url: string } }[];

        expect(content[0].source.type).toBe('url');
        expect(content[0].source.url).toBe('https://s.example/x.png');
    });

    it('drops an image with neither bytes nor a link instead of sending an empty block', () => {
        // An object that aged out must cost the turn its picture, not its answer: both dialects
        // reject an image part that names no source.
        expect(filesInContent('claude', 'describe', [{ mime: 'image/png' }])).toBe('describe');
    });

    it('sends a PDF to Claude as a document block, which is a different block shape', () => {
        // `media_type` is required on a base64 document and `application/pdf` is the only value
        // Claude accepts, so this is the one attachment where the type is not just a label.
        const content = filesInContent('claude', 'summarise', [
            { mime: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBER' },
        ]) as { type: string; source: { type: string; media_type: string; data: string } }[];

        expect(content[0].type).toBe('document');
        expect(content[0].source.type).toBe('base64');
        expect(content[0].source.media_type).toBe('application/pdf');
        expect(content[0].source.data).toBe('JVBER');
    });

    it('replays a PDF as a document URL, the only carrier a reloaded turn has', () => {
        const content = filesInContent('claude', 'summarise', [
            { mime: 'application/pdf', url: 'https://s.example/a.pdf' },
        ]) as { type: string; source: { type: string; url: string } }[];

        expect(content[0].type).toBe('document');
        expect(content[0].source).toEqual({ type: 'url', url: 'https://s.example/a.pdf' });
    });

    it('drops a PDF for every other vendor rather than sending one as an image', () => {
        // No OpenAI-shaped vendor has a part that means "document". Sending it as `image_url`
        // would be the half-working request the picker already refuses, so the question goes
        // without the file and keeps its answer.
        expect(filesInContent('openai', 'summarise', [
            { mime: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBER' },
        ])).toBe('summarise');
    });
});
