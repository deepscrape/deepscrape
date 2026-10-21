import { Injectable, inject } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { TranslateService } from '@ngx-translate/core'

import { SnackBarType } from '../components/snackbar/snackbar.component'
import { AuthService } from './auth.service'
import { SnackbarService } from './snackbar.service'

/** Warn once this far ahead of the server's expiry. */
const WARN_BEFORE_MS = 5 * 60 * 1000

/** `setTimeout` fires immediately above this, so a 30-day wait has to be chained. */
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Counts down to the session expiry the SERVER reports.
 *
 * The previous version derived 30 days from its own construction — page load, not the
 * session — so it named a date that was not the expiry, and at that date it only showed
 * a toast. `createLoginSession` stamps `expiresAt` on the session record and
 * `getMyLoginSessionStatus` returns it, so `AuthService.sessionExpiresAt$` carries the
 * real value. At expiry this calls `onSessionRevoked()`, the same path a revoked 401
 * takes, so the user is actually signed out instead of being warned about a deadline
 * that then passes with the session still live.
 */
@Injectable({
  providedIn: 'root'
})
export class SessionTimeoutService {
  private readonly auth = inject(AuthService)
  private readonly snackbar = inject(SnackbarService)
  private readonly translate = inject(TranslateService)

  private expiresAtMs: number | null = null
  private warned = false
  private timer?: ReturnType<typeof setTimeout>

  constructor() {
    this.auth.sessionExpiresAt$
      .pipe(takeUntilDestroyed())
      .subscribe((expiresAtMs) => this.schedule(expiresAtMs))
  }

  /**
   * (Re)arm from the reported expiry. Re-arming clears the warning so a renewed
   * session can warn again.
   * @param {number | null} expiresAtMs Epoch ms, or null while unknown.
   */
  private schedule(expiresAtMs: number | null): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.expiresAtMs = expiresAtMs
    this.warned = false
    this.arm()
  }

  /** Sleep until the next thing to do: the warning, or the expiry itself. */
  private arm(): void {
    if (!this.expiresAtMs) {
      return
    }
    const remaining = this.expiresAtMs - Date.now()

    if (remaining <= 0) {
      // The server already treats the session as dead at `expiresAt`
      // (`cleanupExpiredSessions`), so this is the outcome the next 401 would
      // produce anyway — announced rather than discovered.
      this.auth.onSessionRevoked()
      return
    }

    if (!this.warned && remaining <= WARN_BEFORE_MS) {
      this.warned = true
      this.snackbar.showSnackbar(
        this.translate.instant('SESSION_TIMEOUT.WARNING', {
          minutes: Math.max(1, Math.ceil(remaining / 60_000)),
        }),
        SnackBarType.warning,
      )
    }

    // Chained rather than one long timer: anything past ~24.8 days exceeds the
    // setTimeout ceiling and would fire at once, which is the opposite of waiting.
    const delay = remaining <= WARN_BEFORE_MS ?
      remaining :
      remaining - WARN_BEFORE_MS
    this.timer = setTimeout(() => this.arm(), Math.min(delay, MAX_TIMEOUT_MS))
  }
}

