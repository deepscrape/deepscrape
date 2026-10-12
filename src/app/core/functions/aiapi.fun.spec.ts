import { buildModelOptions, calculateOpenAICost, chatInBatchesAI } from './aiapi.fun';
import { sanitizeJSON } from './global.fun';
import { AIModel, OpenAITokenDetails } from '../types';

describe('aiapi.fun', () => {
  describe('chatInBatchesAI', () => {
    it('should create initial context message', () => {
      const messages: { role: string; content: string }[] = [];
      const content = 'Test content';

      chatInBatchesAI(messages, content);

      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toContain('text in parts');
    });

    it('should split content into batches', () => {
      const messages: { role: string; content: string }[] = [];
      const longContent = 'x'.repeat(3000); // Create content larger than chunk size

      chatInBatchesAI(messages, longContent);

      // Should have: instruction message + batches + completion message
      expect(messages.length).toBeGreaterThan(2);
      expect(messages[messages.length - 1].content).toBe('ALL PARTS SENT');
    });

    it('should add completion message at end', () => {
      const messages: { role: string; content: string }[] = [];
      chatInBatchesAI(messages, 'Some content');

      const lastMessage = messages[messages.length - 1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe('ALL PARTS SENT');
    });

    it('should handle empty content gracefully', () => {
      const messages: { role: string; content: string }[] = [];
      chatInBatchesAI(messages, '');

      // Should have instruction and completion messages
      expect(messages.length).toBeGreaterThanOrEqual(2);
    });

    it('should sanitize chunks', () => {
      const messages: { role: string; content: string }[] = [];
      const content = 'Normal content with some special chars: \n\t';

      chatInBatchesAI(messages, content);

      // Check that sanitization was applied
      const chunks = messages.slice(1, -1);
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it('should respect chunk size limit', () => {
      const messages: { role: string; content: string }[] = [];
      const chunkSize = 1024;
      const content = 'x'.repeat(chunkSize * 5); // 5x chunk size

      chatInBatchesAI(messages, content);

      // Should split into multiple chunks
      expect(messages.length).toBeGreaterThan(5);
    });
  });

  describe('buildModelOptions', () => {
    const fallback: AIModel[] = [
      { name: 'gpt-6-astra', code: 'openai' },
      { name: 'llama-3.1-8b-instant', code: 'groq' },
    ];

    it('prefers a live catalogue over the static list', () => {
      const { options } = buildModelOptions(['openai'], { openai: ['gpt-6-luna'] }, fallback);

      expect(options).toEqual([{ name: 'gpt-6-luna', code: 'openai' }]);
    });

    it('keeps the static list when a catalogue could not be read', () => {
      // A vendor being briefly unreachable must not remove its models from the picker.
      const { options } = buildModelOptions(['groq'], { groq: [] }, fallback);

      expect(options).toEqual([{ name: 'llama-3.1-8b-instant', code: 'groq' }]);
    });

    it('omits a vendor the server did not resolve as usable', () => {
      const { options } = buildModelOptions(['groq'], {}, fallback);

      expect(options.some(option => option.code === 'openai')).toBeFalse();
    });

    it('offers the static list unfiltered when the server has not answered', () => {
      // `null` is "unknown", which is not "nothing is usable": emptying the picker on a
      // failed settings call would be a new failure mode introduced by a gating feature.
      const { options } = buildModelOptions(null, {}, fallback);

      expect(options).toEqual(fallback);
    });

    it('names a vendor it has no models for instead of inventing one', () => {
      const { options, missing } = buildModelOptions(
        ['openai', 'deepseek'],
        { openai: ['gpt-6-luna'] },
        fallback,
      );

      expect(options).toEqual([{ name: 'gpt-6-luna', code: 'openai' }]);
      expect(missing).toEqual(['deepseek']);
    });

    it('drops a fallback model the registry says is already retired', () => {
      // The fallback is the only place a dead model can still reach the picker: a vendor's live
      // catalogue drops it when it goes, while this list changes only when someone edits it.
      const { options } = buildModelOptions(
        ['groq'],
        {},
        fallback,
        { 'llama-3.1-8b-instant': { deprecatedOn: '2020-01-01' } },
      );

      expect(options).toEqual([]);
    });

    it('keeps a fallback model whose retirement date is still ahead', () => {
      const { options } = buildModelOptions(
        ['groq'],
        {},
        fallback,
        { 'llama-3.1-8b-instant': { deprecatedOn: '2999-01-01' } },
      );

      expect(options).toEqual([{ name: 'llama-3.1-8b-instant', code: 'groq' }]);
    });

    it('never lets a registry date overrule a live catalogue', () => {
      // The vendor is the authority on what it serves today. If it still lists a model, a third
      // party saying the model is gone must not remove it -- that would be a confident wrong
      // fact, arriving from a source that also describes deployments rather than models.
      const { options } = buildModelOptions(
        ['groq'],
        { groq: ['llama-3.1-8b-instant'] },
        fallback,
        { 'llama-3.1-8b-instant': { deprecatedOn: '2020-01-01' } },
      );

      expect(options).toEqual([{ name: 'llama-3.1-8b-instant', code: 'groq' }]);
    });
  });

  describe('calculateOpenAICost', () => {
    const usage = (prompt: number, completion: number): OpenAITokenDetails => ({
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        audio_tokens: 0,
        reasoning_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    });

    it('reads the static table as per 1K, the unit its own arithmetic divides by', () => {
      // A money figure with a 1000x hazard, so it is pinned rather than reviewed. `gpt-4o-mini`
      // is $0.15 per MILLION, which is 0.00015 per 1K, so one million prompt tokens must cost
      // $0.15. Two Groq rows sat here written as per-million values and displayed 1000x their
      // real cost until they were converted.
      expect(calculateOpenAICost(usage(1_000_000, 0), 'gpt-4o-mini')).toBeCloseTo(0.15, 6);
    });

    it('keeps the Groq rows in the unit the rest of the table uses', () => {
      // The two rows that actually regressed, pinned by name: they were stored as per-million
      // values in a per-1K table, so a Groq call displayed 1000x its cost. $0.05 per million is
      // 0.00005 per 1K, which is what the table now holds -- and Groq is platform-funded, so
      // the registry cannot cover it and this fallback is the only price there is.
      expect(calculateOpenAICost(usage(1_000_000, 0), 'llama-3.1-8b-instant')).toBeCloseTo(0.05, 6);
      expect(calculateOpenAICost(usage(1_000_000, 0), 'llama-3.3-70b-versatile')).toBeCloseTo(0.59, 6);
    });

    it('reads facts as per MILLION, the unit the registry publishes', () => {
      // The other half of the same hazard: the facts path converts per-million to per-1K, so
      // the SAME call priced from facts comes out at $2.50, not $0.0025.
      const cost = calculateOpenAICost(usage(1_000_000, 0), 'gpt-4o-mini', {
        inputCostPerMTokens: 2.5,
        outputCostPerMTokens: 10,
      });

      expect(cost).toBeCloseTo(2.5, 6);
    });

    it('falls through to the table when the facts are only half a price', () => {
      const cost = calculateOpenAICost(usage(1_000_000, 0), 'gpt-4o-mini', { inputCostPerMTokens: 99 });

      expect(cost).toBeCloseTo(0.15, 6);
    });
  });
});
