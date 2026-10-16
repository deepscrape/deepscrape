import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import type {
  EgressSettings,
  EgressWrite,
} from '../types/webrain-config.interface'

/**
 * A caller's OWN egress proxies, at `users/{uid}/egress/settings`.
 *
 * The one client of `GET`/`PUT /api/egress`, which is the per-caller
 * counterpart of the admin-only platform pool: this one moves only the caller's
 * own traffic, so the routes derive the document from the VERIFIED token and
 * there is no id to pass and none to get wrong.
 *
 * Nothing is memoised here on purpose. The reply IS the state the caller just
 * changed, so a cached copy would be the single thing most likely to be stale --
 * and the difference it would hide (your own exits versus ours) is the whole
 * point of the surface.
 *
 * The stored URLs are never returned by either route. Saving replaces the pool,
 * so a caller changing one exit re-enters all of them; that is the cost of never
 * echoing a password back into a document that is backed up and rule-readable.
 */
@Injectable({ providedIn: 'root' })
export class EgressService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/egress'

  /**
   * The caller's own exits, masked.
   * @return {Observable<EgressSettings>} The mode in force and the masked exits.
   */
  get(): Observable<EgressSettings> {
    return this.http.get<EgressSettings>(this.base, {
      headers: this.headers(),
    })
  }

  /**
   * Replace the caller's exits, or clear them.
   * @param {EgressWrite} write `{mode:'byo', proxies:[url]}`, or `{mode:'platform'}`.
   * @return {Observable<EgressSettings>} The state after the write.
   */
  set(write: EgressWrite): Observable<EgressSettings> {
    return this.http.put<EgressSettings>(this.base, write, {
      headers: this.headers(),
    })
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
    })
  }
}
