import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import type {
  ComputeSettings,
  ComputeWrite,
} from '../types/webrain-config.interface'

/**
 * A caller's OWN Fly organization, at `users/{uid}/compute/settings`.
 *
 * The one client of `GET`/`PUT /api/compute`, and the per-caller counterpart of
 * the platform's own machines: this one moves only the caller's OWN compute, so
 * the routes derive the document from the VERIFIED token and there is no id to
 * pass and none to get wrong.
 *
 * Nothing is memoised here on purpose, for the reason `EgressService` gives. The
 * reply IS the state the caller just changed, so a cached copy is the single
 * thing most likely to be stale -- and the difference it would hide (their Fly
 * organization versus ours, and therefore who pays) is the whole point.
 *
 * The token is never returned by either route. Saving REPLACES it, so a caller
 * changing the app re-enters the token; that is the cost of never echoing a
 * credential that can create and destroy machines.
 */
@Injectable({ providedIn: 'root' })
export class ComputeService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/compute'

  /**
   * The caller's own Fly configuration, credentialless.
   * @return {Observable<ComputeSettings>} The organization in force and the app.
   */
  get(): Observable<ComputeSettings> {
    return this.http.get<ComputeSettings>(this.base, {
      headers: this.headers(),
    })
  }

  /**
   * Replace the caller's Fly configuration, or clear it.
   * @param {ComputeWrite} write `{mode:'byo', app, token, region}`, or `{mode:'platform'}`.
   * @return {Observable<ComputeSettings>} The state after the write.
   */
  set(write: ComputeWrite): Observable<ComputeSettings> {
    return this.http.put<ComputeSettings>(this.base, write, {
      headers: this.headers(),
    })
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
    })
  }
}
