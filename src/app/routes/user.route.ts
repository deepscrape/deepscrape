import { Routes } from '@angular/router';
// import { AuthGuard, redirectUnauthorizedTo } from '@angular/fire/auth-guard';
import { adminGuard, authGuard, orgScopeGuard } from '../core/guards';
import { UserResolver } from '../core/services';



// Define where to redirect unauthorized users
// const redirectUnauthorizedToLogin = () => redirectUnauthorizedTo(['/service/login'])

/** The app shell. Shared by all three trees; `loadChildren` differs per tree. */
const shell = {
    loadComponent: () => import('../layout/full').then(c => c.AppUserLayoutComponent),
    data: { title: 'user', animation: 'user' }, // Apply the redirection
    resolve: { user: UserResolver },
};

export const UserRoutes: Routes = [
    {
        // The console. Declared first and explicitly, because `:orgId` below would
        // otherwise read `/admin` as an org literally named "admin" and move it off the
        // console origin entirely.
        path: 'admin',
        loadComponent: () => import('../layout/full').then(c => c.AppUserLayoutComponent),
        loadChildren: () => import('./user/admin.route').then(m => m.AdminRoutes),
        canActivate: [authGuard, adminGuard],
        data: { title: 'Admin', animation: 'admin' },
        resolve: { user: UserResolver },
    },
    {
        // Canonical org-scoped shell: the org root is the dashboard, and every other page
        // hangs off it — `/{orgId}`, `/{orgId}/billing`, `/{orgId}/billing/plans`.
        path: ':orgId',
        ...shell,
        loadChildren: () => import('./user/main.route').then(m => m.OrgRoutes),
        canActivate: [authGuard, orgScopeGuard],
    },
    {
        // Bare paths, unchanged: `/billing/plans/starter`, `/operations`, … . Deeper legacy
        // URLs still resolve here, because `:orgId` cannot match past its first segment and
        // the router falls through. Keeps bookmarks, emailed links and prerendered
        // `/service/**` working while links migrate to the org-scoped form.
        path: '',
        ...shell,
        loadChildren: () => import('./user/main.route').then(m => m.MainRoutes),
        canActivate: [authGuard],
    },
]