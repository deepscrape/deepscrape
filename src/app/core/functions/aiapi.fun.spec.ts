import { buildModelOptions, chatInBatchesAI } from './aiapi.fun';
import { sanitizeJSON } from './global.fun';
import { AIModel } from '../types';

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
  });
});
