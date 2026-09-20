import { inject, Injectable } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable, throwError } from 'rxjs'
import { catchError, tap } from 'rxjs/operators'
import { AnalyticsService } from './analytics.service'
import { AuthService } from './auth.service'
import { AuthzService } from './authz.service'
import { API_ORGANIZATIONS } from '../variables'

export type OrganizationSummary = {
  id: string
  name?: string
  slug?: string
  ownerId?: string
  plan?: string
  membership?: {
    role: 'owner' | 'admin' | 'member' | 'viewer'
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
  ) {}

  private readonly analytics = inject(AnalyticsService)

  private getAuthHeaders(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
      'Content-Type': 'application/json',
    })
  }

  listMyOrganizations(): Observable<OrganizationListResponse> {
    return this.http.get<OrganizationListResponse>(API_ORGANIZATIONS, {
      headers: this.getAuthHeaders(),
      withCredentials: true,
    }).pipe(
      tap((response) => {
        const activeOrgId = this.authzService.activeOrgId
        if (!activeOrgId && response.organizations?.length) {
          this.authzService.setActiveOrgId(response.organizations[0].id)
        }
      }),
      catchError((error) => {
        console.error('Failed to fetch organizations:', error)
        return throwError(() => error)
      }),
    )
  }

  createOrganization(name: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(
      API_ORGANIZATIONS,
      { name },
      { headers: this.getAuthHeaders(), withCredentials: true },
    ).pipe(
      tap((response) => {
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
      catchError((error) => {
        console.error('Failed to rename organization:', error)
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
