import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import {
  WebrainConfig,
  WebrainProxiesRequest,
  WebrainProxiesResponse,
  WebrainProxyEntryInput,
  WebrainTokenRequest,
  WebrainTokenResponse,
} from '../types'

/**
 * The one writer of `/api/webrain/config/*`.
 *
 * Same-origin, like every other `/api` service: `API_BASE_URL` is the
 * relative `/api`, so the request lands on Hosting and the BFF, and the
 * caller's ID token never leaves our origin.
 *
 * The credential handling is deliberately asymmetric, and the asymmetry is the
 * whole design:
 *
 * - `setToken` sends a value the caller supplied and the reply carries none.
 *   There is no method that reads a token back, because the only route that
 *   returns one returns it once, to the request that minted it, and that value
 *   is the caller's to display, not this service's to keep.
 * - `getConfig` reports `hasToken` as a boolean and each proxy as a label plus
 *   a masked host. There is no read model here that could hold a proxy URL.
 *
 * The supplied token is placed straight onto the outgoing body. It is never
 * trimmed into a local, never assigned to a field of this class, never logged,
 * and never included in an error message: the value lives on the caller's stack
 * and in the request, nowhere else. This mirrors `BucketStorageService`'s rule
 * for `accessKey`/`secretKey` and `AiKeysService`'s "NEVER RENDER KEY MATERIAL".
 *
 * Every credential is taken from `AuthService.token` at call time rather than
 * captured into a header built in the constructor, so a refreshed ID token is
 * used on the next call without rebuilding the service.
 */
@Injectable({ providedIn: 'root' })
export class WebrainConfigService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/webrain/config'

  /**
   * The state an operator may see.
   *
   * Never the token, never a proxy URL: the reply has no field for either.
   */
  getConfig(): Observable<WebrainConfig> {
    return this.http.get<WebrainConfig>(this.base, { headers: this.headers() })
  }

  /**
   * Set or mint the MCP bearer token.
   *
   * @param {string} [token] The value to store. Omit it, or pass a blank
   * string, to have the server mint one and return it once.
   * @return {Observable<WebrainTokenResponse>} `generated: true` with the value
   * on the mint reply, `generated: false` when a supplied token was stored.
   */
  setToken(token?: string): Observable<WebrainTokenResponse> {
    const body: WebrainTokenRequest = {}

    // Assigned straight onto the outgoing body: not trimmed into a local, not
    // held on `this`, not echoed anywhere. A blank value is omitted, which is
    // how this method asks the server to mint one.
    if (token && token.trim()) {
      body.token = token
    }

    return this.http.post<WebrainTokenResponse>(this.base + '/token', body, { headers: this.headers() })
  }

  /**
   * Replace the entire proxy pool.
   *
   * Wholesale by contract: the backend has no partial update, because a partial
   * update would need an identity for an entry and an entry's identity is a
   * credential. The replied pool is already masked.
   *
   * @param {WebrainProxyEntryInput[]} proxies The new pool, in order.
   */
  setProxies(proxies: WebrainProxyEntryInput[]): Observable<WebrainProxiesResponse> {
    const body: WebrainProxiesRequest = {
      proxies: proxies.map((entry) => ({ label: entry.label, url: entry.url })),
    }

    return this.http.post<WebrainProxiesResponse>(this.base + '/proxies', body, { headers: this.headers() })
  }

  /**
   * The headers every call carries.
   *
   * `Accept: application/json` is explicit: the BFF streams on some routes and
   * the bridge decides what to do from what the client asked for.
   */
  private headers(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Bearer ${this.authService.token}`,
      'Accept': 'application/json',
    })
  }
}
