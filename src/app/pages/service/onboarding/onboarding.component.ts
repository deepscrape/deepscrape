import { Component, DestroyRef, OnInit, ChangeDetectionStrategy, computed, signal, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, FormArray, AbstractControl } from '@angular/forms';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { AuthService, BillingService, FirestoreService } from 'src/app/core/services';
import { OrganizationService } from 'src/app/core/services/organization.service';
import { serverTimestamp } from '@angular/fire/firestore';
import { BillingInterval, BillingPlanCatalog, BillingPlanTier } from 'src/app/core/types';
import { HttpErrorResponse } from '@angular/common/http';
import { animate, style, transition, trigger } from '@angular/animations';
import { resolveSafeReturnUrl } from 'src/app/core/functions';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [ReactiveFormsModule, MatProgressSpinner, MatIconModule, TranslateModule],
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('stepPanel', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(20px) scale(0.98)' }),
        animate('260ms cubic-bezier(0.2, 0.8, 0.2, 1)', style({ opacity: 1, transform: 'translateY(0) scale(1)' })),
      ]),
      transition(':leave', [
        animate('180ms ease-in', style({ opacity: 0, transform: 'translateY(-12px) scale(0.98)' })),
      ]),
    ]),
  ],
})
export class OnboardingComponent implements OnInit {
  private authService = inject(AuthService);
  private firestoreService = inject(FirestoreService);
  private billingService = inject(BillingService);
  private orgService = inject(OrganizationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private fb = inject(FormBuilder);
  private readonly translate = inject(TranslateService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);
  private readonly currentUser = toSignal(this.authService.user$);
  private readonly catalogPlans = toSignal(this.billingService.getPlans$(true), { initialValue: [] as BillingPlanCatalog[] });

  readonly totalSteps = 3;
  step = signal(1);
  loading = signal(false);
  errorMessage = signal('');
  enterpriseRequestLoading = signal(false);
  enterpriseRequestMessage = signal('');
  readonly stepItems = [
    { id: 1, title: 'ONBOARDING.STEP1_ITEM_T', subtitle: 'ONBOARDING.STEP1_ITEM_S', icon: 'business' },
    { id: 2, title: 'ONBOARDING.STEP2_ITEM_T', subtitle: 'ONBOARDING.STEP2_ITEM_S', icon: 'group_add' },
    { id: 3, title: 'ONBOARDING.STEP3_ITEM_T', subtitle: 'ONBOARDING.STEP3_ITEM_S', icon: 'diamond' },
  ] as const;

  workspaceForm!: FormGroup;
  inviteForm!: FormGroup;
  planForm!: FormGroup;
  enterpriseRequestForm!: FormGroup;

  readonly selectablePlans = computed(() => this.catalogPlans().filter((plan) => plan.id !== 'enterprise'));
  readonly enterprisePlan = computed(() => this.catalogPlans().find((plan) => plan.id === 'enterprise') || null);

  private get uid(): string | undefined {
    return this.currentUser()?.uid;
  }

  private get accountEmail(): string {
    return (this.currentUser()?.email || '').trim().toLowerCase();
  }

  private get defaultOrgId(): string | undefined {
    return this.currentUser()?.defaultOrgId;
  }

  get inviteEmails(): FormArray {
    return this.inviteForm.get('emails') as FormArray;
  }

  ngOnInit(): void {
    const displayName = this.currentUser()?.details?.displayName ?? '';
    const currentOrgName = `${displayName} Workspace`.trim();

    this.workspaceForm = this.fb.group({
      workspaceName: [currentOrgName || 'My Workspace', [Validators.required, Validators.minLength(2), Validators.maxLength(64)]],
    });

    this.inviteForm = this.fb.group({
      emails: this.fb.array([this.createEmailControl()]),
    });

    this.planForm = this.fb.group({
      plan: ['free'],
      interval: [null as BillingInterval | null],
    });

    this.enterpriseRequestForm = this.fb.group({
      mode: ['current'],
      contactEmail: [this.accountEmail, [Validators.required, Validators.email]],
    });

    this.enterpriseRequestForm.get('mode')?.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((mode) => {
        const useCurrent = mode !== 'custom';
        const nextValue = useCurrent ? this.accountEmail : '';
        this.enterpriseRequestForm.get('contactEmail')?.setValue(nextValue);
        this.enterpriseRequestForm.get('contactEmail')?.markAsPristine();
        this.enterpriseRequestMessage.set('');
      });
  }

  createEmailControl(): AbstractControl {
    return this.fb.control('', [Validators.email]);
  }

  addEmail(): void {
    if (this.inviteEmails.length < 5) {
      this.inviteEmails.push(this.createEmailControl());
    }
  }

  removeEmail(index: number): void {
    if (this.inviteEmails.length > 1) {
      this.inviteEmails.removeAt(index);
    }
  }

  selectPlan(planId: BillingPlanTier): void {
    if (planId === 'enterprise') {
      return;
    }

    const selectedPlan = this.selectablePlans().find((plan) => plan.id === planId) || null;
    const intervals = selectedPlan ? this.getAvailableIntervals(selectedPlan) : [];
    const currentInterval = this.planForm.get('interval')?.value as BillingInterval | null;
    const nextInterval = planId === 'free'
      ? null
      : (currentInterval && intervals.includes(currentInterval)
        ? currentInterval
        : (intervals[0] || null));

    this.planForm.get('plan')?.setValue(planId);
    this.planForm.get('interval')?.setValue(nextInterval);
  }

  getPreferredPriceLabel(plan: BillingPlanCatalog): string {
    if (plan.id === 'free') {
      return 'ONBOARDING.FREE';
    }

    const monthlyAmount = Number(plan.prices.monthly?.amount || 0);
    const paygAmount = Number(plan.prices.payAsYouGo?.amount || 0);
    const chosenAmount = monthlyAmount > 0 ? monthlyAmount : paygAmount;

    if (chosenAmount <= 0) {
      return 'EUR 0';
    }

    return `EUR ${this.formatCents(chosenAmount)}`;
  }

  getSelectedPlanCatalog(): BillingPlanCatalog | null {
    const selectedPlan = this.planForm.get('plan')?.value as BillingPlanTier | null;
    if (!selectedPlan) {
      return null;
    }

    return this.selectablePlans().find((plan) => plan.id === selectedPlan) || null;
  }

  getSelectedInterval(): BillingInterval | null {
    return (this.planForm.get('interval')?.value as BillingInterval | null) || null;
  }

  shouldShowBillingPeriod(): boolean {
    const selectedPlan = this.getSelectedPlanCatalog();
    return !!selectedPlan && selectedPlan.id !== 'free' && this.getAvailableIntervals(selectedPlan).length > 0;
  }

  isFreePlanSelected(): boolean {
    return this.planForm.get('plan')?.value === 'free';
  }

  getAvailableIntervals(plan: BillingPlanCatalog): BillingInterval[] {
    const intervals: BillingInterval[] = [];
    if (plan.prices.payAsYouGo) intervals.push('payAsYouGo');
    if (plan.prices.monthly) intervals.push('monthly');
    if (plan.prices.quarterly) intervals.push('quarterly');
    if (plan.prices.annually) intervals.push('annually');
    return intervals;
  }

  selectInterval(interval: BillingInterval): void {
    this.planForm.get('interval')?.setValue(interval);
  }

  getIntervalLabel(interval: BillingInterval): string {
    if (interval === 'payAsYouGo') return 'ONBOARDING.INTVL_PAYG';
    if (interval === 'monthly') return 'ONBOARDING.INTVL_MONTHLY';
    if (interval === 'quarterly') return 'ONBOARDING.INTVL_QUARTERLY';
    return 'ONBOARDING.INTVL_ANNUALLY';
  }

  getIntervalPriceLabel(plan: BillingPlanCatalog, interval: BillingInterval): string {
    const amount = Number(plan.prices[interval]?.amount || 0);
    if (amount <= 0) {
      return 'EUR 0';
    }

    return `EUR ${this.formatCents(amount)}`;
  }

  getPlanIntervals(plan: BillingPlanCatalog): string[] {
    const keys: string[] = [];
    if (plan.prices.payAsYouGo?.amount !== undefined) keys.push('ONBOARDING.INTVL_PAYG');
    if (plan.prices.monthly?.amount !== undefined) keys.push('ONBOARDING.INTVL_MONTHLY');
    if (plan.prices.quarterly?.amount !== undefined) keys.push('ONBOARDING.INTVL_QUARTERLY');
    if (plan.prices.annually?.amount !== undefined) keys.push('ONBOARDING.INTVL_ANNUALLY');
    return keys;
  }

  isEnterpriseCustomEmailMode(): boolean {
    return this.enterpriseRequestForm.get('mode')?.value === 'custom';
  }

  getCurrentEnterpriseEmailLabel(): string {
    return this.accountEmail || 'ONBOARDING.NO_EMAIL';
  }

  async submitEnterpriseRequest(): Promise<void> {
    if (!this.uid || this.enterpriseRequestLoading()) {
      return;
    }

    const mode = this.enterpriseRequestForm.get('mode')?.value;
    const contactEmail = String(mode === 'custom' ? this.enterpriseRequestForm.get('contactEmail')?.value : this.accountEmail)
      .trim()
      .toLowerCase();
    if (!contactEmail || this.enterpriseRequestForm.get('contactEmail')?.invalid) {
      this.enterpriseRequestForm.get('contactEmail')?.markAsTouched();
      return;
    }

    this.enterpriseRequestLoading.set(true);
    this.enterpriseRequestMessage.set('');

    try {
      await this.billingService.submitEnterprisePlanRequest({
        contactEmail,
        workspaceName: String(this.workspaceForm.value.workspaceName || '').trim(),
        selectedPlan: this.planForm.value.plan || null,
      });
      this.enterpriseRequestMessage.set(this.translate.instant('ONBOARDING.ENTERPRISE_REQ_SENT'));
    } catch (error: any) {
      this.enterpriseRequestMessage.set(error?.message || this.translate.instant('ONBOARDING.ENTERPRISE_REQ_FAILED'));
    } finally {
      this.enterpriseRequestLoading.set(false);
    }
  }

  next(): void {
    if (this.step() < this.totalSteps) {
      this.step.update(s => s + 1);
    }
  }

  back(): void {
    if (this.step() > 1) {
      this.step.update(s => s - 1);
    }
  }

  skip(): void {
    if (this.step() < this.totalSteps) {
      this.next();
    } else {
      this.complete();
    }
  }

  getCtaLabel(): string {
    const planId = this.planForm?.get('plan')?.value as BillingPlanTier | null;
    const interval = this.getSelectedInterval();
    if (planId && planId !== 'free' && planId !== 'enterprise' && interval) {
      return 'ONBOARDING.CTA_CHECKOUT';
    }
    return 'ONBOARDING.CTA_START';
  }

  async complete(): Promise<void> {
    const uid = this.uid;
    if (!uid || this.loading()) return;

    this.loading.set(true);
    this.errorMessage.set('');

    const selectedPlanId = this.planForm.get('plan')?.value as BillingPlanTier | null;
    const selectedInterval = this.getSelectedInterval();
    const shouldCheckout = !!selectedPlanId
      && selectedPlanId !== 'free'
      && selectedPlanId !== 'enterprise'
      && !!selectedInterval;

    try {
      // Step 1 result: rename the org. `createDefaultOrganization` always writes
      // `org_<uid>`, so a profile that has not delivered `defaultOrgId` yet must not
      // silently drop the workspace name and every invitation below.
      const orgId = this.defaultOrgId ?? `org_${uid}`;
      const workspaceName = this.workspaceForm.value.workspaceName?.trim();
      if (orgId && workspaceName) {
        await this.orgService.renameOrganization(orgId, workspaceName).toPromise();
      }

      // Step 2 result: send invitations for filled email fields
      const validEmails = (this.inviteForm.value.emails as string[])
        .map(e => e?.trim())
        .filter(e => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

      if (orgId && validEmails.length) {
        for (const email of validEmails) {
          await this.orgService.createInvitation(orgId, email, 'member').toPromise();
        }
      }

      // Mark onboarding complete before redirecting to Stripe (idempotent).
      await this.firestoreService.setUserData(uid, {
        onboardedAt: serverTimestamp() as any,
      });

      // For paid plans: redirect to Stripe Checkout. On success/cancel Stripe
      // returns to /dashboard so the user is always onboarded regardless.
      if (shouldCheckout && isPlatformBrowser(this.platformId)) {
        const origin = window.location.origin;
        const { url } = await this.billingService.openCheckoutForPlan({
          planId: selectedPlanId!,
          interval: selectedInterval!,
          successUrl: `${origin}/dashboard?checkout=success`,
          cancelUrl: `${origin}/dashboard`,
        });
        if (url) {
          window.location.href = url;
          return;
        }
      }

      this.router.navigateByUrl(this.getReturnUrl());
    } catch (err: any) {
      this.errorMessage.set(this.getOnboardingErrorMessage(err));
      this.loading.set(false);
    }
  }

  private formatCents(amount: number): string {
    return (amount / 100).toFixed(2);
  }

  private getOnboardingErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error
      if (typeof body === 'string' && body.trim()) {
        return body
      }

      if (typeof body === 'object' && body) {
        const message = (body as { message?: unknown; error?: unknown }).message || (body as { error?: unknown }).error
        if (typeof message === 'string' && message.trim()) {
          return message
        }
      }
    }

    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }

    return this.translate.instant('ONBOARDING.GENERIC_ERROR')
  }

  private getReturnUrl(): string {
    return resolveSafeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'))
  }
}
