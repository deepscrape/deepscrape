import { inject } from '@angular/core'
import { CanActivateFn, Router } from '@angular/router'
import { AuthService, SnackbarService } from '../services'
import { resolveSafeReturnUrl } from '../functions'
import { map } from 'rxjs/operators'
import { SnackBarType } from '../components/snackbar/snackbar.component';

// An i18n KEY, not a sentence: `SnackbarComponent` renders it through `translate`.
// This was the literal English string, which meant every unverified user saw it in
// English whatever locale they had chosen.
const VERIFICATION_REQUIRED_MESSAGE = 'VERIFICATION.ACCESS_REQUIRED'

export const LoginGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService)
  const router = inject(Router)
  const snackbarService = inject(SnackbarService)

  return authService.isAuthenticated().pipe(
    map((authData) => {
      const { isAuthenticated, user } = authData

      if (!isAuthenticated || !user) {
        return true
      }

      const provider = user.currProviderData?.providerId || ''
      const isPasswordProvider = provider === 'password'
      const emailOk = !isPasswordProvider || user.emailVerified === true
      const phoneOk = user.phoneVerified !== false
      const isVerified = emailOk && phoneOk
      const safeReturnUrl = resolveSafeReturnUrl(route.queryParams['returnUrl'])

      if (isVerified) {
        return router.parseUrl(safeReturnUrl)
      }

      snackbarService.showSnackbar(VERIFICATION_REQUIRED_MESSAGE, SnackBarType.warning, '', 5000)
      return router.createUrlTree(['/service/verification'], { queryParams: { returnUrl: safeReturnUrl } })
    })
  )
}

export const verifyGuard: CanActivateFn = (route) => {
  const authService = inject(AuthService)
  const router = inject(Router)

  return authService.isAuthenticated().pipe(
    map((authData) => {
      const { isAuthenticated, user } = authData

      if (!isAuthenticated || !user) {
        return router.createUrlTree(['/service/login'])
      }

      const provider = user.currProviderData?.providerId || ''
      const isPasswordProvider = provider === 'password'
      const emailOk = !isPasswordProvider || user.emailVerified === true
      const phoneOk = user.phoneVerified !== false
      const isVerified = emailOk && phoneOk
      const safeReturnUrl = resolveSafeReturnUrl(route.queryParams['returnUrl'])

      if (isVerified) {
        return router.parseUrl(safeReturnUrl)
      }

      return true
    })
  )
}
