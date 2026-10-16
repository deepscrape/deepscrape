import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, of } from 'rxjs';

import { GeneralTabComponent } from './general.component';
import { BillingPolicyService } from '../../../../core/services/billing-policy.service';
import { AiKeysService } from '../../../../core/services/ai-keys.service';
import { ComputeService } from '../../../../core/services/compute.service';
import { EgressService } from '../../../../core/services/egress.service';
import type {
  ComputeSettings,
  ComputeWrite,
  EgressSettings,
  EgressWrite,
} from '../../../../core/types/webrain-config.interface';
import { AI_VENDORS } from '../../../../core/types';
import { getTestProviders } from 'src/app/testing';

describe('GeneralTabComponent', () => {
  let component: GeneralTabComponent;
  let fixture: ComponentFixture<GeneralTabComponent>;
  let patches: { spendCapCredits?: number }[];
  let egressWrites: EgressWrite[];
  let computeWrites: ComputeWrite[];

  beforeEach(async () => {
    patches = [];
    egressWrites = [];
    computeWrites = [];

    const policyStub = {
      get: (): Observable<unknown> =>
        of({ status: 'ok', policy: null, period: 'month', window: null }),
      set: (patch: { spendCapCredits?: number }): Observable<unknown> => {
        patches.push(patch);
        return of({ status: 'ok' });
      },
    };

    // The page now mounts `<app-ai-keys />`, which injects this service. Stubbed
    // rather than left to the real one: the real `load()` reaches Firebase
    // Functions, which a unit test has no business calling. Empty `engines` keeps
    // the engine rows out of this page's own assertions, and empty `readerKeys`
    // does the same for the reader rows. Every member the child reads is listed
    // here because the cast is `unknown`-first: a missing one is not a type
    // error, it is a template that throws on the first change detection pass.
    const aiKeysStub = {
      catalogue: AI_VENDORS,
      isLoading: signal(false).asReadonly(),
      isLoaded: signal(true).asReadonly(),
      errorMessage: signal('').asReadonly(),
      engines: signal([]).asReadonly(),
      storedEngine: signal<string | null>(null).asReadonly(),
      readerKeys: signal([]).asReadonly(),
      load: (): Promise<void> => Promise.resolve(),
      resolve: () => ({ vendor: null, source: 'none', allowed: false }),
      stateFor: () => null,
      storeKey: (): Promise<boolean> => Promise.resolve(false),
      clearKey: (): Promise<boolean> => Promise.resolve(false),
      storeEngine: (): Promise<boolean> => Promise.resolve(false),
    } as unknown as AiKeysService;

    // Stubbed for the same reason as the two above, and it needs one regardless:
    // the component subscribes in its CONSTRUCTOR, so leaving the real service in
    // place would fire a live `/api/egress` request from a unit test.
    const egressStub = {
      get: (): Observable<EgressSettings> =>
        of({ mode: 'platform', hasCredentials: false, exits: [] }),
      set: (write: EgressWrite): Observable<EgressSettings> => {
        egressWrites.push(write);
        // A BYO write that succeeded projects at least one exit; an empty
        // projection with a pointer is the BROKEN state, and a stub should not
        // model a failure while claiming success.
        return of(write.mode === 'byo'
          ? {
            mode: 'byo' as const,
            hasCredentials: true,
            exits: [{ label: 'exit.example.com:8080', host: 'exit.example.com:8080' }],
          }
          : { mode: 'platform' as const, hasCredentials: false, exits: [] });
      },
    } as unknown as EgressService;

    // Stubbed for the same reason as the three above, and it needs one
    // regardless: the component reads it in its CONSTRUCTOR, so leaving the real
    // service in place would fire a live `/api/compute` request from a unit test.
    const computeStub = {
      get: (): Observable<ComputeSettings> =>
        of({
          mode: 'platform',
          computeSource: 'platform',
          hasCredentials: false,
          app: '',
          region: '',
        }),
      set: (write: ComputeWrite): Observable<ComputeSettings> => {
        computeWrites.push(write);
        // A BYO write that succeeded projects an app; an empty projection beside
        // a pointer is the BROKEN state, and a stub should not model a failure
        // while claiming success.
        return of(write.mode === 'byo'
          ? {
            mode: 'byo' as const,
            computeSource: 'byo' as const,
            hasCredentials: true,
            app: write.app,
            region: write.region,
          }
          : {
            mode: 'platform' as const,
            computeSource: 'platform' as const,
            hasCredentials: false,
            app: '',
            region: '',
          });
      },
    } as unknown as ComputeService;

    await TestBed.configureTestingModule({
      imports: [GeneralTabComponent],
      providers: [
        ...getTestProviders(),
        { provide: BillingPolicyService, useValue: policyStub },
        { provide: AiKeysService, useValue: aiKeysStub },
        { provide: EgressService, useValue: egressStub },
        { provide: ComputeService, useValue: computeStub },
      ],
    })
    .compileComponents();

    fixture = TestBed.createComponent(GeneralTabComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render the section headings', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('SETTINGS_GENERAL.TITLE');
    expect(text).toContain('SETTINGS_GENERAL.APPEARANCE');
    expect(text).toContain('SETTINGS_GENERAL.LANGUAGE');
    expect(text).toContain('SETTINGS_GENERAL.RECEIVE_NOTIFICATIONS');
  });

  it('should offer no save button, because every setting applies immediately', () => {
    // The theme toggle, language picker and push toggle all commit on change, so
    // there is nothing to submit. The previous assertion asked for a
    // `button[type="submit"]` reading COMMON.SAVE, which matched a design this
    // page no longer has.
    const button = fixture.nativeElement.querySelector('button[type="submit"]');

    expect(button).toBeNull();
  });

  it('clears the spend cap when the input is empty, rather than sending null', () => {
    // The route accepts `0` as "no cap" and REFUSES anything that is not a whole
    // number, so an empty box has to become `0`. Sending `null` would be a 400 and
    // the cap the customer just cleared would still be in force.
    component.spendCapControl.setValue(null);

    return component.saveSpendCap().then(() => {
      expect(patches[0]).toEqual({ spendCapCredits: 0 });
    });
  });

  it('saves the typed cap unchanged', () => {
    component.spendCapControl.setValue(250);

    return component.saveSpendCap().then(() => {
      expect(patches[0]).toEqual({ spendCapCredits: 250 });
    });
  });

  it('never saves the cap on change, only on submit', () => {
    // A number input emits per keystroke, so save-on-change would store `1` and
    // then `10` on the way to `100`, and a running session is stopped against the
    // first of those.
    component.spendCapControl.setValue(1);
    component.spendCapControl.setValue(10);
    component.spendCapControl.setValue(100);

    expect(patches.length).toBe(0);
  });

  it('refuses an empty proxy list without calling the route', () => {
    // The route answers 400 naming an entry INDEX, which means nothing for an
    // empty box -- so it is refused here instead, where the message can be acted
    // on. It also cannot be mistaken for "remove my proxies": that is a different
    // call, and only it purges the stored secret.
    component.egressUrlsControl.setValue('   \n  \n');

    return component.saveEgress().then(() => {
      expect(egressWrites.length).toBe(0);
      expect(component.egressError()).toBe('SETTINGS_EGRESS.EMPTY');
    });
  });

  it('sends the trimmed, non-empty lines as the pool', () => {
    component.egressUrlsControl.setValue(
      '  http://alice:hunter2@one.example.com:8080  \n\nhttp://bob:x@two.example.com:3128\n',
    );

    return component.saveEgress().then(() => {
      expect(egressWrites[0]).toEqual({
        mode: 'byo',
        proxies: [
          'http://alice:hunter2@one.example.com:8080',
          'http://bob:x@two.example.com:3128',
        ],
      });
    });
  });

  it('states the intent when switching back to the platform pool', () => {
    // `{mode:'platform'}`, not an empty list: the route treats the two as
    // different requests, and only this one deletes the pointer and purges the
    // stored secret.
    return component.usePlatformPool().then(() => {
      expect(egressWrites[0]).toEqual({ mode: 'platform' });
    });
  });

  it('empties the proxy box after a successful write', () => {
    // Otherwise the field sits on proxy passwords the user has stopped looking
    // at, and the status line above already confirms the write landed.
    component.egressUrlsControl.setValue('http://alice:hunter2@one.example.com:8080');

    return component.saveEgress().then(() => {
      expect(component.egressUrlsControl.value).toBe('');
      expect(component.egressMode()).toBe('byo');
    });
  });
});
