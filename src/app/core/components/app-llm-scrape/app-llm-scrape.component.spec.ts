import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { of, Subscription } from 'rxjs';

import { AppLLMScrapeComponent } from './app-llm-scrape.component';
import { AiAPIService, AiFetchService, AiKeysService, LocalStorage, SnackbarService } from '../../services';
import { AiKeyResolution, AI_VENDORS, WebrainScrapeEnvelope } from '../../types';
import { SnackBarType } from '../snackbar/snackbar.component';
import { getTestProviders } from 'src/app/testing';

/**
 * The component resolves its collaborators with `inject()` and holds its state
 * in signals, so every test constructs it inside an injection context and reads
 * state through the signal call.
 */
describe('AppLLMScrapeComponent', () => {
  // The component's state is `protected` (signals the template reads) and this
  // spec asserts on it directly, which is a compile error from outside the
  // class. Loosening the handle here costs one line; the alternatives cost more
  // and buy less: bracket access at ~19 call sites, or stripping `protected`
  // from 15 production members permanently to serve a test.
  // ponytail: loses compile-time checking of these calls only. Migrate to typed
  // `component['member']` access if the spec grows or the members go public.
  let component: any;

  const localStorageSpy = jasmine.createSpyObj<Storage>('Storage', ['getItem', 'setItem', 'removeItem', 'clear', 'key']);
  const aiApiStub = {
    sendToOpenAI: jasmine.createSpy('sendToOpenAI').and.returnValue(of({ content: 'openai', usage: null, role: null })),
    sendToClaudeAI: jasmine.createSpy('sendToClaudeAI').and.returnValue(of({ content: 'claude', usage: null, role: 'assistant' })),
  } as unknown as AiAPIService;

  /** The free fetch route's reply for one page. */
  const scrapeEnvelope = (text: string): WebrainScrapeEnvelope => ({
    provider: 'webrain',
    status: 'ok',
    url: 'https://example.com',
    data: { status: 'ok', result: { url: 'https://example.com', status: 200, content_type: 'text/html', text, bytes: text.length } },
  });

  const aiFetchStub = {
    scrape: jasmine.createSpy('scrape').and.callFake((url: string) => of(scrapeEnvelope('page body'))),
  } as unknown as AiFetchService;

  const aiKeysStub = {
    load: jasmine.createSpy('load').and.returnValue(Promise.resolve()),
    resolve: jasmine.createSpy('resolve').and.returnValue({ vendor: null, source: 'platform', allowed: true } as AiKeyResolution),
    stateFor: jasmine.createSpy('stateFor').and.returnValue(null),
    catalogue: AI_VENDORS,
    // `AiModelsService` -- which the component now uses to fill its picker -- reads these two
    // through the signal they are, so a stub without them crashes at construction. `false`/`[]`
    // is the honest answer for a spec that stubs the loader: nobody has a key here.
    isLoaded: () => false,
    vendors: () => [],
  } as unknown as AiKeysService;

  const snackbarServiceStub = {
    showSnackbar: jasmine.createSpy('showSnackbar'),
  } as unknown as SnackbarService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        FormBuilder,
        { provide: LocalStorage, useValue: localStorageSpy },
        { provide: AiAPIService, useValue: aiApiStub },
        { provide: AiFetchService, useValue: aiFetchStub },
        { provide: AiKeysService, useValue: aiKeysStub },
        { provide: SnackbarService, useValue: snackbarServiceStub },
      ],
    });

    localStorageSpy.getItem.calls.reset();
    localStorageSpy.setItem.calls.reset();
    localStorageSpy.getItem.and.callFake((key: string) => key === 'forwardCookies' ? 'true' : null);
    (aiApiStub.sendToOpenAI as jasmine.Spy).calls.reset();
    (aiApiStub.sendToClaudeAI as jasmine.Spy).calls.reset();
    (aiFetchStub.scrape as jasmine.Spy).calls.reset();
    (aiKeysStub.load as jasmine.Spy).calls.reset();
    (snackbarServiceStub.showSnackbar as jasmine.Spy).calls.reset();

    component = TestBed.runInInjectionContext(() => new AppLLMScrapeComponent());

    component.aiResultsSub = new Subscription();
    component.forkJoinSubscription = new Subscription();
    component.ngOnInit();
  });

  it('should initialize controls and restore the forwardCookies preference', () => {
    expect(component.url.value).toBe('');
    expect(component.userprompt.value).toBe('');
    expect(component.submitButton.value).toBeFalse();
    expect(component.modelAI.value).toEqual({ name: 'claude-haiku-5-5', code: 'claude' });
    expect(component.options.get('forwardCookies')?.value).toBeTrue();
  });

  it('should persist forwardCookies changes to local storage', () => {
    component.options.get('forwardCookies')?.setValue(false);

    expect(localStorageSpy.setItem).toHaveBeenCalledWith('forwardCookies', 'false');
  });

  it('should not start processing while required inputs are invalid', () => {
    const processDataSpy = spyOn(component as unknown as { processData(link: string, aitype: string): void }, 'processData');

    component.onPromptSubmited('ignored');

    expect(processDataSpy).not.toHaveBeenCalled();
  });

  it('should disable the form and start processing for valid prompt submissions', () => {
    const processDataSpy = spyOn(component as unknown as { processData(link: string, aitype: string): void }, 'processData');
    const closeResultsSpy = spyOn(component, 'closeResults').and.callThrough();

    component.url.setValue('https://example.com');
    component.userprompt.setValue('Summarize the content');

    component.onPromptSubmited('Summarize the content');

    expect(closeResultsSpy).toHaveBeenCalled();
    expect(component.url.disabled).toBeTrue();
    expect(component.userprompt.disabled).toBeTrue();
    expect(component.modelAI.disabled).toBeTrue();
    expect(component.submitButton.value).toBeTrue();
    expect(processDataSpy.calls.mostRecent().args).toEqual(['https://example.com', 'claude']);
    expect(component.isCrawlProcessing()).toBeTrue();
  });

  it('should record the vendor behind the selected model', () => {
    spyOn(component as unknown as { fetchPageContent(url: string): unknown }, 'fetchPageContent');

    component.modelAI.setValue({ name: 'gpt-4o-mini', code: 'openai' });
    component.url.setValue('https://example.com');
    component.userprompt.setValue('Summarize the content');

    component.onPromptSubmited('Summarize the content');

    expect(component.activeVendor()).toBe('openai');
  });

  it('should dispatch OpenAI model selection to the OpenAI client', () => {
    component.modelAI.setValue({ name: 'gpt-4o-mini', code: 'openai' });

    (component as unknown as { chooseAIModel(messages: { role: string; content: string }[]): unknown }).chooseAIModel([{ role: 'user', content: 'hello' }]);

    expect(aiApiStub.sendToOpenAI).toHaveBeenCalledWith([{ role: 'user', content: 'hello' }], 'gpt-4o-mini');
  });

  it('should reset results and unsubscribe active streams when closing results', () => {
    const aiResultsSub = new Subscription();
    const forkJoinSubscription = new Subscription();
    spyOn(aiResultsSub, 'unsubscribe').and.callThrough();
    spyOn(forkJoinSubscription, 'unsubscribe').and.callThrough();
    component.aiResultsSub = aiResultsSub;
    component.forkJoinSubscription = forkJoinSubscription;
    component.content.set('partial');
    component.usage.set({ total_tokens: 10, total_cost: 2 });
    component.isGetResults.set(true);

    component.closeResults();

    expect(component.isGetResults()).toBeFalse();
    expect(component.content()).toBe('');
    expect(component.usage()).toBeNull();
    expect(aiResultsSub.unsubscribe).toHaveBeenCalled();
    expect(forkJoinSubscription.unsubscribe).toHaveBeenCalled();
  });

  it('should clear the URL input when onClearText is invoked', () => {
    component.url.setValue('https://example.com');

    component.onClearText();

    expect(component.url.value).toBe('');
  });

  it('should abort requests by unsubscribing, re-enable the form, and show feedback', () => {
    const aiResultsSub = new Subscription();
    const forkJoinSubscription = new Subscription();
    spyOn(aiResultsSub, 'unsubscribe').and.callThrough();
    spyOn(forkJoinSubscription, 'unsubscribe').and.callThrough();
    component.aiResultsSub = aiResultsSub;
    component.forkJoinSubscription = forkJoinSubscription;

    component.url.disable();
    component.userprompt.disable();
    component.modelAI.disable();
    component.submitButton.setValue(true);
    component.isResultsProcessing.set(true);
    component.isCrawlProcessing.set(true);

    component.abortRequests();

    // Cancellation IS the unsubscribe: Angular aborts the in-flight request
    // when its subscription is disposed, so this is what proves the request
    // stopped rather than being left to complete with nobody listening.
    expect(aiResultsSub.unsubscribe).toHaveBeenCalled();
    expect(forkJoinSubscription.unsubscribe).toHaveBeenCalled();
    expect(component.isResultsProcessing()).toBeFalse();
    expect(component.isCrawlProcessing()).toBeFalse();
    expect(component.url.enabled).toBeTrue();
    expect(component.userprompt.enabled).toBeTrue();
    expect(component.modelAI.enabled).toBeTrue();
    expect(component.submitButton.value).toBeFalse();
    expect(snackbarServiceStub.showSnackbar).toHaveBeenCalledWith('Request canceled', SnackBarType.info, '', 5000);
  });

  it('should fetch page content through the scraping worker', () => {
    const fetchPageContent = (component as unknown as { fetchPageContent(url: string): { subscribe(o: { next(t: string): void }): Subscription } }).fetchPageContent.bind(component);
    let text = '';

    fetchPageContent('https://example.com').subscribe({ next: (value: string) => { text = value; } });

    expect((aiFetchStub.scrape as jasmine.Spy)).toHaveBeenCalledWith('https://example.com');
    expect(text).toBe('page body');
  });

  it('should surface the key source the server resolved for the active vendor', () => {
    (aiKeysStub.resolve as jasmine.Spy).and.returnValue({ vendor: null, source: 'user', allowed: true } as AiKeyResolution);

    component.modelAI.setValue({ name: 'claude-haiku-5-5', code: 'claude' });
    (component as unknown as { activeVendor: { set(value: string): void } }).activeVendor.set('anthropic');

    expect(component.activeKeySource()).toBe('user');
    expect(component.activeKeySourceLabelKey()).toBe('AI_VENDOR.SOURCE_USER');
  });
});
