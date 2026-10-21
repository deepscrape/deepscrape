import { TestBed } from '@angular/core/testing'
import { CanActivateFn, Router } from '@angular/router'
import { firstValueFrom, isObservable, of } from 'rxjs'
import { BillingService } from '../services'
import { paywallGuard } from './paywall.guard'
import { getTestProviders } from 'src/app/testing';

describe('paywallGuard', () => {
  let billingServiceMock: jasmine.SpyObj<Pick<BillingService, 'canAccessPaidFeatures$'>>
  let routerMock: jasmine.SpyObj<Pick<Router, 'navigate' | 'createUrlTree'>>

  const executeGuard: CanActivateFn = (...guardParameters) =>
    TestBed.runInInjectionContext(() => paywallGuard(...guardParameters))

  const resolveGuardResult = async (result: ReturnType<CanActivateFn>): Promise<unknown> => {
    if (isObservable(result)) {
      return firstValueFrom(result)
    }

    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return result
    }

    return result
  }

  beforeEach(() => {
    billingServiceMock = jasmine.createSpyObj<Pick<BillingService, 'canAccessPaidFeatures$'>>('BillingService', ['canAccessPaidFeatures$'])
    routerMock = jasmine.createSpyObj<Pick<Router, 'navigate' | 'createUrlTree'>>('Router', ['navigate', 'createUrlTree'])

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: BillingService, useValue: billingServiceMock },
        { provide: Router, useValue: routerMock },
      ],
    })
  })

  it('allows navigation when user can access paid features', async () => {
    billingServiceMock.canAccessPaidFeatures$.and.returnValue(of(true))

    const result = await resolveGuardResult(executeGuard({} as never, { url: '/protected' } as never))

    expect(result).toBeTrue()
    expect(routerMock.navigate).not.toHaveBeenCalled()
  })

  it('redirects to billing plans when user cannot access paid features', async () => {
    billingServiceMock.canAccessPaidFeatures$.and.returnValue(of(false))
    // The guard returns a UrlTree and lets the router run ONE navigation; a
    // `navigate()` call from inside a guard is what dropped the redirect when
    // two navigations overlapped.
    const tree = { redirected: '/billing/plans' } as never
    routerMock.createUrlTree.and.returnValue(tree)

    const result = await resolveGuardResult(executeGuard({} as never, { url: '/protected' } as never))

    expect(result).toBe(tree)
    expect(routerMock.createUrlTree).toHaveBeenCalledWith(['/billing/plans'], {
      queryParams: {
        reason: 'upgrade_required',
        returnUrl: '/protected',
      },
    })
    expect(routerMock.navigate).not.toHaveBeenCalled()
  })
})
