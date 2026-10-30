import { buildHistory, buildRequest, isAtBottom, notOfferedText, refusalText, sessionTitle, toChatMessage, toChatSession, toolResultText } from './chatai.component';
import type { ChatMessage } from './chatai.component';

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
