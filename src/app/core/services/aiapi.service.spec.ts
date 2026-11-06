import { TestBed } from '@angular/core/testing';

import { AiAPIService, withCacheBreakpoint } from './aiapi.service';
import { getTestProviders, HttpTestingController } from 'src/app/testing';
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

  /**
   * A rejected key must survive the HTTP boundary.
   *
   * The endpoint answers 200 with an empty list and a reason, so dropping the reason leaves a
   * user with a short dropdown and no explanation -- the exact state that reads as "this product
   * is broken". This pins the relay, not the wording.
   */
  it('relays the reason a catalogue came back empty', () => {
    const http = TestBed.inject(HttpTestingController);
    let unavailable: unknown;

    service.fetchModels('groq').subscribe(catalogue => {
      unavailable = catalogue.unavailable;
      expect(catalogue.models).toEqual([]);
    });

    const req = http.expectOne('/api/models/groq');
    req.flush({ models: [], facts: {}, unavailable: 401 });
    http.verify();

    expect(unavailable).toBe(401);
  });
});

/**
 * The Claude caching contract.
 *
 * A breakpoint is the only thing that makes a repeated prefix cheaper, and its absence is silent:
 * the request still succeeds and simply bills full price on every tool round. So the SHAPE is
 * pinned here rather than trusted, because no gate can observe a bill.
 */
describe('withCacheBreakpoint', () => {
  it('marks the last block of the last turn and leaves the rest untouched', () => {
    const marked = withCacheBreakpoint([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);

    expect(marked[2].content).toEqual([
      { type: 'text', text: 'again', cache_control: { type: 'ephemeral' } },
    ]);
    expect(marked[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('marks the text block of an image turn, which is last by contract', () => {
    const marked = withCacheBreakpoint([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
        { type: 'text', text: 'what is this' },
      ],
    }]);

    expect(marked[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      { type: 'text', text: 'what is this', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('sends an empty turn unmarked rather than inventing a block', () => {
    expect(withCacheBreakpoint([])).toEqual([]);
    expect(withCacheBreakpoint([{ role: 'user', content: '' }])[0].content)
      .toEqual([{ type: 'text', text: '', cache_control: { type: 'ephemeral' } }]);
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
