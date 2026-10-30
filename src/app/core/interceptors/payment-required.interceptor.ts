import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandlerFn,
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http'
import { inject } from '@angular/core'
import { Router } from '@angular/router'
import { Observable, throwError } from 'rxjs'
import { catchError } from 'rxjs/operators'
import { WindowToken } from '../services'

function isApiRequest(req: HttpRequest<unknown>, win: Window): boolean {
  try {
    const url = new URL(req.url, win.location.origin)
    return url.pathname.startsWith('/api')
  } catch {
    return req.url.startsWith('/api')
  }
}

function isPaymentRequired(error: unknown): error is HttpErrorResponse {
  if (!(error instanceof HttpErrorResponse)) {
    return false
  }

  if (error.status === 402) {
    return true
  }

  const bodyError = typeof error.error === 'object' && error.error
    ? String((error.error as { error?: unknown; code?: unknown }).error || (error.error as { code?: unknown }).code || '')
    : ''

  return bodyError.toLowerCase().includes('payment_required')
}

export const paymentRequiredInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const router = inject(Router)
  const win = inject(WindowToken)

  if (!isApiRequest(req, win)) {
    return next(req)
  }

  return next(req).pipe(
    catchError((error: unknown) => {
      if (!isPaymentRequired(error)) {
        return throwError(() => error)
      }

      const currentPath = router.url || '/'
      // Coming back from Stripe Checkout, the browser is redirected the instant the
      // payment succeeds and the webhook that writes the wallet lands a moment
      // later. Any `/api` call in that window 402s, and bouncing a customer who has
      // just paid to "payment required" reads as "your payment failed". Leave them
      // on the page; the caller shows its own state.
      const settlingAfterCheckout = currentPath.includes('checkout=success')
      // A disputed wallet is refused as 402 too, but "buy a plan" is the wrong advice:
      // the balance may be untouched and the block clears when the dispute does.
      const walletOnHold = typeof error.error === 'object' && error.error
        && String((error.error as { code?: unknown }).code || '') === 'wallet_on_hold'
      // A held wallet may be full, so the plans page ("buy something") is the wrong
      // destination; the passes page is where the balance and the reason live. No notice
      // is raised from here on purpose: this chain runs on the translation loader's own
      // request, and asking for a translated string inside it deadlocks the app.
      if (walletOnHold && !currentPath.startsWith('/billing')) {
        void router.navigate(['/billing/passes'])
        return throwError(() => error)
      }
      if (!settlingAfterCheckout && !currentPath.startsWith('/billing')) {
        void router.navigate(['/billing/plans'], {
          queryParams: {
            reason: 'payment_required',
            returnUrl: currentPath,
          },
        })
      }

      return throwError(() => error)
    }),
  )
}
