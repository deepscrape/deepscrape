import { buildHistory, buildRequest } from './chatai.component';

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
