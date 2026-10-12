import { TestBed } from '@angular/core/testing';

import { AiAPIService } from './aiapi.service';
import { getTestProviders } from 'src/app/testing';
import { vendorForModel } from '../functions';

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
    expect((service as any).jinaAiEndpoint).toContain('/');
  });

  it('should give every OpenAI-compatible vendor its own chat path', () => {
    // The endpoint table is keyed by the vendor union, so a vendor added to the catalogue and
    // forgotten here is a compile error rather than a request posted to the wrong company.
    // What this pins is that no two vendors SHARE a path -- a copy-paste that left two
    // entries identical would satisfy a mere `toContain('/chat/completions')`.
    const endpoints = (service as any).chatEndpoints as Record<string, string>;
    const paths = Object.values(endpoints);

    expect(new Set(paths).size).toBe(paths.length);
    for (const [vendor, path] of Object.entries(endpoints)) {
      expect(path).toBe(`/api/${vendor}/chat/completions`);
    }
  });
});

/**
 * Which vendor a model name resolves to, when the name alone can say so.
 *
 * This replaced a boolean that answered "is this Groq?", which only works while there are
 * exactly two OpenAI-compatible vendors. It still replaces a switch whose failure mode was
 * silent -- an unrecognised model went to the OpenAI-shaped path -- and that behaviour is
 * kept deliberately: every vendor added since is reached by its explicit `code` instead,
 * because guessing a company from a model id is how a request lands at the wrong one on the
 * caller's key.
 */
describe('provider routing', () => {
  it('resolves the Groq family to Groq', () => {
    expect(vendorForModel('llama-3.1-8b-instant')).toBe('groq');
    expect(vendorForModel('llama-3.3-70b-versatile')).toBe('groq');
    expect(vendorForModel('mixtral-8x7b-32768')).toBe('groq');
  });

  it('resolves everything else to the OpenAI-shaped path', () => {
    expect(vendorForModel('gpt-4o-mini')).toBe('openai');
    expect(vendorForModel('claude-3-5-sonnet-20241022')).toBe('openai');
    // The old `default` answered OpenAI for unknown names; so does this. A vendor added
    // since is NOT guessed here -- only the two that share this table are.
    expect(vendorForModel('a-model-nobody-has-shipped-yet')).toBe('openai');
  });
});
