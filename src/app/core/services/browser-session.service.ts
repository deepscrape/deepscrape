import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import {
  BrowserSessionCreateRequest,
  BrowserSessionListResponse,
  BrowserSessionResponse,
} from '../types/browser-session.interface'
import { ToolEnvelope } from '../types'

/**
 * The one writer of `/api/browser/session*`.
 *
 * Same-origin, like every other `/api` service: `API_BASE_URL` is the
 * relative `/api`, so the request lands on Hosting and the BFF, and the caller's
 * ID token never leaves our origin.
 *
 * There is deliberately NO read method for a CDP URL and no field that could
 * hold one. For `byo` the URL goes out on a create body and is never returned:
 * the server keeps only a Secret Manager path. That mirrors
 * `WebrainConfigService`'s asymmetry, and `BucketStorageService`'s rule for its
 * keys. A `getCdpUrl()` on this class would be the bug, so it does not exist.
 *
 * The token is read from `AuthService.token` at CALL time rather than captured
 * into headers built in the constructor, so a refreshed ID token is used on the
 * next call without rebuilding the service.
 *
 * Every method returns its `Observable` untouched. The service does not retry
 * and does not translate errors, because the two failure axes carry different
 * meanings that a blanket catch here would flatten: 402 is a plan boundary, 403
 * is a permission boundary, and 503 from close means capacity rather than a
 * failure. The UI is where those are told apart, so this layer must not decide.
 */
@Injectable({ providedIn: 'root' })
export class BrowserSessionService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/browser/session'

  /**
   * The URL a live-view frame is read from.
   *
   * Matches roadmap `03` A.2 exactly -- `GET /api/browser/session/:id/frame` ->
   * `image/webp` -- so Part A only has to implement the route, not negotiate the
   * contract with the client.
   *
   * `nonce` is not decoration. A browser will happily re-serve a cached frame, and a
   * live view stuck on one image is worse than one showing none, because it looks
   * live. The BFF sends `no-store`, but a fresh URL per poll also defeats whatever
   * sits in front of it, a service worker included.
   *
   * The frame rate is a SERVER cap and not a parameter: a client-chosen `fps` is a
   * client-chosen bill, which is why nothing here sends one.
   *
   * @param {string} sessionId The session to view.
   * @param {number} nonce A value that changes per poll, so nothing caches it.
   * @return {string} The same-origin frame URL.
   */
  frameUrl(sessionId: string, nonce: number): string {
    return `${this.base}/${encodeURIComponent(sessionId)}/frame?n=${nonce}`
  }

  /**
   * The sessions this caller still holds.
   *
   * `closed` is excluded by the server, so this is the live set and is what a
   * lease list should render.
   */
  list(): Observable<BrowserSessionListResponse> {
    return this.http.get<BrowserSessionListResponse>(this.base, {
      headers: this.headers(),
    })
  }

  /**
   * Open a session.
   *
   * For `dedicated` this provisions a machine and CHARGES the deploy action, so
   * it is not idempotent from the caller's point of view: a duplicate call is a
   * second charge. The machine is named from the session id, and Fly enforces
   * unique names per app, so a retry inside the deploy path cannot
   * double-provision, but two separate calls are two sessions.
   *
   * @param {BrowserSessionCreateRequest} request The mode, kind and optional URL.
   */
  create(
    request: BrowserSessionCreateRequest
  ): Observable<BrowserSessionResponse> {
    // Built field by field rather than spread, so anything the caller parked on
    // its own object cannot ride along to the server by accident. This is the
    // only place a CDP URL is placed on a request.
    const body: BrowserSessionCreateRequest = {
      mode: request.mode,
      kind: request.kind,
    }

    if (request.cdpUrl && request.cdpUrl.trim()) {
      body.cdpUrl = request.cdpUrl.trim()
    }

    return this.http.post<BrowserSessionResponse>(this.base, body, {
      headers: this.headers(),
    })
  }

  /**
   * Record activity, which pushes the idle deadline out.
   *
   * A session that is not kept alive is suspended at its deadline, so a UI that
   * drives a session has to call this while it is being used. The reply carries
   * the new `expiresAt`.
   */
  keepalive(id: string): Observable<BrowserSessionResponse> {
    return this.http.post<BrowserSessionResponse>(
      this.sessionUrl(id) + '/keepalive',
      {},
      { headers: this.headers() }
    )
  }

  /**
   * End a session and release its machine.
   *
   * This also performs the session's FINAL meter charge, so a close is a billed
   * event and not just a teardown. A 502 means the final charge could not be
   * taken and the session was deliberately left open; a retry closes it for
   * real, and repeating this cannot charge twice.
   */
  close(id: string): Observable<BrowserSessionResponse> {
    return this.http.post<BrowserSessionResponse>(
      this.sessionUrl(id) + '/close',
      {},
      { headers: this.headers() }
    )
  }

  /**
   * The credential vault: list entries, build one, or log in from one.
   *
   * The only method here that takes NO session id. The vault belongs to the
   * WORKER rather than to a session -- it is where a `service` + `profile` pair
   * lives, and a session is what replays it -- so it is addressed without one.
   *
   * PAID, and the only 402 a caller can meet on this service. `VAULT_TOOLS`
   * puts these ops behind a paid tier and the vault is process-global on the
   * worker, so a free caller would be reading credentials it does not own. The
   * STATUS is the meaning (402 = upgrade, 502 = the worker was unreachable), so
   * this does not translate the error; the caller decides what a 402 renders.
   * @param {Record<string, unknown>} body `op` plus the fields that op needs.
   * @return {Observable<ToolEnvelope>} The worker's reply, unmodified.
   */
  vault(body: Record<string, unknown>): Observable<ToolEnvelope> {
    return this.http.post<ToolEnvelope>(this.base + '/vault', body, {
      headers: this.headers(),
    })
  }

  /**
   * One session's URL.
   *
   * Encoded, because the id reaches us from the server and a raw segment would
   * let a `/` in an id address a different route.
   */
  private sessionUrl(id: string): string {
    return this.base + '/' + encodeURIComponent(id)
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
    })
  }
}
