import { TestBed } from '@angular/core/testing';
import { ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormBuilder } from '@angular/forms';
import { of } from 'rxjs';

import { AppCrawlComponent } from './app-crawl.component';
import { CrawlOperationStatus } from '../../enum';
import { CrawlPack } from '../../types';
import { AuthService, CrawlAPIService, FirestoreService, OperationStatusService, SnackbarService, WebrainToolsService } from '../../services';
import { PricingRatesService } from '../../services/pricing-rates.service';
import { getTestProviders } from 'src/app/testing';

describe('AppCrawlComponent', () => {
  let component: AppCrawlComponent;

  const routeStub = {} as ActivatedRoute;
  const authServiceStub = {
    user$: of({
      uid: 'user-1',
      currProviderData: { displayName: 'Test User' },
    }),
  } as unknown as AuthService;

  const firestoreServiceStub = {
    loadPreviousPacks: () => Promise.resolve([]),
  } as unknown as FirestoreService;

  const crawlServiceStub = {
    multiCrawlEnqueue: () => of(),
    streamTaskResults: () => of(),
    // The component prices the run it is about to submit, and it reads the path
    // from here so the estimate cannot name a different route than the submit.
    jobEnqueuePath: '/api/crawl/stream/job',
  } as unknown as CrawlAPIService;

  const pricingServiceStub = {
    estimate: () => of({
      status: 'ok',
      estimate: {
        method: 'POST',
        path: '/api/crawl/stream/job',
        action: 'api.paid.default',
        credits: 1,
        accessMode: 'plan',
        chargeable: true,
        effectiveCredits: 1,
      },
    }),
  } as unknown as PricingRatesService;

  const operationStatusStub = {} as OperationStatusService;
  const snackbarServiceStub = { showSnackbar: jasmine.createSpy('showSnackbar') } as unknown as SnackbarService;
  const cdrStub = {
    markForCheck: jasmine.createSpy('markForCheck'),
    detectChanges: jasmine.createSpy('detectChanges'),
  } as unknown as ChangeDetectorRef;
  const routerStub = { url: '/playground' } as Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        FormBuilder,
        // Stubbed rather than left to the real service: the point of the assertion
        // below is that the component READS the estimate, and a live HTTP call
        // would leave an unflushed request behind instead.
        { provide: PricingRatesService, useValue: pricingServiceStub },
      ],
    });

    component = TestBed.runInInjectionContext(
      () => new AppCrawlComponent(
        routeStub,
        authServiceStub,
        firestoreServiceStub,
        crawlServiceStub,
        operationStatusStub,
        snackbarServiceStub,
        cdrStub,
        TestBed.inject(FormBuilder),
        routerStub
      )
    );

    component.ngOnInit();
  });

  it('should initialize required crawl form controls', () => {
    expect(component.urls).toBeTruthy();
    expect(component.userprompt).toBeTruthy();
    expect(component.submitButton).toBeTruthy();
    expect(component.crawlOptions).toBeTruthy();
  });

  it('should build operation payload using current form values', () => {
    component.urls.setValue('https://a.dev,https://b.dev');
    component.userprompt.setValue('extract links');
    const crawlPack = {
      id: 'pack-1',
      uid: 'user-1',
      title: 'Pack',
      type: 'crawl4ai',
      created_at: new Date(),
      config: { type: ['crawler'], value: {} },
    } satisfies Partial<CrawlPack>;
    component.crawlpack = crawlPack as CrawlPack;

    const payload = component.setupOperationData();

    expect(payload.status).toBe(CrawlOperationStatus.READY);
    expect(payload.metadataId).toBe('pack-1');
    expect(payload.urls).toEqual(['https://a.dev', 'https://b.dev']);
    expect(payload.prompt).toBe('extract links');
  });

  it('should include user and route metadata in operation payload', () => {
    component.urls.setValue('https://single.dev');
    component.userprompt.setValue('extract');

    const payload = component.setupOperationData();

    expect(payload.author.uid).toBe('user-1');
    expect(payload.urlPath).toBe('/playground');
    expect(payload.urls).toEqual(['https://single.dev']);
  });

  it('should stop submit when crawl pack selection is default', () => {
    spyOn(component, 'crawlEnqueue');

    component.urls.setValue('https://single.dev');
    component.crawlPackSelector.setValue({ name: 'select a crawlpack', code: 'default' });

    component.submitCrawlJob();

    expect(component.crawlEnqueue).not.toHaveBeenCalled();
  });

  it('should read what the next run costs, for the route it will submit to', () => {
    // The price has to be visible BEFORE the button that spends it, and it has to
    // describe the route the submit actually uses.
    const estimate = component['costEstimate']();

    expect(estimate).toBeTruthy();
    expect(estimate?.effectiveCredits).toBe(1);
    expect(estimate?.path).toBe('/api/crawl/stream/job');
  });

  /**
   * The walk and batch arguments, pinned.
   *
   * These names are the HTTP surface's -- the ones `crawlArguments` and
   * `batchArguments` read. Getting one wrong is not a style problem: a walk seed
   * sent under the wrong key is answered `seed_url required` for a request that
   * named a perfectly good URL, and it arrives as an error INSIDE a 200, so the
   * route looks healthy while returning nothing. That exact pair of modes was
   * broken once, which is why the contract is asserted rather than assumed.
   */
  describe('tool runs', () => {
    it('should send a walk with the mode and strategy the worker reads', () => {
      const tools = TestBed.inject(WebrainToolsService);
      const spider = spyOn(tools, 'spider').and.returnValue(of({ status: 'ok', data: {} }));

      component.urls.setValue('https://a.dev');
      component['setRunMode']('walk');
      component['setWalkMode']('spider');
      component['runTool']();

      expect(spider).toHaveBeenCalledWith({
        urls: ['https://a.dev'],
        mode: 'spider',
        strategy: 'bfs',
      });
    });

    it('should send a batch with its op, and one entry per url typed', () => {
      const tools = TestBed.inject(WebrainToolsService);
      const batch = spyOn(tools, 'batch').and.returnValue(of({ status: 'ok', data: {} }));

      component.urls.setValue('https://a.dev, https://b.dev ');
      component['setRunMode']('batch');
      component['setBatchOp']('fetch');
      component['runTool']();

      expect(batch).toHaveBeenCalledWith({
        urls: ['https://a.dev', 'https://b.dev'],
        op: 'fetch',
      });
    });

    it('should omit an unusable limit rather than send it as NaN', () => {
      const tools = TestBed.inject(WebrainToolsService);
      const spider = spyOn(tools, 'spider').and.returnValue(of({ status: 'ok', data: {} }));

      component.urls.setValue('https://a.dev');
      component['setRunMode']('walk');
      component['walkMaxPages'].setValue('abc');
      component['walkMaxDepth'].setValue('3');
      component['runTool']();

      const body = spider.calls.mostRecent().args[0] as Record<string, unknown>;

      expect(body['max_pages']).toBeUndefined();
      expect(body['max_depth']).toBe(3);
    });

    it('should send no_content only when the discover-only box is on', () => {
      const tools = TestBed.inject(WebrainToolsService);
      const spider = spyOn(tools, 'spider').and.returnValue(of({ status: 'ok', data: {} }));

      component.urls.setValue('https://a.dev');
      component['setRunMode']('walk');
      component['runTool']();

      expect(spider.calls.mostRecent().args[0]['no_content']).toBeUndefined();

      component['walkNoContent'].set(true);
      component['runTool']();

      expect(spider.calls.mostRecent().args[0]['no_content']).toBe(true);
    });

    it('should not demand a crawl pack for a tool run', () => {
      // The pack configures the STREAM job the scrape mode enqueues. A walk takes
      // its arguments from this form, so requiring a pack would block the run for a
      // reason that does not exist.
      component.urls.setValue('https://a.dev');
      component.crawlPackSelector.setValue({ name: 'select a crawlpack', code: 'default' });
      component['setRunMode']('walk');

      expect(component['runDisabled']).toBeFalse();
    });

    it('should still demand a pack for the scrape run', () => {
      component.urls.setValue('https://a.dev');
      component.crawlPackSelector.setValue({ name: 'select a crawlpack', code: 'default' });

      expect(component['runDisabled']).toBeTrue();
    });

    it('should show the failure text the server sent, not a status-code guess', () => {
      const tools = TestBed.inject(WebrainToolsService);
      spyOn(tools, 'spider').and.returnValue(
        of({ status: 'error', error: 'seed_url required' }),
      );

      component.urls.setValue('https://a.dev');
      component['setRunMode']('walk');
      component['runTool']();

      expect(component['toolState']()).toBe('error');
      expect(component['toolError']()).toBe('seed_url required');
    });

    it('should clear the previous reply when the run mode changes', () => {
      // A batch answer left standing under a walk's heading reads as the walk's.
      const tools = TestBed.inject(WebrainToolsService);
      spyOn(tools, 'batch').and.returnValue(of({ status: 'ok', data: { count: 1 } }));

      component.urls.setValue('https://a.dev');
      component['setRunMode']('batch');
      component['runTool']();
      expect(component['toolState']()).toBe('ready');

      component['setRunMode']('walk');

      expect(component['toolState']()).toBe('idle');
      expect(component['toolEnvelope']()).toBeNull();
    });
  });
});
