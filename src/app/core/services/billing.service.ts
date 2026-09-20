import { inject, Injectable } from '@angular/core'
import { BehaviorSubject, catchError, combineLatest, from, map, Observable, of, shareReplay, switchMap, tap } from 'rxjs'
import {
  BillingAccessMode,
  BillingCatalogPayload,
  BillingInterval,
  BillingLoadingState,
  BillingPlanTier,
  EnterprisePlanRequestPayload,
  BillingUsageRequest,
  BillingUsageResponse,
  CreditPackCatalog,
  UserBilling,
} from '../types'
import { AnalyticsService } from './analytics.service'
import { AuthService } from './auth.service'
import { CacheService } from './cache.service'
import { FirestoreService } from './firestore.service'

@Injectable({
  providedIn: 'root'
})
export class BillingService {
  private readonly authService = inject(AuthService)
  private readonly cacheService = inject(CacheService)
  private readonly firestoreService = inject(FirestoreService)
  private readonly analyticsService = inject(AnalyticsService)
  private readonly billingCacheNamespace = 'billing-entitlements'
  private readonly billingCacheTtlMs = 5 * 60 * 1000
  private readonly loadingStateSubject = new BehaviorSubject<BillingLoadingState>({
    checkout: false,
    portal: false,
    trial: false,
    resumeCancellation: false,
    usageReport: false,
  })

  readonly loadingState$ = this.loadingStateSubject.asObservable()

  private setLoading<K extends keyof BillingLoadingState>(key: K, value: boolean): void {
    this.loadingStateSubject.next({
      ...this.loadingStateSubject.value,
      [key]: value,
    })
  }

  private createCheckoutRequestId(prefix: string): string {
    const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`

    return `${prefix}-${Date.now()}-${randomPart}`
  }

  private getPurchasedCredits(billing: Partial<UserBilling> | UserBilling | undefined): number {
    if (!billing?.credits) {
      return 0
    }

    if (billing.credits.purchasedBalance !== undefined) {
      return Number(billing.credits.purchasedBalance || 0) - Number(billing.credits.purchasedReserved || 0)
    }

    return billing.plan === 'free' ? Number(billing.credits.balance || 0) - Number(billing.credits.reserved || 0) : 0
  }

  private getIncludedCredits(billing: Partial<UserBilling> | UserBilling | undefined): number {
    if (!billing?.credits) {
      return 0
    }

    if (billing.credits.includedBalance !== undefined) {
      return Number(billing.credits.includedBalance || 0) - Number(billing.credits.includedReserved || 0)
    }

    return billing.plan && billing.plan !== 'free' ? Number(billing.credits.balance || 0) - Number(billing.credits.reserved || 0) : 0
  }

  // FIX #4: one-shot callable read + manual refresh trigger (eliminates real-time listener cost).
  // Billing is denormalized onto user doc (FIX #3) so getMyEntitlements returns fresh data;
  // call refreshBilling() after any local mutation to re-fetch.
  private readonly billingRefreshTrigger$ = new BehaviorSubject<number>(0)

  refreshBilling(): void {
    this.cacheService.clear(this.billingCacheNamespace)
    this.billingRefreshTrigger$.next(this.billingRefreshTrigger$.value + 1)
  }

  readonly billing$: Observable<UserBilling> = combineLatest([
    this.firestoreService.authState(),
    this.billingRefreshTrigger$,
  ]).pipe(
    switchMap(([firebaseUser]) => {
      if (!firebaseUser) {
        return of(this.defaultBilling())
      }

      const cached = this.cacheService.get<string, UserBilling>(this.billingCacheNamespace, firebaseUser.uid)
      if (cached) {
        return of(cached)
      }

      return from(this.firestoreService.callFunction<void, { billing?: Partial<UserBilling> }>('getMyEntitlements')).pipe(
        map((entitlements) => this.mergeWithDefault(entitlements?.billing as Partial<UserBilling> | undefined)),
        tap((billing) => this.cacheService.set(this.billingCacheNamespace, firebaseUser.uid, billing, this.billingCacheTtlMs)),
        catchError(() => of(this.defaultBilling()))
      )
    }),
    catchError(() => of(this.defaultBilling())),
    shareReplay({ bufferSize: 1, refCount: true })
  )

  readonly catalog$: Observable<BillingCatalogPayload> = this.fetchCatalog().pipe(
    shareReplay({ bufferSize: 1, refCount: true })
  )

  readonly isPlatformAdmin$: Observable<boolean> = this.authService.user$.pipe(
    map(() => this.authService.isAdmin),
    shareReplay({ bufferSize: 1, refCount: true })
  )

  hasFeature$(featureKey: string): Observable<boolean> {
    return combineLatest([this.billing$, this.isPlatformAdmin$]).pipe(
      map(([billing, isPlatformAdmin]) => isPlatformAdmin || Boolean(billing.features?.[featureKey]))
    )
  }

  getAccessMode$(): Observable<BillingAccessMode> {
    return this.billing$.pipe(map((billing) => {
      const paidPlans: BillingPlanTier[] = ['trial', 'starter', 'pro', 'enterprise']
      const hasPaidPlan = paidPlans.includes(billing.plan)
      const hasCreditAccess = billing.plan === 'free' && this.getPurchasedCredits(billing) > 0
      const hasGrace = !!billing.graceUntil && Date.now() < new Date(billing.graceUntil).getTime()

      if (hasPaidPlan) {
        return 'plan'
      }

      if (hasCreditAccess) {
        return 'credits'
      }

      if (hasGrace) {
        return 'grace'
      }

      return 'free'
    }))
  }

  hasCreditAccess$(): Observable<boolean> {
    return this.getAccessMode$().pipe(map((mode) => mode === 'credits'))
  }

  canPurchaseCredits$(): Observable<boolean> {
    return this.billing$.pipe(map((billing) => billing.plan === 'free' && !billing.subscriptionId))
  }

  getPurchasedCredits$(): Observable<number> {
    return this.billing$.pipe(map((billing) => this.getPurchasedCredits(billing)))
  }

  getIncludedCredits$(): Observable<number> {
    return this.billing$.pipe(map((billing) => this.getIncludedCredits(billing)))
  }

  canAccessPaidFeatures$(): Observable<boolean> {
    return combineLatest([this.getAccessMode$(), this.isPlatformAdmin$]).pipe(
      map(([mode, isPlatformAdmin]) => isPlatformAdmin || mode !== 'free')
    )
  }

  async openCheckoutForPlan(args: {
    planId: BillingPlanTier
    interval: BillingInterval
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string; sessionId: string }> {
    this.setLoading('checkout', true)
    try {
      const session = await this.firestoreService.callFunction<{
        planId: BillingPlanTier
        interval: BillingInterval
        successUrl: string
        cancelUrl: string
        checkoutRequestId: string
      }, { url: string; sessionId: string }>('createCheckoutSession', {
        ...args,
        checkoutRequestId: this.createCheckoutRequestId('plan'),
      })
      // Emitted only once Stripe handed a session back. A failed callable is not a
      // checkout, and counting it would put phantom drop-off at the top of the funnel.
      this.analyticsService.trackEvent('checkout_started', { kind: 'plan', planId: args.planId, interval: args.interval })
        .subscribe({ error: () => undefined })
      return session
    } finally {
      this.setLoading('checkout', false)
    }
  }

  async openCheckoutForCreditPack(args: {
    planId: string
    successUrl: string
    cancelUrl: string
    quantity?: number
  }): Promise<{ url: string; sessionId: string }> {
    this.setLoading('checkout', true)
    try {
      const session = await this.firestoreService.callFunction<{
        planId: string
        successUrl: string
        cancelUrl: string
        quantity?: number
        checkoutRequestId: string
      }, { url: string; sessionId: string }>('createCheckoutSession', {
        ...args,
        checkoutRequestId: this.createCheckoutRequestId('credit-pack'),
      })
      this.analyticsService.trackEvent('checkout_started', { kind: 'credit-pack', planId: args.planId, quantity: args.quantity })
        .subscribe({ error: () => undefined })
      return session
    } finally {
      this.setLoading('checkout', false)
    }
  }

  async openCheckoutForCustomCredits(args: {
    credits: number
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string; sessionId: string }> {
    this.setLoading('checkout', true)
    try {
      const session = await this.firestoreService.callFunction<{
        planId: string
        customCredits: number
        successUrl: string
        cancelUrl: string
        checkoutRequestId: string
      }, { url: string; sessionId: string }>('createCheckoutSession', {
        planId: 'custom_credits',
        customCredits: args.credits,
        successUrl: args.successUrl,
        cancelUrl: args.cancelUrl,
        checkoutRequestId: this.createCheckoutRequestId('custom-credits'),
      })
      this.analyticsService.trackEvent('checkout_started', { kind: 'custom-credits', credits: args.credits })
        .subscribe({ error: () => undefined })
      return session
    } finally {
      this.setLoading('checkout', false)
    }
  }

  async openBillingPortal(returnUrl: string): Promise<string> {
    this.setLoading('portal', true)
    try {
      const response = await this.firestoreService.callFunction<{ returnUrl: string }, { url: string }>(
        'createBillingPortalSession',
        { returnUrl }
      )
      return response.url
    } finally {
      this.setLoading('portal', false)
    }
  }

  async startTrial(): Promise<{
    billing?: Partial<UserBilling>
    userId?: string
    trialStartedAt?: string
    trialEndsAt?: string
  }> {
    this.setLoading('trial', true)
    try {
      const result = await this.firestoreService.callFunction<void, {
        billing?: Partial<UserBilling>
        userId?: string
        trialStartedAt?: string
        trialEndsAt?: string
      }>('startTrial')
      this.refreshBilling()
      return result
    } finally {
      this.setLoading('trial', false)
    }
  }

  async resumeSubscriptionCancellation(): Promise<{
    billing?: Partial<UserBilling>
    subscriptionId?: string
    cancelAtPeriodEnd?: boolean
  }> {
    this.setLoading('resumeCancellation', true)
    try {
      const result = await this.firestoreService.callFunction<void, {
        billing?: Partial<UserBilling>
        subscriptionId?: string
        cancelAtPeriodEnd?: boolean
      }>('resumeSubscriptionCancellation')
      this.refreshBilling()
      return result
    } finally {
      this.setLoading('resumeCancellation', false)
    }
  }

  async verifyCheckoutSession(sessionId: string): Promise<{
    valid: boolean
    mode: string | null
    paymentStatus: string | null
    status: string | null
    sessionId: string
  }> {
    return this.firestoreService.callFunction<{ sessionId: string }, {
      valid: boolean
      mode: string | null
      paymentStatus: string | null
      status: string | null
      sessionId: string
    }>('verifyCheckoutSession', { sessionId })
  }

  async submitEnterprisePlanRequest(payload: EnterprisePlanRequestPayload): Promise<{ success: boolean }> {
    return this.firestoreService.callFunction<EnterprisePlanRequestPayload, { success: boolean }>(
      'submitEnterprisePlanRequest',
      payload
    )
  }

  async getUsageReport(args: BillingUsageRequest): Promise<BillingUsageResponse> {
    this.setLoading('usageReport', true)
    try {
      return this.firestoreService.callFunction<BillingUsageRequest, BillingUsageResponse>('getBillingUsage', args)
    } finally {
      this.setLoading('usageReport', false)
    }
  }

  async getAdminBillingObservability(args?: {
    incidentLimit?: number
    failedEventLimit?: number
    pendingEventLimit?: number
    pastDueLimit?: number
    includeAcknowledged?: boolean
  }): Promise<{
    generatedAt: string
    incidents: Array<Record<string, unknown>>
    failedEvents: Array<Record<string, unknown>>
    pendingEvents: Array<Record<string, unknown>>
    pastDueAccounts: Array<Record<string, unknown>>
    disputes: Array<Record<string, unknown>>
    retryStats: { totalFailedEvents: number; totalRetries: number; averageRetries: number; oldestUnprocessedEvent: string | null }
    entitlementMetrics: { todayCalls: number }
  }> {
    return this.firestoreService.callFunction<typeof args, {
      generatedAt: string
      incidents: Array<Record<string, unknown>>
      failedEvents: Array<Record<string, unknown>>
      pendingEvents: Array<Record<string, unknown>>
      pastDueAccounts: Array<Record<string, unknown>>
      disputes: Array<Record<string, unknown>>
      retryStats: { totalFailedEvents: number; totalRetries: number; averageRetries: number; oldestUnprocessedEvent: string | null }
      entitlementMetrics: { todayCalls: number }
    }>('getAdminBillingObservability', args)
  }

  async acknowledgeBillingIncident(incidentId: string): Promise<{ ok: boolean; incidentId: string }> {
    return this.firestoreService.callFunction<{ incidentId: string }, { ok: boolean; incidentId: string }>(
      'acknowledgeBillingIncident',
      { incidentId }
    )
  }

  async requestStripeEventRetry(eventId: string): Promise<{ ok: boolean; eventId: string }> {
    return this.firestoreService.callFunction<{ eventId: string }, { ok: boolean; eventId: string }>(
      'requestStripeEventRetry',
      { eventId }
    )
  }

  getPlans$(includeFree = true): Observable<BillingCatalogPayload['plans']> {
    return this.catalog$.pipe(
      map((catalog) => includeFree ? catalog.plans : catalog.plans.filter((plan) => plan.id !== 'free'))
    )
  }

  getCreditPacks$(): Observable<CreditPackCatalog[]> {
    return this.catalog$.pipe(map((catalog) => catalog.creditPacks))
  }

  getCustomCreditsConfig$(): Observable<BillingCatalogPayload['customCredits']> {
    return this.catalog$.pipe(map((catalog) => catalog.customCredits))
  }

  private fetchCatalog(): Observable<BillingCatalogPayload> {
    return from(this.firestoreService.callFunction<void, BillingCatalogPayload>('getBillingCatalog'))
  }

  private mergeWithDefault(data: Partial<UserBilling> | undefined): UserBilling {
    const fallback = this.defaultBilling()
    if (!data) {
      return fallback
    }

    const mergedCredits = {
      ...fallback.credits,
      ...(data.credits || {}),
    }

    if (mergedCredits.purchasedBalance === undefined && data.plan === 'free') {
      mergedCredits.purchasedBalance = Number(mergedCredits.balance || 0)
      mergedCredits.purchasedReserved = Number(mergedCredits.reserved || 0)
    }

    if (mergedCredits.includedBalance === undefined && data.plan && data.plan !== 'free') {
      mergedCredits.includedBalance = Number(mergedCredits.balance || 0)
      mergedCredits.includedReserved = Number(mergedCredits.reserved || 0)
    }

    return {
      ...fallback,
      ...data,
      credits: mergedCredits,
      features: {
        ...fallback.features,
        ...(data.features || {}),
      },
    }
  }

  private defaultBilling(): UserBilling {
    return {
      plan: 'free',
      status: 'inactive',
      subscriptionId: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      graceUntil: null,
      credits: {
        balance: 0,
        reserved: 0,
        purchasedBalance: 0,
        purchasedReserved: 0,
        includedBalance: 0,
        includedReserved: 0,
      },
      features: {},
    }
  }
}
