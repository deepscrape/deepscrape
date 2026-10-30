import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { NEVER, of } from 'rxjs';

import { OperationsComponent } from './operations.component';
import { getTestProviders } from 'src/app/testing';
import { CrawlAPIService, CrawlStoreService, FirestoreService, SnackbarService } from 'src/app/core/services';
import { CrawlOperationStatus } from 'src/app/core/enum';
import { CrawlOperation, CrawlPack, CrawlTask, JobResult } from 'src/app/core/types';

describe('OperationsComponent', () => {
  let component: OperationsComponent;
  let fixture: ComponentFixture<OperationsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OperationsComponent],
      providers: [
        ...getTestProviders(),
        // This page reads the signed-in user from the route resolver, and the
        // pack picker is filled from that user's own saved packs. Without a uid
        // the constructor's `loadCrawlPacks` returns early and the picker stays
        // empty, which is what the real surface did before it had a writer.
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { data: { user: { uid: 'u1' } } } },
        },
      ],
    })
      .compileComponents();

    fixture = TestBed.createComponent(OperationsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should apply grow class via host binding', () => {
    const host: HTMLElement = fixture.nativeElement;

    expect(host.classList.contains('grow')).toBeTrue();
  });

  it('should initialize required url control as invalid when empty', () => {
    expect(component.url.value).toBe('');
    expect(component.url.valid).toBeFalse();
  });

  it('should initialize model AI control with claude provider code', () => {
    expect(component.modelAI.value.code).toBe('claude');
  });

  /**
   * The row leads to `/operations/:id`. The id is PUSHED onto the current url
   * rather than built as an absolute path, because `appPageRoutes` is mounted in
   * both the bare tree and the `/{orgId}` tree -- an absolute path would drop
   * the org prefix for every org-scoped user.
   */
  describe('opening a row', () => {
    it('pushes the id onto the current url, keeping any org prefix', () => {
      const router = TestBed.inject(Router);
      Object.defineProperty(router, 'url', {
        value: '/org-1/operations',
        configurable: true,
      });
      const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);

      (component as unknown as { openOperation(op: { id: string }): void })
        .openOperation({ id: 'op-9' });

      expect(navigate).toHaveBeenCalledWith('/org-1/operations/op-9');
    });

    it('does nothing for a row that has no id', () => {
      const router = TestBed.inject(Router);
      const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);

      (component as unknown as { openOperation(op: { id?: string }): void })
        .openOperation({});

      expect(navigate).not.toHaveBeenCalled();
    });
  });

  /**
   * The list is an ACCORDION: one box open at a time. Two facts have to hold --
   * opening a second row closes the first, and a row's job is read once and
   * kept, because dropping it on collapse would empty the panel in the same
   * pass that starts the animation.
   */
  describe('the inline peek', () => {
    const job = {
      task_id: 't1',
      status: CrawlOperationStatus.COMPLETED,
      message: '',
      total: 1,
      items: [
        { label: 'a', url: 'a', status: 'ok', message: '', challenge: null },
      ],
    } as JobResult;

    type Peek = {
      toggleOperation(op: { id: string, task_id?: string }): void
      isOpen(id: string): boolean
      resultFor(id: string): JobResult | null | undefined
    };

    const peek = () => component as unknown as Peek;

    it('opens one row and closes the previous one', () => {
      spyOn(TestBed.inject(CrawlAPIService), 'getJobResult').and.returnValue(of(job));

      peek().toggleOperation({ id: 'a', task_id: 't1' });
      expect(peek().isOpen('a')).toBeTrue();

      peek().toggleOperation({ id: 'b', task_id: 't2' });

      expect(peek().isOpen('b')).toBeTrue();
      expect(peek().isOpen('a')).toBeFalse();
    });

    it('closes the open row when it is clicked again', () => {
      spyOn(TestBed.inject(CrawlAPIService), 'getJobResult').and.returnValue(of(job));

      peek().toggleOperation({ id: 'a', task_id: 't1' });
      peek().toggleOperation({ id: 'a', task_id: 't1' });

      expect(peek().isOpen('a')).toBeFalse();
    });

    it('reads a row once and keeps the answer for the next open', () => {
      const crawl = TestBed.inject(CrawlAPIService);
      const read = spyOn(crawl, 'getJobResult').and.returnValue(of(job));

      peek().toggleOperation({ id: 'a', task_id: 't1' });
      peek().toggleOperation({ id: 'a', task_id: 't1' });
      peek().toggleOperation({ id: 'a', task_id: 't1' });

      expect(read).toHaveBeenCalledTimes(1);
      expect(peek().resultFor('a')).toBe(job);
    });

    it('shows nothing to read for a row with no job', () => {
      const crawl = TestBed.inject(CrawlAPIService);
      const read = spyOn(crawl, 'getJobResult').and.returnValue(of(job));

      peek().toggleOperation({ id: 'a' });

      expect(peek().isOpen('a')).toBeTrue();
      expect(read).not.toHaveBeenCalled();
    });

    it('marks the peek canceled once the server answers', () => {
      // The peek keeps its rows across a collapse, so a cancel that only
      // refreshed the list would leave a "Cancel this run" button on a run that
      // had already stopped.
      const crawl = TestBed.inject(CrawlAPIService);
      spyOn(crawl, 'getJobResult').and.returnValue(of(job));
      const cancel = spyOn(crawl, 'cancelTask').and.returnValue(of({}));

      peek().toggleOperation({ id: 'a', task_id: 't1' });
      (component as unknown as { cancelOperation(op: { id: string, task_id?: string }): void })
        .cancelOperation({ id: 'a', task_id: 't1' });

      expect(cancel).toHaveBeenCalledWith('t1');
      expect(peek().resultFor('a')?.status).toBe(CrawlOperationStatus.CANCELED);
    });

    it('does not cancel a row that has no job', () => {
      const crawl = TestBed.inject(CrawlAPIService);
      const cancel = spyOn(crawl, 'cancelTask').and.returnValue(of({}));

      (component as unknown as { cancelOperation(op: { id: string }): void })
        .cancelOperation({ id: 'a' });

      expect(cancel).not.toHaveBeenCalled();
    });
  });

  /**
   * How a job comes into existence on this surface. `OPERATIONS_REQUIREMENT`
   * cites `POST /api/crawl/stream/job` (`multiCrawlEnqueue`), which submit used
   * to skip for every action. These assert the dispatch, since the storage that
   * used to be the whole handler already worked.
   */
  describe('job creation', () => {
    const pack: CrawlPack = {
      id: 'pack-1',
      uid: 'u1',
      title: 'Pack One',
      type: 'crawl4ai',
      created_at: new Date(),
      config: { type: [], value: {} },
    };

    const task = {
      id: 'task-1',
      status: CrawlOperationStatus.STARTED,
      operationId: 'op-1',
      _links: { self: { href: '' }, status: { href: '' }, cancel: { href: '' } },
    } as CrawlTask;

    /**
     * `loadCrawlPacks` runs from the constructor, so the spy has to be in place
     * before the component is created for the picker to be filled.
     */
    function build(packs: CrawlPack[] | null): ComponentFixture<OperationsComponent> {
      spyOn(TestBed.inject(FirestoreService), 'loadPreviousPacks').and.resolveTo(packs);
      const built = TestBed.createComponent(OperationsComponent);
      built.detectChanges();
      return built;
    }

    /** Fill the controls submit validates, then take one action. */
    function submit(fixture: ComponentFixture<OperationsComponent>, action: CrawlOperationStatus): void {
      const instance = fixture.componentInstance;
      instance.url.setValue('https://example.com');
      instance.userprompt.setValue('summarise it');
      instance.operationName.setValue('Nightly');
      instance.operationStatus.setValue({ name: 'action', code: action });
      // `onPromptSubmited` is protected: the template is its only caller.
      (instance as any).onPromptSubmited('summarise it');
    }

    it('fills the pack picker from the caller saved packs', async () => {
      const built = build([pack]);
      await built.whenStable();

      expect(built.componentInstance.crawlConfigPack.length).toBe(1);
      expect(built.componentInstance.crawlConfigPack[0].code).toBe('pack-1');
    });

    it('enqueues on the job surface when the action is Run', async () => {
      const built = build([pack]);
      // `loadCrawlPacks` is async, so the pack map is only populated once the
      // pending read settles.
      await built.whenStable();
      const enqueue = spyOn(TestBed.inject(CrawlAPIService), 'multiCrawlEnqueue').and.returnValue(of(task));
      // NEVER rather than `of(true)`: the call is what is under test, and the
      // real completion path reaches the template's scroll target.
      const store = spyOn(TestBed.inject(CrawlStoreService), 'storeCrawlOperation').and.returnValue(NEVER);

      built.componentInstance.crawlPack.setValue({ name: 'Pack One', code: 'pack-1' });
      submit(built, CrawlOperationStatus.STARTED);

      expect(enqueue).toHaveBeenCalled();

      // The stored row must carry the id the status stream matches on.
      const stored = store.calls.mostRecent().args[1] as CrawlOperation;
      expect(stored.task_id).toBe('task-1');
      expect(stored.status).toBe(CrawlOperationStatus.STARTED);
    });

    it('enqueues Run with no pack selected, because the body needs none', () => {
      const built = build([pack]);
      const enqueue = spyOn(TestBed.inject(CrawlAPIService), 'multiCrawlEnqueue').and.returnValue(of(task));
      spyOn(TestBed.inject(CrawlStoreService), 'storeCrawlOperation').and.returnValue(NEVER);

      // Deliberately no `crawlPack.setValue(...)`: a fresh account has no packs,
      // and the crawl-pack editor is retired so none can be created. Demanding one
      // made Run a silent no-op that returned before any message was shown.
      submit(built, CrawlOperationStatus.STARTED);

      expect(enqueue).toHaveBeenCalled();
      // Two arguments -- urls and operation_data. A pack would be a third, and its
      // config is a shape webrain never reads.
      expect(enqueue.calls.mostRecent().args.length).toBe(2);
    });

    it('records without enqueuing when the action is Save', () => {
      const built = build([pack]);
      const enqueue = spyOn(TestBed.inject(CrawlAPIService), 'multiCrawlEnqueue').and.returnValue(of(task));
      const store = spyOn(TestBed.inject(CrawlStoreService), 'storeCrawlOperation').and.returnValue(NEVER);

      built.componentInstance.crawlPack.setValue({ name: 'Pack One', code: 'pack-1' });
      submit(built, CrawlOperationStatus.READY);

      expect(enqueue).not.toHaveBeenCalled();
      expect(store).toHaveBeenCalled();
    });
  });
});
