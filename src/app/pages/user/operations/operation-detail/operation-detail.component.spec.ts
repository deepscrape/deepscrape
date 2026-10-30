import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';

import { OperationDetailComponent } from './operation-detail.component';
import { CrawlOperation, JobResult } from 'src/app/core/types';
import { getTestProviders } from 'src/app/testing';

describe('OperationDetailComponent', () => {
  let component: OperationDetailComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OperationDetailComponent],
      providers: [
        ...getTestProviders(),
        // No `user` in the resolver data and no document behind the id: this is
        // the state the page must survive without a Firestore read.
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: { get: () => 'op-1' },
              data: {},
            },
          },
        },
      ],
    }).compileComponents();

    component = TestBed.createComponent(OperationDetailComponent).componentInstance;
  });

  it('reports a missing operation instead of rendering an empty page', () => {
    // Without a uid there is nothing to read, and a page with no error and no
    // content reads as a hang rather than as a deleted row.
    expect(component.loading()).toBeFalse();
    expect(component.error()).toBe('OPERATION_DETAIL.NOT_FOUND');
    expect(component.operation()).toBeNull();
  });

  it('goes back one segment, so an org prefix survives', () => {
    // Derived from the current url rather than an absolute `/operations`:
    // `appPageRoutes` is mounted in both the bare tree and the `/{orgId}` tree.
    const router = TestBed.inject(Router);
    Object.defineProperty(router, 'url', {
      value: '/org-1/operations/op-1',
      configurable: true,
    });
    const navigate = spyOn(router, 'navigateByUrl').and.resolveTo(true);

    (component as unknown as { back(): void }).back();

    expect(navigate).toHaveBeenCalledWith('/org-1/operations');
  });

  /**
   * The messages section is built from fields that exist, so what matters is
   * that each source lands at the right level -- and that a challenge is a
   * WARNING rather than a failure.
   */
  it('builds messages from the operation, the job and each target', () => {
    component.operation.set({
      name: 'Nightly',
      error: 'the run refused',
    } as CrawlOperation);
    component.job.set({
      message: 'Queued 1 target(s)',
      total: 1,
      items: [
        {
          label: 'a',
          url: 'a',
          status: 'error',
          message: 'worker unreachable',
          challenge: 'cloudflare',
        },
      ],
    } as JobResult);

    expect(component.messages().map((entry) => entry.level)).toEqual([
      'error',
      'info',
      'error',
      'warning',
    ]);
  });

  it('derives the duration from the job when no runtime metric exists', () => {
    component.operation.set({ created_At: 1000 } as CrawlOperation);
    component.job.set({ updated_at: 6000 } as JobResult);

    expect(component.durationSeconds()).toBe(5);
  });

  it('reports no duration rather than a negative one', () => {
    // A clock that moved backwards must not render as "‑4 s".
    component.operation.set({ created_At: 6000 } as CrawlOperation);
    component.job.set({ updated_at: 1000 } as JobResult);

    expect(component.durationSeconds()).toBeNull();
  });
});
