import { Injectable } from '@angular/core'
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import {
  MONITOR_LIMITS,
  MonitorChecksResponse,
  MonitorCreateRequest,
  MonitorCreateResponse,
  MonitorListResponse,
  MonitorOkResponse,
  MonitorUpdateRequest,
} from '../types'

/**
 * The one writer of the `/api/monitor/*` routes.
 *
 * Same-origin, like the other playground services: `API_BASE_URL` is the
 * relative `/api`, so the request lands on Hosting and the BFF, and the
 * caller's ID token never leaves our origin. Building the URL from an absolute
 * agent host here would send the token to a third party and still fail, since
 * the production CSP allows only our own origin.
 *
 * Every method that needs a credential takes it from `AuthService.token` at
 * call time rather than caching it in a header built in the constructor, so a
 * refreshed token is used on the next call without rebuilding the service.
 */
@Injectable({ providedIn: 'root' })
export class MonitorService {
  private readonly endpoint: string = API_BASE_URL + '/monitor'

  constructor(private http: HttpClient, private authService: AuthService) {}

  /**
   * The headers every monitor call carries.
   *
   * `Accept: application/json` is explicit because the BFF streams on some
   * routes and the bridge decides to stream from what the client asked for.
   */
  private get headers(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Bearer ${this.authService.token}`,
      'Accept': 'application/json',
    })
  }

  /** Create a monitor. The reply carries only the new id. */
  create(body: MonitorCreateRequest): Observable<MonitorCreateResponse> {
    return this.http.post<MonitorCreateResponse>(`${this.endpoint}/create`, body, { headers: this.headers })
  }

  /** Every monitor the caller owns. */
  list(): Observable<MonitorListResponse> {
    return this.http.get<MonitorListResponse>(`${this.endpoint}/list`, { headers: this.headers })
  }

  /**
   * Patch one monitor.
   *
   * `body.id` identifies it, so this is a POST rather than a PATCH on a path
   * segment: the route is a single `/update` for every field.
   */
  update(body: MonitorUpdateRequest): Observable<MonitorOkResponse> {
    return this.http.post<MonitorOkResponse>(`${this.endpoint}/update`, body, { headers: this.headers })
  }

  /** Delete a monitor and its history. */
  remove(id: string): Observable<MonitorOkResponse> {
    return this.http.post<MonitorOkResponse>(`${this.endpoint}/delete`, { id }, { headers: this.headers })
  }

  /**
   * A monitor's checks, newest first as the BFF returns them.
   *
   * `limit` is clamped here as well as on the service so a UI that hands over a
   * typed number cannot ask for an unbounded history.
   */
  checks(id: string, limit: number = MONITOR_LIMITS.defaultHistoryLimit): Observable<MonitorChecksResponse> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || 1, 1), MONITOR_LIMITS.maxHistoryLimit)
    const params = new HttpParams().set('id', id).set('limit', String(bounded))
    return this.http.get<MonitorChecksResponse>(`${this.endpoint}/checks`, { headers: this.headers, params })
  }
}
