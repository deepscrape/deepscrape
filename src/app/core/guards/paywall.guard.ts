import { inject } from '@angular/core'
import { CanActivateFn, Router } from '@angular/router'
import { BillingService } from '../services'
import { map } from 'rxjs/operators'

export const paywallGuard: CanActivateFn = (_route, state) => {
  const billingService = inject(BillingService)
  const router = inject(Router)

  return billingService.canAccessPaidFeatures$().pipe(
    // A UrlTree, NOT `navigate()` + `false`. Cancelling and starting a second
    // navigation from inside the guard is what produced the classic "click
    // Machines, nothing happens": the queued redirect was dropped when the two
    // navigations overlapped. Returning the tree lets the router run one navigation.
    map((allowed) =>
      allowed
        ? true
        : router.createUrlTree(['/billing/plans'], {
            queryParams: {
              reason: 'upgrade_required',
              returnUrl: state.url,
            },
          }),
    )
  )
}
