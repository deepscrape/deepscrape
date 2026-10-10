import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, of } from 'rxjs';

import { GeneralTabComponent } from './general.component';
import { BillingPolicyService } from '../../../../core/services/billing-policy.service';
import { AiKeysService } from '../../../../core/services/ai-keys.service';
import { AI_VENDORS } from '../../../../core/types';
import { getTestProviders } from 'src/app/testing';

describe('GeneralTabComponent', () => {
  let component: GeneralTabComponent;
  let fixture: ComponentFixture<GeneralTabComponent>;
  let patches: { spendCapCredits?: number }[];

  beforeEach(async () => {
    patches = [];

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
    // the engine rows out of this page's own assertions.
    const aiKeysStub = {
      catalogue: AI_VENDORS,
      isLoading: signal(false).asReadonly(),
      isLoaded: signal(true).asReadonly(),
      errorMessage: signal('').asReadonly(),
      engines: signal([]).asReadonly(),
      storedEngine: signal<string | null>(null).asReadonly(),
      load: (): Promise<void> => Promise.resolve(),
      resolve: () => ({ vendor: null, source: 'none', allowed: false }),
      stateFor: () => null,
      storeKey: (): Promise<boolean> => Promise.resolve(false),
      clearKey: (): Promise<boolean> => Promise.resolve(false),
      storeEngine: (): Promise<boolean> => Promise.resolve(false),
    } as unknown as AiKeysService;

    await TestBed.configureTestingModule({
      imports: [GeneralTabComponent],
      providers: [
        ...getTestProviders(),
        { provide: BillingPolicyService, useValue: policyStub },
        { provide: AiKeysService, useValue: aiKeysStub },
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
});
