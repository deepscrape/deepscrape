import { Injectable } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import { SerpEnvelope, SerpRequest } from '../types'

/**
 * The one writer of `POST /api/serp`.
 *
 * The route lives on both hosts behind the same guard (`access` plus
 * `crawl.execute`, not `paid`), so a free caller reaches it and the tier
 * decision is made per tool by the gateway's allowlist rather than here. That
 * is why this service sends the request and reports whatever comes back
 * instead of pre-checking a plan: a second check would be a second place for
 * the two answers to disagree.
 *
 * Same-origin for the same reason as the other playground services — the
 * credential must not leave our origin, and the production CSP permits only our
 * own.
 *
 * The reply is typed as the union `SerpEnvelope`, because the route answers a
 * refusal with 403 and an outage with 502; those arrive as `HttpErrorResponse`
 * bodies, where an open call would otherwise read `data` off an error payload.
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly endpoint: string = API_BASE_URL + '/serp'

  constructor(private http: HttpClient, private authService: AuthService) {}

  /**
   * One structured search.
   *
   * `region` is omitted rather than sent empty when the caller typed nothing:
   * the route's `nonEmptyString` guard would drop `""` anyway, and sending it
   * makes the request body read as if a region had been chosen. `limit` and
   * `page` are always sent, because they are a deliberate choice from a form
   * that shows the current value.
   */
  search(request: SerpRequest): Observable<SerpEnvelope> {
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${this.authService.token}`,
      'Accept': 'application/json',
    })

    const body: SerpRequest = {
      query: request.query,
      engine: request.engine,
      limit: request.limit,
      page: request.page,
      safe: request.safe,
    }

    const region = request.region?.trim()
    if (region) {
      body.region = region
    }

    // Forwarded only when the caller actually chose it, so "not chosen" reaches
    // the worker as absent and its browserless default applies. Sending an
    // explicit `false` would look like a decision nobody made, and `false` is
    // not the same statement as "unspecified" the moment the worker's default
    // changes.
    if (typeof request.browser === 'boolean') {
      body.browser = request.browser
    }

    return this.http.post<SerpEnvelope>(this.endpoint, body, { headers })
  }
}
