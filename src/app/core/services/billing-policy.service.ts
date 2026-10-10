import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'

/**
 * The spend-cap policy at `users/{uid}/billing/policy` (roadmap `07` Part C).
 *
 * Every field is optional, and that is the contract rather than laxity: the
 * route MERGES, so a field left out is left alone. `spendCapCredits: 0` is how a
 * cap is cleared, which is why there is no DELETE.
 */
export type SpendPolicy = {
  /** Cap for the period, in CREDITS. `0` or absent means no cap. */
  spendCapCredits?: number
  period?: 'day' | 'month'
  onExhaust?: 'block' | 'degrade'
  dailyFreeCredits?: number
  /** Ascending percentages of the cap at which to alert. */
  alertsAt?: number[]
}

/** Credits accumulated in the current period. */
export type SpendWindow = {
  periodStartMs: number
  spentCredits: number
}

/**
 * The read shape of `GET /api/billing/policy`.
 *
 * `window` is `null` only when the counter read FAILED. That is a different fact
 * from a counter of zero and must not be rendered as one, so a surface shows the
 * spend line only when `window` is present.
 */
export type BillingPolicyResponse = {
  status: string
  policy: SpendPolicy | null
  period: 'day' | 'month'
  window: SpendWindow | null
}

/**
 * The one client of `/api/billing/policy`.
 *
 * Same-origin like every other `/api` service: `API_BASE_URL` is the relative
 * `/api`, so the request lands on Hosting and the BFF. The token is read at CALL
 * time rather than captured into headers built in the constructor, so a
 * refreshed ID token is used on the next call.
 *
 * This exists because the route had no caller at all: the cap was settable by
 * curl and nothing else. That also made the spend-cap EMAIL preference
 * unreachable, since it notified about a limit the customer had no way to set.
 */
@Injectable({ providedIn: 'root' })
export class BillingPolicyService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/billing/policy'

  /**
   * The caller's cap, the period it applies over, and the spend against it.
   * @return {Observable<BillingPolicyResponse>} The policy and its window.
   */
  get(): Observable<BillingPolicyResponse> {
    return this.http.get<BillingPolicyResponse>(this.base, {
      headers: this.headers(),
    })
  }

  /**
   * Merge fields into the caller's policy.
   * @param {SpendPolicy} patch The fields to write.
   * @return {Observable<{ status: string }>} The route's acknowledgement.
   */
  set(patch: SpendPolicy): Observable<{ status: string }> {
    return this.http.put<{ status: string }>(this.base, patch, {
      headers: this.headers(),
    })
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
    })
  }
}
