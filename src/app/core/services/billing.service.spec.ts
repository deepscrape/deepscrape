import { TestBed } from '@angular/core/testing'
import { User } from '@angular/fire/auth'
import { firstValueFrom, of, Subject } from 'rxjs'
import { BillingService } from './billing.service'
import { FirestoreService } from './firestore.service'
import { AuthService } from './auth.service'
import { AuthzService } from './authz.service'
import { SessionStorage } from './storage.service'
import { getTestProviders } from 'src/app/testing';

describe('BillingService', () => {
  let service: BillingService
  let firestoreServiceMock: jasmine.SpyObj<Pick<FirestoreService, 'authState' | 'callFunction'>>
  let authServiceMock: Pick<AuthService, 'user$' | 'isAdmin'>
  let entitlementsBilling: Record<string, unknown> | undefined

  const setAuthenticatedBilling = (billing: Record<string, unknown>) => {
    entitlementsBilling = billing
    firestoreServiceMock.authState.and.returnValue(of({ uid: 'user_1' } as User))
  }

  beforeEach(() => {
    entitlementsBilling = undefined
    firestoreServiceMock = jasmine.createSpyObj<Pick<FirestoreService, 'authState' | 'callFunction'>>(
      'FirestoreService',
      ['authState', 'callFunction'],
    )

    firestoreServiceMock.callFunction.and.callFake((
      ((name: string) => {
        if (name === 'getMyEntitlements') {
          return Promise.resolve({ billing: entitlementsBilling })
        }

        if (name === 'getBillingCatalog') {
          return Promise.resolve({ plans: [], creditPacks: [], customCredits: {} })
        }

        return Promise.resolve({})
      }) as unknown as FirestoreService['callFunction']
    ))

    firestoreServiceMock.authState.and.returnValue(of(null))
    authServiceMock = {
      user$: of(null),
      isAdmin: false,
    }

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        BillingService,
        { provide: FirestoreService, useValue: firestoreServiceMock },
        { provide: AuthService, useValue: authServiceMock },
      ],
    })
  })

  it('returns free access mode when user is not authenticated', async () => {
    firestoreServiceMock.authState.and.returnValue(of(null))
    service = TestBed.inject(BillingService)

    const mode = await firstValueFrom(service.getAccessMode$())
    const canAccess = await firstValueFrom(service.canAccessPaidFeatures$())

    expect(mode).toBe('free')
    expect(canAccess).toBeFalse()
  })

  it('returns plan access mode for paid plans', async () => {
    setAuthenticatedBilling({
      plan: 'pro',
      features: {},
      credits: { balance: 0, reserved: 0 },
    })

    service = TestBed.inject(BillingService)

    const mode = await firstValueFrom(service.getAccessMode$())

    expect(mode).toBe('plan')
  })

  it('returns credits access mode for free users with purchased credits', async () => {
    setAuthenticatedBilling({
      plan: 'free',
      subscriptionId: null,
      credits: {
        purchasedBalance: 15,
        purchasedReserved: 5,
      },
      features: {},
    })

    service = TestBed.inject(BillingService)

    const mode = await firstValueFrom(service.getAccessMode$())
    const purchasedCredits = await firstValueFrom(service.getPurchasedCredits$())
    const canAccess = await firstValueFrom(service.canAccessPaidFeatures$())

    expect(mode).toBe('credits')
    expect(purchasedCredits).toBe(10)
    expect(canAccess).toBeTrue()
  })

  it('canPurchaseCredits$ is true for free plan without subscription', async () => {
    setAuthenticatedBilling({
      plan: 'free',
      subscriptionId: null,
      credits: { purchasedBalance: 0, purchasedReserved: 0 },
      features: {},
    })

    service = TestBed.inject(BillingService)

    const canPurchase = await firstValueFrom(service.canPurchaseCredits$())
    expect(canPurchase).toBeTrue()
  })

  it('canPurchaseCredits$ is false when free plan has an active subscription', async () => {
    setAuthenticatedBilling({
      plan: 'free',
      subscriptionId: 'sub_123',
      credits: { purchasedBalance: 0, purchasedReserved: 0 },
      features: {},
    })

    service = TestBed.inject(BillingService)

    const cannotPurchase = await firstValueFrom(service.canPurchaseCredits$())
    expect(cannotPurchase).toBeFalse()
  })

  it('hasFeature$ reflects feature flags from billing payload', async () => {
    setAuthenticatedBilling({
      plan: 'starter',
      credits: { includedBalance: 100, includedReserved: 0 },
      features: { api_access: true },
    })

    service = TestBed.inject(BillingService)

    const enabled = await firstValueFrom(service.hasFeature$('api_access'))
    const disabled = await firstValueFrom(service.hasFeature$('missing_feature'))

    expect(enabled).toBeTrue()
    expect(disabled).toBeFalse()
  })

  it('bypasses paywall checks for platform admins on free billing', async () => {
    setAuthenticatedBilling({
      plan: 'free',
      subscriptionId: null,
      credits: { purchasedBalance: 0, purchasedReserved: 0 },
      features: {},
    })

    authServiceMock.isAdmin = true
    service = TestBed.inject(BillingService)

    const canAccess = await firstValueFrom(service.canAccessPaidFeatures$())
    const hasFeature = await firstValueFrom(service.hasFeature$('anti_bot'))

    expect(canAccess).toBeTrue()
    expect(hasFeature).toBeTrue()
  })

  /**
   * The API charges whichever wallet `resolveSpend` picks, so the client has to ask
   * about the SAME wallet. Before this, a member of a funded workspace was told
   * "free" and paywalled by `paywallGuard` while the server debited the workspace.
   */
  it('asks about the active workspace and caches per wallet', async () => {
    setAuthenticatedBilling({
      plan: 'free',
      subscriptionId: null,
      credits: { purchasedBalance: 40, purchasedReserved: 0 },
      features: {},
    })

    const orgId$ = new Subject<string | null>()
    TestBed.overrideProvider(AuthzService, {
      useValue: { activeOrgId$: orgId$.asObservable(), activeOrgId: null },
    })

    // The shared test providers give SessionStorage a no-op stub, so the cache in
    // `CacheService` never stores anything and a cache assertion would prove nothing.
    const stored = new Map<string, string>()
    TestBed.overrideProvider(SessionStorage, {
      useValue: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    })

    service = TestBed.inject(BillingService)

    // A live subscription is required: `billing$` is shared with refCount, so an
    // emission that arrives while nobody is listening would never be replayed.
    const modes: string[] = []
    const subscription = service.getAccessMode$().subscribe((mode) => modes.push(mode))

    const flush = () => new Promise((resolve) => setTimeout(resolve))
    orgId$.next('org_1')
    await flush()
    // Same workspace again: this must be served from the per-wallet cache.
    orgId$.next('org_1')
    await flush()
    // A different workspace is a different wallet, so it must be fetched again.
    orgId$.next('org_2')
    await flush()

    subscription.unsubscribe()

    const entitlementCalls = firestoreServiceMock.callFunction.calls
      .allArgs()
      .filter((args) => args[0] === 'getMyEntitlements')

    expect(entitlementCalls.length).toBe(2)
    expect(entitlementCalls[0][1]).toEqual({ orgId: 'org_1' })
    expect(entitlementCalls[1][1]).toEqual({ orgId: 'org_2' })
    expect(modes[modes.length - 1]).toBe('credits')
  })
})
