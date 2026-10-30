import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PlansComponent } from './plans.component';
import { BillingService, HighRiskActionService } from 'src/app/core/services';
import { of } from 'rxjs';
import { getTestProviders } from 'src/app/testing';

describe('PlansComponent', () => {
  let component: PlansComponent;
  let fixture: ComponentFixture<PlansComponent>;
  let billingService: BillingService;

  beforeEach(async () => {
    const billingServiceMock: Partial<BillingService> = {
      getPlans$: () => of([]),
      billing$: of({
        plan: 'free',
        status: 'inactive',
        subscriptionId: null,
        graceUntil: null,
        trialUsedAt: null,
        credits: { balance: 0, reserved: 0, purchasedBalance: 0, purchasedReserved: 0, includedBalance: 0, includedReserved: 0 },
        features: {},
      }),
      getCreditPacks$: () => of([]),
      getCustomCreditsConfig$: () => of({
        enabled: true,
        minimumCredits: 50,
        maximumCredits: 5000,
        currency: 'eur',
        suggestedCredits: [100, 250, 500],
      }),
      openCheckoutForPlan: async () => ({ url: '', sessionId: '' }),
      startTrial: async () => ({ billing: { plan: 'trial' } }),
    }

    await TestBed.configureTestingModule({
      imports: [PlansComponent],
      providers: [
        ...getTestProviders(),
        { provide: BillingService, useValue: billingServiceMock },
        { provide: HighRiskActionService, useValue: { ensureVerified: async () => true } },
      ]
    })
      .compileComponents();

    fixture = TestBed.createComponent(PlansComponent);
    component = fixture.componentInstance;
    billingService = TestBed.inject(BillingService);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('starts trial from promo when eligible', async () => {
    const startTrialSpy = spyOn(billingService, 'startTrial').and.resolveTo({ billing: { plan: 'trial' } });
    spyOn(component, 'canStartTrial').and.returnValue(true);

    await component.startTrialFromPromo();

    expect(startTrialSpy).toHaveBeenCalledTimes(1);
  });

  it('does not start trial from promo when ineligible', async () => {
    const startTrialSpy = spyOn(billingService, 'startTrial').and.resolveTo({ billing: { plan: 'trial' } });
    spyOn(component, 'canStartTrial').and.returnValue(false);

    await component.startTrialFromPromo();

    expect(startTrialSpy).not.toHaveBeenCalled();
  });

  it('never recommends the plan the caller already pays for', () => {
    const pro = { id: 'pro', label: 'Pro', features: [], prices: {} } as never;
    const starter = { id: 'starter', label: 'Starter', features: [], prices: {} } as never;

    component.currentPlanValue = 'starter';
    expect(component.isBestChoice(pro)).toBe(true);

    component.currentPlanValue = 'pro';
    expect(component.isBestChoice(pro)).toBe(false);

    // An unlimited account is above the self-serve ladder; nothing to recommend to it.
    component.currentPlanValue = 'enterprise';
    expect(component.isBestChoice(pro)).toBe(false);
    expect(component.isBestChoice(starter)).toBe(false);
  });

  it('prices a custom amount at the pack rate it has earned, never below it', () => {
    const packs = [
      { id: 'credits_100', label: '100 credits', credits: 100, amount: 150, currency: 'eur' as const },
      { id: 'credits_500', label: '500 credits', credits: 500, amount: 600, currency: 'eur' as const },
      { id: 'credits_2000', label: '2000 credits', credits: 2000, amount: 2000, currency: 'eur' as const },
    ];

    component.customCreditsAmount.setValue('500');
    expect(component.getCustomCreditsTotal(packs)).toBe(600);
    expect(component.getCustomCreditRate(packs)).toBeCloseTo(0.012, 5);

    // Above the largest pack the rate stops improving; below the smallest it is that pack's.
    component.customCreditsAmount.setValue('5000');
    expect(component.getCustomCreditRate(packs)).toBeCloseTo(0.01, 5);
    component.customCreditsAmount.setValue('50');
    expect(component.getCustomCreditRate(packs)).toBeCloseTo(0.015, 5);
  });
});
