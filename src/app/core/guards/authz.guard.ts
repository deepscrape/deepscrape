import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { combineLatest, Observable, of } from 'rxjs';
import { catchError } from 'rxjs/internal/operators/catchError';
import { filter } from 'rxjs/internal/operators/filter';
import { take } from 'rxjs/internal/operators/take';
import { map } from 'rxjs/internal/operators/map';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { timeout } from 'rxjs/internal/operators/timeout';
import { AuthService, AuthzService } from '../services';

type AuthzGuardData = {
  resource: 'ai' | 'crawl' | 'machine' | 'billing' | 'organization';
  action: 'execute' | 'read' | 'deploy' | 'update' | 'delete' | 'manage' | 'invite';
};

export const authzGuard: CanActivateFn = (route): Observable<boolean | UrlTree> => {
  const router = inject(Router);
  const authzService = inject(AuthzService);
  const authService = inject(AuthService);

  const authzData = route.data?.['authz'] as AuthzGuardData | undefined;
  if (!authzData?.resource || !authzData?.action) {
    if (typeof ngDevMode !== 'undefined' && ngDevMode) {
      console.warn(`[authzGuard] No authz data on route "${route.routeConfig?.path ?? '?'}". Passing through — add route data.authz to enforce RBAC.`);
    }
    return of(true);
  }

  return combineLatest([authzService.membershipsReady$, authService.user$]).pipe(
    // Waiting on `ready` ALONE could never end after a sign-out: the service keeps
    // readiness false until a user arrives, so the router neither activated nor
    // cancelled and the page sat on a loader indefinitely. A signed-out visitor has
    // nothing to authorize, so the wait ends there too.
    filter(([ready, user]) => ready || !user),
    take(1),
    switchMap(() => authzService.can$(authzData.resource, authzData.action as never)),
    take(1),
    map(allowed => (allowed ? true : router.createUrlTree(['/']))),
    // Last resort: the memberships read has no timeout of its own, and a Firestore
    // call that never settles must not freeze navigation. Deny to '/' — a click
    // retries, an eternal loader does not.
    timeout(5000),
    catchError(() => of(router.createUrlTree(['/']))),
  );
};
