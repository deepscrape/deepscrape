import { inject, Injectable } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable, of, throwError } from 'rxjs'
import { catchError, finalize, shareReplay, switchMap, take, tap } from 'rxjs/operators'
import { AnalyticsService } from './analytics.service'
import { AuthService } from './auth.service'
import { AuthzService } from './authz.service'
import { API_ORGANIZATIONS } from '../variables'

export type OrganizationSummary = {
  id: string
  name?: string
  slug?: string
  ownerId?: string
  membership?: {
    role: 'owner' | 'admin' | 'member' | 'viewer'
  }
  /** The org's credit wallet. Zero for an org nobody has funded. */
  wallet?: {
    balance: number
    reserved: number
    available: number
  }
}

type OrganizationListResponse = {
  organizations: OrganizationSummary[]
}

export type OrganizationInvitation = {
  id: string
  orgId: string
  orgName?: string
  email: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  status: 'pending' | 'accepted' | 'revoked'
  invitedBy?: string
  createdAt?: Date | { toDate?: () => Date }
  acceptedBy?: string
  acceptedAt?: Date | { toDate?: () => Date }
}

export type OrganizationMember = {
  id: string
  orgId: string
  userId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

@Injectable({
  providedIn: 'root',
})
export class OrganizationService {
  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private authzService: AuthzService,
  ) {
    // The list cache below lives for the whole tab, so it must die with the identity
    // that filled it — otherwise the next account to sign in here inherits it. Keyed
    // on the uid, not on every emission: `user$` also fires on profile refreshes, and
    // clearing the cache there would defeat it for no benefit.
    this.authService.user$.subscribe((user) => {
      const uid = user?.uid ?? null
      if (uid !== this.cachedUid) {
        this.cachedUid = uid
        this.invalidateOrganizationList()
      }
    })
  }

  private readonly analytics = inject(AnalyticsService)

  /**
   * `listMyOrganizations()` is called by more than one resolver on the same
   * navigation, so one load issued 2-3 `GET /api/orgs` at once. The two layers fail
   * differently: `orgListInFlight` collapses the concurrent calls (the common case —
   * none has landed yet), `orgList` answers a later navigation with no request at all.
   * ponytail: one TTL for the whole list, no per-org freshness. Every mutation that
   * can change the list invalidates it, so lengthen the TTL only if that stays true.
   */
  private static readonly ORG_LIST_TTL_MS = 30_000
  private orgList: { at: number; value: OrganizationListResponse } | null = null
  private orgListInFlight: Observable<OrganizationListResponse> | null = null
  /** Which identity `orgList` belongs to. `undefined` until the first auth emission. */
  private cachedUid: string | null | undefined = undefined

  private invalidateOrganizationList(): void {
    this.orgList = null
    this.orgListInFlight = null
  }

  private applyActiveOrg(response: OrganizationListResponse): void {
    const activeOrgId = this.authzService.activeOrgId
    if (!activeOrgId && response.organizations?.length) {
      this.authzService.setActiveOrgId(response.organizations[0].id)
    }
  }

  private getAuthHeaders(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
      'Content-Type': 'application/json',
    })
  }

  listMyOrganizations(): Observable<OrganizationListResponse> {
    const cached = this.orgList
    if (cached && Date.now() - cached.at < OrganizationService.ORG_LIST_TTL_MS) {
      // Re-apply on the cached path too: `activeOrgId` can be cleared without the
      // list changing, and a cached hit must not skip that normalisation.
      this.applyActiveOrg(cached.value)
      return of(cached.value)
    }

    if (this.orgListInFlight) {
      return this.orgListInFlight
    }

this.orgListInFlight = this.authService.isAuthenticated().pipe(
        // `authService.token` is assigned inside `authSnapshot()`, so a call made
        // during the FIRST navigation — which is exactly when `orgScopeGuard` asks
        // for this list — used to send `Authorization: Bearer undefined` and come
        // back 401. The snapshot is cached and shared, so waiting on it here costs
        // no extra request; `take(1)` keeps a later token refresh from re-fetching.
        take(1),
        switchMap(() => this.http.get<OrganizationListResponse>(API_ORGANIZATIONS, {
          headers: this.getAuthHeaders(),
          withCredentials: true,
        })),
      tap((response) => {
        this.orgList = { at: Date.now(), value: response }
        this.applyActiveOrg(response)
      }),
      catchError((error) => {
        console.error('Failed to fetch organizations:', error)
        return throwError(() => error)
      }),
      finalize(() => {
        this.orgListInFlight = null
      }),
      // refCount: a caller that unsubscribes early must not cancel the request the
      // other subscriber is still waiting on.
      shareReplay({ bufferSize: 1, refCount: true }),
    )

    return this.orgListInFlight
  }

  createOrganization(name: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(
      API_ORGANIZATIONS,
      { name },
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap((response) => {
        this.invalidateOrganizationList()
        this.authzService.setActiveOrgId(response.id)
        this.analytics.trackEvent('org_created', { orgId: response.id })
          .subscribe({ error: () => undefined })
      }),
      catchError((error) => {
        console.error('Failed to create organization:', error)
        return throwError(() => error)
      }),
    )
  }

  renameOrganization(orgId: string, name: string): Observable<void> {
    return this.http.put<void>(
      `${API_ORGANIZATIONS}/${orgId}`,
      { name },
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap(() => this.invalidateOrganizationList()),
      catchError((error) => {
        console.error('Failed to rename organization:', error)
        return throwError(() => error)
      }),
    )
  }

  /**
   * Hand the org to another member.
   *
   * The only exit for an owner: member removal refuses the last owner and deletion
   * refuses an org that still has teammates, so this is what unblocks both.
   */
  transferOwnership(orgId: string, userId: string): Observable<void> {
    return this.http.put<void>(
      `${API_ORGANIZATIONS}/${orgId}/owner`,
      { userId },
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap(() => this.invalidateOrganizationList()),
      catchError((error) => {
        console.error('Failed to transfer organization ownership:', error)
        return throwError(() => error)
      }),
    )
  }

  /**
   * Move credits from the caller's personal wallet into the workspace wallet.
   *
   * Server-keyed: with no client key the handler derives
   * `org-fund:<uid>:<orgId>:<amount>:<minute>`, so a double-click replays instead of
   * debiting twice. A `replayed` result therefore means "already moved", not "failed".
   */
  fundOrganizationFromWallet(
    orgId: string,
    amount: number,
  ): Observable<{
    moved: number
    replayed: boolean
    personalAvailable: number
    organizationAvailable: number
  }> {
    return this.transferOrganizationCredits(orgId, amount, 'toOrg')
  }

  /**
   * Return the workspace balance to the caller's own wallet.
   *
   * The only exit from the `org_has_credits` refusal on delete: the server refuses to
   * destroy a funded wallet, so emptying it has to be possible.
   */
  withdrawOrganizationCredits(
    orgId: string,
    amount: number,
  ): Observable<{
    moved: number
    replayed: boolean
    personalAvailable: number
    organizationAvailable: number
  }> {
    return this.transferOrganizationCredits(orgId, amount, 'fromOrg')
  }

  private transferOrganizationCredits(
    orgId: string,
    amount: number,
    direction: 'toOrg' | 'fromOrg',
  ): Observable<{
    moved: number
    replayed: boolean
    personalAvailable: number
    organizationAvailable: number
  }> {
    return this.http.post<{
      moved: number
      replayed: boolean
      personalAvailable: number
      organizationAvailable: number
    }>(
      `${API_ORGANIZATIONS}/${orgId}/credits/transfer`,
      { amount, direction },
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap(() => this.invalidateOrganizationList()),
      catchError((error) => {
        console.error(`Failed to transfer credits (${direction}):`, error)
        return throwError(() => error)
      }),
    )
  }

  /**
   * Delete the org, its wallet and every grant that belongs to it. Owner only; the
   * server refuses while the wallet still holds credits.
   */
  deleteOrganization(orgId: string): Observable<void> {
    return this.http.delete<void>(
      `${API_ORGANIZATIONS}/${orgId}`,
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap(() => this.invalidateOrganizationList()),
      catchError((error) => {
        console.error('Failed to delete organization:', error)
        return throwError(() => error)
      }),
    )
  }

  createInvitation(orgId: string, email: string, role: 'owner' | 'admin' | 'member' | 'viewer' = 'member'): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(
      `${API_ORGANIZATIONS}/${orgId}/invitations`,
      { email, role },
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      catchError((error) => {
        console.error('Failed to create organization invitation:', error)
        return throwError(() => error)
      }),
    )
  }

  listMembers(orgId: string): Observable<{ members: OrganizationMember[] }> {
    return this.http.get<{ members: OrganizationMember[] }>(
      `${API_ORGANIZATIONS}/${orgId}/members`,
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      catchError((error) => {
        console.error('Failed to list organization members:', error)
        return throwError(() => error)
      }),
    )
  }

  removeMember(orgId: string, userId: string): Observable<void> {
    return this.http.delete<void>(
      `${API_ORGANIZATIONS}/${orgId}/members/${userId}`,
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap(() => this.invalidateOrganizationList()),
      catchError((error) => {
        console.error('Failed to remove organization member:', error)
        return throwError(() => error)
      }),
    )
  }

  listMyInvitations(): Observable<{ invitations: OrganizationInvitation[] }> {
    return this.http.get<{ invitations: OrganizationInvitation[] }>(
      `${API_ORGANIZATIONS}/invitations/me`,
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      catchError((error) => {
        console.error('Failed to fetch organization invitations:', error)
        return throwError(() => error)
      }),
    )
  }

  listOrgInvitations(orgId: string): Observable<{ invitations: OrganizationInvitation[] }> {
    return this.http.get<{ invitations: OrganizationInvitation[] }>(
      `${API_ORGANIZATIONS}/${orgId}/invitations`,
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      catchError((error) => {
        console.error('Failed to fetch org invitations:', error)
        return throwError(() => error)
      }),
    )
  }

  acceptInvitation(invitationId: string): Observable<{ orgId: string; role: string; accepted: true }> {
    return this.http.post<{ orgId: string; role: string; accepted: true }>(
      `${API_ORGANIZATIONS}/invitations/${invitationId}/accept`,
      {},
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap((response) => {
        this.invalidateOrganizationList()
        if (response?.orgId) {
          this.authzService.setActiveOrgId(response.orgId)
          this.analytics.trackEvent('invitation_accepted', { orgId: response.orgId, role: response.role })
            .subscribe({ error: () => undefined })
        }
      }),
      catchError((error) => {
        console.error('Failed to accept organization invitation:', error)
        return throwError(() => error)
      }),
    )
  }

  setActiveOrganization(orgId: string | null): void {
    this.authzService.setActiveOrgId(orgId)
  }

  getActiveOrganization(): string | null {
    return this.authzService.activeOrgId
  }
}
