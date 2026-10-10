import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { NEVER, of } from 'rxjs';

import { OperationsComponent } from './operations.component';
import { getTestProviders } from 'src/app/testing';
import { CrawlAPIService, CrawlStoreService, FirestoreService, SnackbarService } from 'src/app/core/services';
import { CrawlOperationStatus } from 'src/app/core/enum';
import { CrawlOperation, CrawlPack, CrawlTask } from 'src/app/core/types';

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

    it('refuses Run without a pack and enqueues nothing', () => {
      const built = build([pack]);
      const enqueue = spyOn(TestBed.inject(CrawlAPIService), 'multiCrawlEnqueue').and.returnValue(of(task));
      const store = spyOn(TestBed.inject(CrawlStoreService), 'storeCrawlOperation').and.returnValue(NEVER);

      submit(built, CrawlOperationStatus.STARTED);

      expect(enqueue).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
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
