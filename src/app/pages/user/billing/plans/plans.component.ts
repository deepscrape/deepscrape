import { AsyncPipe, CurrencyPipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { RippleDirective } from 'src/app/core/directives';
import { StinputComponent } from 'src/app/core/components';
import { animate, style, transition, trigger } from '@angular/animations';
import {
  BillingLoadingState,
  BillingInterval,
  BillingPlanCatalog,
  BillingPlanTier,
  CustomCreditsCatalog,
  CreditPackCatalog,
  PlanPeriod,
  UserBilling,
} from 'src/app/core/types';
import { AuthService, BillingService, HighRiskActionService } from 'src/app/core/services';
import { catchError, combineLatest, firstValueFrom, map, Observable, of, shareReplay, startWith } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WindowToken } from 'src/app/core/services';

@Component({
    selector: 'app-plans',
  imports: [RippleDirective, CurrencyPipe, AsyncPipe, NgClass, MatIconModule, MatProgressSpinnerModule, ReactiveFormsModule, TranslateModule, StinputComponent],
    templateUrl: './plans.component.html',
    styleUrl: './plans.component.scss',
    animations: [
      trigger('offerBadgeAnimation', [
        transition(':enter', [
          style({ opacity: 0, transform: 'translateY(-8px) scale(0.96)' }),
          animate('260ms ease-out', style({ opacity: 1, transform: 'translateY(0) scale(1)' })),
        ]),
        transition(':leave', [
          animate('220ms ease-in', style({ opacity: 0, transform: 'translateY(-6px) scale(0.98)' })),
        ]),
      ]),
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
})


export class PlansComponent {
  private window: Window = inject(WindowToken)
  private readonly destroyRef = inject(DestroyRef)
  private readonly translate = inject(TranslateService)
  planView: PlanPeriod
  planPeriods: Array<PlanPeriod> = []

  currencyValue: string = "EUR"

  readonly plans$: Observable<BillingPlanCatalog[]>
  readonly freePlan$: Observable<BillingPlanCatalog | null>
  readonly trialPlan$: Observable<BillingPlanCatalog | null>
  readonly creditPacks$: Observable<CreditPackCatalog[]>
  readonly customCreditsConfig$: Observable<CustomCreditsCatalog>
  readonly billing$: Observable<UserBilling>
  readonly currentPlan$: Observable<BillingPlanTier>
  currentPlanValue: BillingPlanTier | null = null
  currentBillingValue: UserBilling | null = null
  offerBadgeMessage: string | null = null
  isBillingRestricted = false
  platformAdminBypassActive = false
  // ponytail: string control — StinputComponent is FormControl<string>; the value is
  // parsed with Number() wherever it is used and clamped on blur.
  readonly customCreditsAmount = new FormControl('250', { nonNullable: true })
  readonly loadingState$ = this.billingService.loadingState$
  readonly pageReady$: Observable<boolean>

  currentPrice: PlanPeriod = { value: "monthly", label: "BILLING_PLAN_DETAILS.INT_MONTHLY" }

  private readonly periodByInterval: Record<BillingInterval, PlanPeriod> = {
    payAsYouGo: { value: "payAsYouGo", label: "BILLING_PLAN_DETAILS.INT_PAY_AS_YOU_GO" },
    monthly: { value: "monthly", label: "BILLING_PLAN_DETAILS.INT_MONTHLY" },
    quarterly: { value: "quarterly", label: "BILLING_PLAN_DETAILS.INT_QUARTERLY" },
    annually: { value: "annually", label: "BILLING_PLAN_DETAILS.INT_ANNUALLY" },
  }

  private readonly restrictedRoleKeywords = ['manager', 'editor']

  constructor(
    private readonly billingService: BillingService,
    private readonly authService: AuthService,
    private readonly highRiskActionService: HighRiskActionService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
  ) {
    const catalogPlans$ = this.billingService.getPlans$()
    this.freePlan$ = catalogPlans$.pipe(map((plans) => plans.find((plan) => plan.id === 'free') || null))
    this.trialPlan$ = catalogPlans$.pipe(map((plans) => plans.find((plan) => plan.id === 'trial') || null))
    this.plans$ = catalogPlans$.pipe(map((plans) => plans.filter((plan) => plan.id !== 'trial' && plan.id !== 'free')))
    this.billing$ = this.billingService.billing$
    this.currentPlan$ = this.billing$.pipe(map((billing) => billing.plan))
    this.billing$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((billing) => {
      this.currentBillingValue = billing
      this.currentPlanValue = billing.plan

      const planInterval = billing.planInterval
      if (planInterval && this.periodByInterval[planInterval]) {
        this.currentPrice = this.periodByInterval[planInterval]
      }
    })

    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const shouldShowOffer = params.get('offer') === '1'
      if (!shouldShowOffer) {
        this.offerBadgeMessage = null
        return
      }

      this.offerBadgeMessage = params.get('offerMessage') || this.translate.instant('BILLING_PLANS.OFFER_MESSAGE')
      this.window.setTimeout(() => {
        this.offerBadgeMessage = null
      }, 6500)
    })

    this.creditPacks$ = this.billingService.getCreditPacks$()
    this.customCreditsConfig$ = this.billingService.getCustomCreditsConfig$()
    this.pageReady$ = combineLatest([
      this.billing$,
      this.freePlan$,
      this.trialPlan$,
      this.plans$,
      this.creditPacks$,
      this.customCreditsConfig$,
    ]).pipe(
      map(() => true),
      startWith(false),
      catchError(() => of(true)),
      shareReplay({ bufferSize: 1, refCount: true }),
    )

    this.authService.user$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((user) => {
      this.platformAdminBypassActive = this.authService.isAdmin
      this.isBillingRestricted = !this.platformAdminBypassActive && this.isRestrictedRole(user?.role)
    })

    this.planPeriods = [
      { value: "payAsYouGo", label: "BILLING_PLAN_DETAILS.INT_PAY_AS_YOU_GO" },
      { value: "monthly", label: "BILLING_PLAN_DETAILS.INT_MONTHLY" },
      { value: "quarterly", label: "BILLING_PLAN_DETAILS.INT_QUARTERLY" },
      { value: "annually", label: "BILLING_PLAN_DETAILS.INT_ANNUALLY" }]


    if (!this.currentPrice.value || !this.currentPlan$)
      this.planView = { value: "payAsYouGo", label: "BILLING_PLAN_DETAILS.INT_PAY_AS_YOU_GO" }
    else this.planView = this.currentPrice
  }

  switchPlanView(plan: PlanPeriod) {
    this.planView = plan
  }

  isBusy(loading: BillingLoadingState | null | undefined): boolean {
    if (!loading) {
      return false
    }

    return loading.checkout || loading.portal || loading.trial || loading.resumeCancellation
  }

  getPrice(plan: BillingPlanCatalog): number {
    const interval = this.planView.value as BillingInterval
    return plan.prices[interval]?.amount || 0
  }

  getIncludedCredits(plan: BillingPlanCatalog): number {
    const interval = this.planView.value as BillingInterval
    return plan.prices[interval]?.includedCredits || 0
  }

  canPurchaseCredits(billing: UserBilling | null | undefined): boolean {
    if (this.isBillingRestricted) {
      return false
    }

    if (!billing) {
      return false
    }

    return billing.plan === 'free' && !billing.subscriptionId
  }

  getAvailableCredits(billing: UserBilling | null | undefined): number {
    if (!billing) {
      return 0
    }

    if (billing.credits.purchasedBalance !== undefined) {
      return Math.max(0, (billing.credits.purchasedBalance || 0) - (billing.credits.purchasedReserved || 0))
    }

    return billing.plan === 'free' ? Math.max(0, (billing.credits.balance || 0) - (billing.credits.reserved || 0)) : 0
  }

  getIncludedPlanCredits(billing: UserBilling | null | undefined): number {
    if (!billing) {
      return 0
    }

    if (billing.credits.includedBalance !== undefined) {
      return Math.max(0, (billing.credits.includedBalance || 0) - (billing.credits.includedReserved || 0))
    }

    return billing.plan !== 'free' ? Math.max(0, (billing.credits.balance || 0) - (billing.credits.reserved || 0)) : 0
  }

  hasCreditAccess(billing: UserBilling | null | undefined): boolean {
    if (!billing) {
      return false
    }

    return billing.plan === 'free' && this.getAvailableCredits(billing) > 0
  }

  getCreditsUnavailableMessage(billing: UserBilling | null | undefined): string {
    if (!billing) {
      return 'BILLING_PLANS.CREDITS_UNAVAILABLE_NO_BILLING'
    }

    if (billing.plan !== 'free') {
      return 'BILLING_PLANS.CREDITS_UNAVAILABLE_SUBSCRIPTION_ACTIVE'
    }

    if (billing.subscriptionId) {
      return 'BILLING_PLANS.CREDITS_UNAVAILABLE_SUBSCRIPTION_ATTACHED'
    }

    return 'BILLING_PLANS.CREDITS_UNAVAILABLE_FREE_ONLY'
  }

  clampCustomCredits(config: CustomCreditsCatalog): void {
    const value = Math.floor(Number(this.customCreditsAmount.value || 0))
    if (!Number.isFinite(value)) {
      this.customCreditsAmount.setValue(String(config.minimumCredits), { emitEvent: false })
      return
    }

    this.customCreditsAmount.setValue(
      String(Math.min(config.maximumCredits, Math.max(config.minimumCredits, value))),
      { emitEvent: false },
    )
  }

  getCustomCreditsTotal(config: CustomCreditsCatalog): number {
    const credits = Math.floor(Number(this.customCreditsAmount.value || 0))
    if (!Number.isFinite(credits) || credits <= 0) {
      return 0
    }

    return credits * config.unitAmount
  }

  setSuggestedCustomCredits(credits: number, config: CustomCreditsCatalog): void {
    this.customCreditsAmount.setValue(String(credits), { emitEvent: false })
    this.clampCustomCredits(config)
  }

  getPriceUnit(): string {
    switch (this.planView.value) {
    case 'monthly':
      return 'BILLING_PLANS.PRICE_UNIT_MONTH'
    case 'quarterly':
      return 'BILLING_PLANS.PRICE_UNIT_QUARTER'
    case 'annually':
      return 'BILLING_PLANS.PRICE_UNIT_YEAR'
    default:
      return 'BILLING_PLANS.PRICE_UNIT_USAGE'
    }
  }

  canCheckoutPlan(plan: BillingPlanCatalog): boolean {
    if (this.isBillingRestricted) {
      return false
    }

    if (plan.id === 'free' || plan.id === 'trial') {
      return false
    }

    const interval = this.planView.value as BillingInterval
    return Boolean(plan.prices[interval]?.stripePriceId)
  }

  isBestChoice(plan: BillingPlanCatalog): boolean {
    return plan.id === 'pro'
  }

  getPriceGradientClass(plan: BillingPlanCatalog): string {
    if (plan.id === 'starter') {
      return 'from-orange-400 to-deep-orange-400 dark:from-orange-400 dark:to-deep-orange-400'
    }

    if (plan.id === 'enterprise') {
      return 'from-primary to-violet-500 dark:from-primary dark:to-violet-500'
    }

    return 'from-violet-400 to-deep-purple-400 dark:from-violet-400 dark:to-deep-purple-400'
  }

  getPlanButtonClass(plan: BillingPlanCatalog): string {
    if (plan.id === 'starter') {
      return 'hover:bg-orange-900/[0.5] focus:bg-orange-900/[0.8] bg-orange-600/[.8]'
    }

    if (plan.id === 'enterprise') {
      return 'hover:bg-primary/70 focus:bg-primary/80 bg-primary/80'
    }

    return 'hover:bg-violet-900/[0.5] focus:bg-violet-900/[0.8] bg-violet-600/[.8]'
  }

  getCurrentPlanButtonClass(plan: BillingPlanCatalog): string {
    return 'bg-transparent dark:bg-transparent text-green-600 dark:text-green-300 border border-green-500/40 dark:border-green-400/40 cursor-not-allowed'
  }

  isCurrentPlan(plan: BillingPlanCatalog, currentPlan: BillingPlanTier | null, billing?: UserBilling | null): boolean {
    if (currentPlan !== plan.id) {
      return false
    }

    if (!billing) {
      return true
    }

    if (plan.id === 'free' || plan.id === 'trial') {
      return true
    }

    const activeInterval = billing.planInterval
    if (!activeInterval) {
      return true
    }

    return activeInterval === this.planView.value
  }

  isRestrictedRole(role: string | null | undefined): boolean {
    const normalizedRole = (role || '').trim().toLowerCase()
    if (!normalizedRole) {
      return false
    }

    return this.restrictedRoleKeywords.some((keyword) => normalizedRole === keyword || normalizedRole.includes(keyword))
  }

  canStartTrial(billing: UserBilling | null | undefined): boolean {
    if (this.isBillingRestricted) {
      return false
    }

    if (!billing) {
      return true
    }

    if (billing.plan !== 'free' && billing.plan !== 'trial') {
      return false
    }

    if (billing.plan === 'trial') {
      return false
    }

    return !billing.trialUsedAt
  }

  shouldShowTrialPromo(trialPlan: BillingPlanCatalog | null | undefined, billing: UserBilling | null | undefined): boolean {
    return Boolean(trialPlan) && this.canStartTrial(billing)
  }

  shouldShowTrialStatus(trialPlan: BillingPlanCatalog | null | undefined, billing: UserBilling | null | undefined): boolean {
    if (!trialPlan || !billing) {
      return false
    }

    return Boolean(billing.trialUsedAt)
  }

  getTrialStatusMessage(billing: UserBilling | null | undefined): { key: string; params: { date: string } } {
    if (!billing?.trialUsedAt) {
      return { key: 'BILLING_PLANS.TRIAL_STATUS_AVAILABLE', params: { date: '' } }
    }

    if (billing.plan === 'trial') {
      const endsAt = billing.trialEndsAt ? new Date(billing.trialEndsAt).toLocaleDateString() : ''
      return endsAt
        ? { key: 'BILLING_PLANS.TRIAL_STATUS_ACTIVE_UNTIL', params: { date: endsAt } }
        : { key: 'BILLING_PLANS.TRIAL_STATUS_ACTIVE', params: { date: '' } }
    }

    return { key: 'BILLING_PLANS.TRIAL_STATUS_USED', params: { date: '' } }
  }

  isPlanActionDisabled(plan: BillingPlanCatalog, currentPlan: BillingPlanTier | null, billing: UserBilling | null | undefined): boolean {
    if (this.isBillingRestricted) {
      return true
    }

    if (this.isCurrentPlan(plan, currentPlan, billing)) {
      return true
    }

    if (plan.id === 'trial') {
      return !this.canStartTrial(billing)
    }

    return false
  }

  getPlanActionLabel(plan: BillingPlanCatalog, currentPlan: BillingPlanTier | null, billing: UserBilling | null | undefined): string {
    if (this.isCurrentPlan(plan, currentPlan, billing)) {
      return 'BILLING_PLAN_DETAILS.CURRENT_PLAN'
    }

    if (plan.id === 'trial') {
      return this.canStartTrial(billing) ? 'BILLING_PLANS.START_TRIAL' : 'BILLING_PLANS.TRIAL_ALREADY_USED'
    }

    return 'BILLING_PLANS.SELECT_PLAN'
  }

  getPlanTabClass(plan: BillingPlanCatalog, currentPlan: BillingPlanTier | null, billing: UserBilling | null | undefined): string {
    const base = 'relative inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70'

    if (this.isCurrentPlan(plan, currentPlan, billing)) {
      return `${base} bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 ring-1 ring-green-400/50 dark:ring-green-500/30 shadow-sm`
    }

    return `${base} text-white shadow-sm ${this.getPlanButtonClass(plan)}`
  }

  shouldShowFreeRecommendedBadge(plan: BillingPlanCatalog, currentPlan: BillingPlanTier | null, billing: UserBilling | null | undefined): boolean {
    return plan.id === 'free' && this.isCurrentPlan(plan, currentPlan, billing)
  }

  isCancellationPendingForPlan(plan: BillingPlanCatalog, billing: UserBilling | null | undefined, currentPlan: BillingPlanTier | null): boolean {
    if (plan.id === 'free') {
      return false
    }

    if (!billing?.subscriptionId) {
      return false
    }

    if (!this.isCurrentPlan(plan, currentPlan, billing)) {
      return false
    }

    return Boolean(billing.cancelAtPeriodEnd && billing.currentPeriodEnd)
  }

  getCancellationEndLabel(billing: UserBilling | null | undefined): string {
    if (!billing?.currentPeriodEnd) {
      return 'BILLING_PLANS.CANCELLATION_END_PERIOD'
    }

    const endingAt = new Date(billing.currentPeriodEnd)
    if (Number.isNaN(endingAt.getTime())) {
      return 'BILLING_PLANS.CANCELLATION_END_PERIOD'
    }

    return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(endingAt)
  }

  getCancellationTimeRemainingText(billing: UserBilling | null | undefined): { key: string; params: { days: number; hours: number; minutes: number } } {
    if (!billing?.currentPeriodEnd) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_MOMENTS', params: { days: 0, hours: 0, minutes: 0 } }
    }

    const endingAt = new Date(billing.currentPeriodEnd).getTime()
    if (Number.isNaN(endingAt)) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_MOMENTS', params: { days: 0, hours: 0, minutes: 0 } }
    }

    const msRemaining = endingAt - Date.now()
    if (msRemaining <= 0) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_MOMENTS', params: { days: 0, hours: 0, minutes: 0 } }
    }

    const totalMinutes = Math.floor(msRemaining / 60000)
    const days = Math.floor(totalMinutes / 1440)
    const hours = Math.floor((totalMinutes % 1440) / 60)
    const minutes = totalMinutes % 60

    const empty = { days: 0, hours: 0, minutes: 0 }
    if (days > 0 && hours > 0) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_DAYS_HOURS', params: { days, hours, minutes } }
    }

    if (days > 0) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_DAYS', params: { days, hours, minutes } }
    }

    if (hours > 0 && minutes > 0) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_HOURS_MINUTES', params: { days, hours, minutes } }
    }

    if (hours > 0) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_HOURS', params: { days, hours, minutes } }
    }

    if (minutes > 0) {
      return { key: 'BILLING_PLANS.CANCEL_TIME_MINUTES', params: { days, hours, minutes } }
    }

    return { key: 'BILLING_PLANS.CANCEL_TIME_MOMENTS', params: empty }
  }

  openPlanDetails(planId: BillingPlanTier): void {
    void this.router.navigate(['/billing/plans', planId])
  }

  openTrialDetails(): void {
    this.openPlanDetails('trial')
  }

  async startTrialFromPromo(): Promise<void> {
    const billing = await firstValueFrom(this.billing$)
    if (!this.canStartTrial(billing)) {
      return
    }

    try {
      const verified = await this.highRiskActionService.ensureVerified('billing_change')
      if (!verified) {
        return
      }

      await this.billingService.startTrial()
    } catch (error) {
      console.error('Unable to start trial from plans promo', error)
    }
  }

  openUsage(): void {
    void this.router.navigate(['/billing/usage'])
  }

  async selectPlan(plan: BillingPlanCatalog): Promise<void> {
    if (this.isBillingRestricted) {
      return
    }

    if (this.isCurrentPlan(plan, this.currentPlanValue, this.currentBillingValue)) {
      this.openPlanDetails(plan.id)
      return
    }

    if (plan.id === 'trial') {
      const billing = await firstValueFrom(this.billing$)
      if (!this.canStartTrial(billing)) {
        return
      }

      try {
        const verified = await this.highRiskActionService.ensureVerified('billing_change')
        if (!verified) {
          return
        }
        await this.billingService.startTrial()
      } catch (error) {
        console.error('Unable to start trial', error)
      }
      return
    }

    if (!this.canCheckoutPlan(plan)) {
      this.openPlanDetails(plan.id)
      return
    }

    try {
      const verified = await this.highRiskActionService.ensureVerified('billing_change')
      if (!verified) {
        return
      }

      const successUrl = `${this.window.location.origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`
      const cancelUrl = `${this.window.location.origin}/billing/plans?offer=1&offerMessage=${encodeURIComponent(this.translate.instant('BILLING_PLANS.OFFER_MESSAGE'))}`

      const result = await this.billingService.openCheckoutForPlan({
        planId: plan.id,
        interval: this.planView.value as BillingInterval,
        successUrl,
        cancelUrl,
      })

      if (result.url) {
        this.window.location.assign(result.url)
      }
    } catch (error) {
      console.error('Unable to create checkout session', error)
    }
  }

  async buyCredits(pack: CreditPackCatalog): Promise<void> {
    if (!this.canPurchaseCredits(this.currentBillingValue)) {
      return
    }

    try {
      const verified = await this.highRiskActionService.ensureVerified('billing_change')
      if (!verified) {
        return
      }

      const successUrl = `${this.window.location.origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`
      const cancelUrl = `${this.window.location.origin}/billing/plans?offer=1&offerMessage=${encodeURIComponent(this.translate.instant('BILLING_PLANS.OFFER_MESSAGE'))}`

      const result = await this.billingService.openCheckoutForCreditPack({
        planId: pack.id,
        successUrl,
        cancelUrl,
      })

      if (result.url) {
        this.window.location.assign(result.url)
      }
    } catch (error) {
      console.error('Unable to create credit pack checkout session', error)
    }
  }

  async buyCustomCredits(config: CustomCreditsCatalog): Promise<void> {
    if (!this.canPurchaseCredits(this.currentBillingValue)) {
      return
    }

    this.clampCustomCredits(config)

    try {
      const verified = await this.highRiskActionService.ensureVerified('billing_change')
      if (!verified) {
        return
      }

      const successUrl = `${this.window.location.origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`
      const cancelUrl = `${this.window.location.origin}/billing/plans?offer=1&offerMessage=${encodeURIComponent(this.translate.instant('BILLING_PLANS.CUSTOM_CREDITS_CANCEL_MESSAGE'))}`

      const result = await this.billingService.openCheckoutForCustomCredits({
        credits: Number(this.customCreditsAmount.value),
        successUrl,
        cancelUrl,
      })

      if (result.url) {
        this.window.location.assign(result.url)
      }
    } catch (error) {
      console.error('Unable to create custom credits checkout session', error)
    }
  }

  async openPortal(): Promise<void> {
    if (this.isBillingRestricted) {
      return
    }

    try {
      const verified = await this.highRiskActionService.ensureVerified('billing_change')
      if (!verified) {
        return
      }

      const url = await this.billingService.openBillingPortal(this.window.location.origin + '/billing/plans')
      if (url) {
        this.window.location.assign(url)
      }
    } catch (error) {
      console.error('Unable to open billing portal', error)
    }
  }

  async undoCancellation(): Promise<void> {
    const loading = await firstValueFrom(this.loadingState$)
    if (this.isBillingRestricted || loading.resumeCancellation) {
      return
    }

    try {
      const verified = await this.highRiskActionService.ensureVerified('billing_change')
      if (!verified) {
        return
      }

      await this.billingService.resumeSubscriptionCancellation()
    } catch (error) {
      console.error('Unable to resume subscription cancellation', error)
    }
  }

}
