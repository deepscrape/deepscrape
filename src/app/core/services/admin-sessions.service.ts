import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import type {
  BrowserSessionKind,
  BrowserSessionMode,
  BrowserSessionState,
} from '../types/browser-session.interface'

/**
 * One live session, as the platform console may see it.
 *
 * The field TYPES are reused from the tenant-facing session interface rather
 * than re-declared, so a new engine or a new state cannot appear here as a bare
 * `string` that quietly fails to match anywhere. What this adds is what only the
 * console knows: who owns the session, what tier it was leased at, and what it
 * has been billed.
 *
 * `cdpSecretPath` is deliberately absent, mirroring the server's `AdminSession`.
 * The server already refuses to project it, and a client field would only be an
 * invitation to ask for it.
 */
export interface AdminSession {
  uid: string
  id: string
  mode: BrowserSessionMode
  kind: BrowserSessionKind
  state: BrowserSessionState
  /** The tier the lease was decided at. Rendered raw, as the server wrote it. */
  tier: string
  createdAt: number
  lastUsedAt: number
  minutesBilled: number
  /** Absent for a BYO session: there is no platform machine to release. */
  machineId?: string
}

/** The console's reply. `truncated` at the cap, never an error. */
export interface AdminSessionResponse {
  status: string
  sessions: AdminSession[]
  truncated: boolean
}

/**
 * The one reader of `/api/admin/sessions`.
 *
 * Same-origin, like every other `/api` service: `API_BASE_URL` is the relative
 * `/api`, so the request lands on Hosting and the BFF.
 *
 * Read-only, and the class is the reason: there is no `reclaim` here, and adding
 * one would be wrong rather than merely missing. Reclaim moves the idle deadline
 * the Go reaper reads, which suspends a customer's live, still-billing machine —
 * a destructive act on another tenant's money. Roadmap `05` Part D asks for it
 * and it needs sign-off, the same way the fleet's lifecycle actions do.
 *
 * The method returns its `Observable` untouched: the service does not retry and
 * does not translate errors, because the STATUS is the meaning (403 is a
 * permission boundary, 401 means the token is gone, 500 means the read failed
 * outright) and a blanket catch would flatten three remedies into one message.
 */
@Injectable({ providedIn: 'root' })
export class AdminSessionsService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/admin/sessions'

  /**
   * Every live session in the platform.
   *
   * The token is read at CALL time rather than captured into headers built in
   * the constructor, so a refreshed ID token is used on the next call without
   * rebuilding the service.
   * @return {Observable<AdminSessionResponse>} The sessions, and whether capped.
   */
  list(): Observable<AdminSessionResponse> {
    return this.http.get<AdminSessionResponse>(this.base, {
      headers: this.headers(),
    })
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
    })
  }
}
