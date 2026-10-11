import { TestBed } from '@angular/core/testing';

import { AiAPIService } from './aiapi.service';
import { getTestProviders } from 'src/app/testing';
import { isGroqModel } from '../functions';

describe('AiserviceService', () => {
  let service: AiAPIService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: getTestProviders() });
    service = TestBed.inject(AiAPIService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should expose all primary AI transport methods', () => {
    expect(typeof service.sendToJinaAI).toBe('function');
    expect(typeof service.sendToClaudeAI).toBe('function');
    expect(typeof service.sendToOpenAI).toBe('function');
  });

  it('should initialize model endpoint configuration', () => {
    expect((service as any).claudeAiEndpoint).toContain('/messages');
    expect((service as any).openAiEndpoint).toContain('/chat/completions');
    expect((service as any).groqAiEndpoint).toContain('/chat/completions');
    expect((service as any).jinaAiEndpoint).toContain('/');
  });
});

/**
 * The only difference between the OpenAI and Groq paths is which endpoint and key
 * the request carries, and this predicate is that decision.
 *
 * It replaces a switch whose failure mode was silent: an unrecognised model went to
 * the OpenAI-shaped path, so a typo in a model name spent the wrong vendor's key
 * with nothing logged. The behaviour is unchanged on purpose -- what changed is that
 * it is now one named answer instead of the fourth element of a tuple.
 */
describe('provider routing', () => {
  it('sends the Groq family to Groq', () => {
    expect(isGroqModel('llama-3.1-8b-instant')).toBeTrue();
    expect(isGroqModel('llama-3.3-70b-versatile')).toBeTrue();
    expect(isGroqModel('mixtral-8x7b-32768')).toBeTrue();
  });

  it('sends everything else to the OpenAI-shaped path', () => {
    expect(isGroqModel('gpt-4o-mini')).toBeFalse();
    expect(isGroqModel('claude-3-5-sonnet-20241022')).toBeFalse();
    // The old `default` answered OpenAI for unknown names; so does this.
    expect(isGroqModel('a-model-nobody-has-shipped-yet')).toBeFalse();
  });
});
