import { Injectable } from '@angular/core';
import { Resolve } from '@angular/router';
import { AuthService, OrganizationService } from 'src/app/core/services';
import { catchError, filter, map, Observable, of, switchMap, tap } from 'rxjs';
import { Users } from '../types';
import { UserInfo } from '@angular/fire/auth';
import { combineLatest } from 'rxjs/internal/observable/combineLatest';

@Injectable({ providedIn: 'root' })
export class UserResolver implements Resolve<Users & { currProviderData: UserInfo | null } | null> {
  constructor(
    private authService: AuthService,
    private organizationService: OrganizationService,
  ) {}

  /**
   * `listMyOrganizations()` here is a warm-up — its result is discarded (see
   * `map(() => user)`). Resolvers run on every route transition, so 8 callers were
   * re-reading the org list from Firestore per navigation. Only the *response* is
   * unused, not the fact that it ran, so a uid-keyed TTL is the whole fix.
   */
  private warmedForUid: string | null = null
  private warmedAt = 0
  private static readonly WARM_TTL_MS = 5 * 60 * 1000

  resolve(): Observable<Users & { currProviderData: UserInfo | null } | null> {
    return combineLatest([
      this.authService.isAuthStateResolved, // Wait for auth state to be resolved
      this.authService.user$
    ]).pipe(
      filter(([isResolved]) => isResolved), // Ensure auth state is resolved
      map(([, user]) => user),
      switchMap((user) => {
        if (!user?.uid) {
          return of(user)
        }

        const warmed = this.warmedForUid === user.uid
          && Date.now() - this.warmedAt < UserResolver.WARM_TTL_MS
        if (warmed) {
          return of(user)
        }

        return this.organizationService.listMyOrganizations().pipe(
          tap(() => {
            this.warmedForUid = user.uid
            this.warmedAt = Date.now()
          }),
          map(() => user),
          catchError(() => of(user)),
        )
      }),
    )
  }
}