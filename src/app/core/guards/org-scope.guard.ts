import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlSegment, UrlTree } from '@angular/router';
import { of } from 'rxjs/internal/observable/of';
import { catchError } from 'rxjs/internal/operators/catchError';
import { map } from 'rxjs/internal/operators/map';
import { AuthzService, OrganizationService } from '../services';
import { isAppPageSegment, ORG_ROOT_SEGMENT } from './host-routing.policy';

/**
 * Is the signed-in user a member of `orgId`?
 *
 * Pure so the spec can pin it. The org id arrives in the URL, which the user controls, so
 * membership is checked against the server's own list and never taken on trust — the
 * server re-checks it on every call anyway (`functions/src/domain/authz.domain.ts`).
 */
export function isMemberOf(
    organizations: readonly { id: string }[],
    orgId: string | null,
): boolean {
    return !!orgId && organizations.some(organization => organization.id === orgId);
}

/**
 * The caller's URL re-homed under `/<orgId>`, query string and all.
 *
 * `dashboard` is dropped rather than nested, because the org root IS the dashboard: a bare
 * `/dashboard` becomes `/{orgId}`, not `/{orgId}/dashboard`.
 */
function scoped(router: Router, orgId: string, url: string, requested: string | null): UrlTree {
    const tree = router.parseUrl(url);
    const primary = tree.root.children['primary'];
    if (!primary) {
        return router.createUrlTree([`/${orgId}`]);
    }

    // The org root IS the dashboard, so a leading `dashboard` segment is dropped rather than
    // nested — `/dashboard` becomes `/{orgId}`, not `/{orgId}/dashboard`. Keyed off the URL
    // rather than off the `orgId` param: that param is null or unrelated whenever we arrive via
    // the membership path, and that is exactly when a bare `/dashboard` shows up.
    if (primary.segments[0]?.path === ORG_ROOT_SEGMENT) {
        primary.segments.shift();
    }

    primary.segments.unshift(new UrlSegment(orgId, {}));
    return tree;
}

/**
 * Guard for the org-scoped app shell `/{orgId}/…`.
 *
 * It does two jobs, because the `:orgId` route also swallows any bare single-segment path:
 *
 * 1. A real org in the URL is adopted — but only after membership is confirmed against the
 *    server's list, since the segment is user-controlled.
 * 2. Anything else is a bare legacy app path (`/dashboard`, `/billing`) that the router
 *    could not hand to the demoted legacy tree. It is rewritten to the caller's own org,
 *    which is what canonicalises old bookmarks onto `/{orgId}/…`.
 */
export const orgScopeGuard: CanActivateFn = (route, state) => {
    const organizations = inject(OrganizationService);
    const authz = inject(AuthzService);
    const router = inject(Router);

    const requested = route.paramMap.get('orgId');

    // Fast path: the URL already names the active org, so skip the membership round-trip.
    if (requested && authz.activeOrgId === requested) {
        return true;
    }

    // The fast path that matters for old links. A segment naming an app page — or the org root,
    // which the `:orgId` route swallows too — cannot be an org id, so this is a bare legacy path
    // (`/dashboard`, `/billing`) — re-home it with the org already in hand. Without this every
    // legacy link cost a `listMyOrganizations` API call before it could render, which is why the
    // remaining bare link sites are cosmetic rather than a bug.
    //
    // The root segment has to be named explicitly: `dashboard` is deliberately NOT in
    // `ORG_APP_PAGES` (it is the org ROOT, so `scoped()` drops it instead of nesting it). Without
    // this a bare `/dashboard` missed the fast path entirely, fell through to the membership
    // lookup, and — because nobody subscribes to that cold observable on the sync path — could
    // land on `/{orgId}/dashboard` instead of `/{orgId}`.
    if (requested && (isAppPageSegment(requested) || requested === ORG_ROOT_SEGMENT) && authz.activeOrgId) {
        return scoped(router, authz.activeOrgId, state.url, requested);
    }

    return organizations.listMyOrganizations().pipe(
        map((response) => {
            const list = response.organizations ?? [];

            if (isMemberOf(list, requested)) {
                authz.setActiveOrgId(requested);
                return true;
            }

            const own = authz.activeOrgId ?? list[0]?.id ?? null;
            return own ? scoped(router, own, state.url, requested) : router.createUrlTree(['/']);
        }),
        catchError(() => {
            const own = authz.activeOrgId;
            return of(own ? scoped(router, own, state.url, requested) : router.createUrlTree(['/']));
        }),
    );
};
