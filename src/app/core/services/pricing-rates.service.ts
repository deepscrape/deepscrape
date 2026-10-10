import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import { PricingEstimateResponse, PricingRatesResponse } from '../types/pricing-rates.interface'

/**
 * The one reader of `/api/pricing/rates`.
 *
 * Same-origin, like every other `/api` service: `API_BASE_URL` is the relative
 * `/api`, so the request lands on Hosting and the BFF.
 *
 * Read-only and cached by nothing. There is no local copy of the rates anywhere in
 * this app, and that is the design rather than an oversight: the moment a component
 * holds a number the server also holds, there are two prices and one of them is
 * wrong. The route is cheap (a pure projection, no database read), so re-reading it
 * on every visit costs less than the drift it prevents.
 *
 * The token is read at CALL time rather than captured into headers built in the
 * constructor, so a refreshed ID token is used on the next call.
 */
@Injectable({ providedIn: 'root' })
export class PricingRatesService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/pricing'

  /**
   * The active rates, and the fallback.
   * @return {Observable<PricingRatesResponse>} The price list.
   */
  rates(): Observable<PricingRatesResponse> {
    return this.http.get<PricingRatesResponse>(`${this.base}/rates`, {
      headers: this.headers(),
    })
  }

  /**
   * What the NEXT call costs this caller.
   *
   * `path` is the route the client is about to call (`/api/crawl/stream/job`).
   * Passing the caller's own path rather than the table's internal key is
   * deliberate: the server normalizes the `/api` mount away before matching, so
   * the two spellings resolve to the same rule, and quoting a path the caller does
   * not use is how a price ends up attached to a route nobody calls.
   *
   * Re-read rather than cached, for the same reason `rates()` is: the answer is the
   * server's, and a copy in the client is a second price that can go stale.
   * @param {string} method The HTTP method of the call being priced.
   * @param {string} path The path of the call being priced.
   * @return {Observable<PricingEstimateResponse>} The price, and whether it applies.
   */
  estimate(method: string, path: string): Observable<PricingEstimateResponse> {
    return this.http.get<PricingEstimateResponse>(`${this.base}/estimate`, {
      headers: this.headers(),
      params: { method, path },
    })
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
    })
  }
}
