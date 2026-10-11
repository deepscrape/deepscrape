import { buildHistory, buildRequest, refusalText, toolResultText } from './chatai.component';

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

        expect(buildRequest('claude', messages, 'SYS')).toEqual({ provider: 'claude', messages });
    });

    it('inlines the system turn for OpenAI/Groq, which ignore their sys argument otherwise', () => {
        expect(buildRequest('openai', [{ role: 'user', content: 'hi' }], 'SYS')).toEqual({
            provider: 'openai',
            messages: [
                { role: 'system', content: 'SYS' },
                { role: 'user', content: 'hi' },
            ],
        });
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
