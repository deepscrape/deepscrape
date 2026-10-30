import { Route, Routes } from '@angular/router';
import { provideMarkdown } from 'ngx-markdown';
import { UserResolver } from 'src/app/core/services';
import { paywallGuard } from 'src/app/core/guards';
import { authzGuard } from 'src/app/core/guards';

/**
 * The dashboard. Declared once because it is mounted at two different paths: bare
 * `/dashboard` on the legacy tree, and the org ROOT `/{orgId}` on the canonical one.
 */
const dashboardRoute: Route = {
    path: 'dashboard',
    loadComponent: () => import('../../pages/user/dashboard/dashboard.component').then(m => m.DashboardComponent),
    canActivate: [authzGuard],
    data: {
        title: 'Dashboard',
        animation: 'dashboard',
        authz: { resource: 'crawl', action: 'read' },
    },
};

/** Every other app page. Shared verbatim by both trees. */
const appPageRoutes: Routes = [
    {
        path: 'playground',
        loadComponent: () => import('../../pages/user/playground/playground.component').then(m => m.PlaygroundComponent),
        canActivate: [authzGuard],
        providers: [provideMarkdown()],
        data: {
            title: 'Playground',
            animation: 'playground',
            authz: { resource: 'ai', action: 'execute' },
        },
    },
    {
        path: 'chatai',
        loadComponent: () => import('../../pages/user/chatai/chatai.component').then(m => m.ChataiComponent),
        canActivate: [authzGuard],
        // Renders streamed model output, which is markdown.
        providers: [provideMarkdown()],
        data: {
            title: 'AI Chat',
            animation: 'chatai',
            authz: { resource: 'ai', action: 'execute' },
        },
    },
    {
        // FROZEN: the crawl-pack editor is a `crawl4ai` artefact.
        //
        // Every control on that page writes `CrawlerRunConfig` / `BrowserConfig`
        // fields, and the platform now resolves scrape requests to `webrain`,
        // which accepts neither. The page therefore collected settings that were
        // silently discarded when the job ran -- the worst possible answer,
        // because it looked like configuration.
        //
        // Redirected rather than deleted: the URL keeps working, and the feature
        // can return once webrain has an equivalent pack schema. The component
        // and `crawlpack.route.ts` are still on disk and now unreferenced, so
        // restoring it is putting this block back.
        //
        // The redirect target is RELATIVE on purpose. `appPageRoutes` is mounted
        // in both the plain tree and the `/{orgId}` tree, so an absolute
        // `/playground` would drop the org prefix for every org-scoped user.
        path: 'crawlpack',
        redirectTo: 'playground',
        pathMatch: 'full',
    },
    {
        // `authzGuard` alone, NOT `paywallGuard` -- the same reasoning the
        // browser-session routes below spell out, applied to the run RECORD
        // instead of the session.
        //
        // This page READS the caller's own history and, on the form at its top,
        // ENQUEUES a crawl. Those are two different rights and only the second is
        // paid. The BFF registers what this page reads with `access`:
        // `GET /api/job/:taskId/result` is uid-scoped by the handler's own path
        // (`users/{uid}/crawljobs/{id}`), and `POST /api/job/tool` is `access`
        // because `decideWebrainTool` makes the tier call per tool. So a free
        // caller may queue `webrain_serp` from the playground and finish it as a
        // row here -- and this guard used to bounce them to the pricing page
        // when they came back to look at it. A 402 in front of a read is stricter
        // than the server that serves it, and it hid free work from the user who
        // created it.
        //
        // The RUN FORM is still gated: `OPERATIONS_REQUIREMENT` in
        // `feature-gate.policy.ts` (paid + `crawl.execute`) renders the gate panel
        // and disables the button, so nothing on this page can spend money that
        // the route forgot to check.
        path: 'operations',
        loadComponent: () => import('../../pages/user/operations/operations.component').then(m => m.OperationsComponent),
        resolve: { user: UserResolver },
        canActivate: [authzGuard],
        data: {
            title: 'Operations',
            animation: 'operations',
            authz: { resource: 'crawl', action: 'read' },
        },
    },
    {
        // One operation, in full. The SAME guard as the list, because it reads
        // the same document: a caller who may not see the list may not see a row.
        //
        // `operations/:id` is a sibling and not a child of the route above, so
        // the list is not re-created behind the detail page -- and the row leads
        // here by pushing its own id onto the current url, which keeps the
        // `/{orgId}` prefix the page was reached with.
        //
        // `crawl.read` and not `crawl.execute`: reading one run is not running
        // one. A `viewer` in an org holds `read`, so they can now open the run
        // they can already list -- and the page's own actions (cancel, reschedule)
        // refuse themselves from the same capability.
        path: 'operations/:id',
        loadComponent: () => import('../../pages/user/operations/operation-detail/operation-detail.component').then(m => m.OperationDetailComponent),
        resolve: { user: UserResolver },
        canActivate: [authzGuard],
        data: {
            title: 'Operation',
            animation: 'operations',
            authz: { resource: 'crawl', action: 'read' },
        },
    },
    {
        // The full alert list. `account.read`, not `crawl.read`: the feed is the
        // caller's OWN alerts (`users/{uid}/alerts`, plus security notices), so
        // the capability is the self-scoped one and an org viewer who cannot
        // crawl can still read their own notices.
        //
        // Reachable as `/alerts` and as `/{orgId}/alerts`, because
        // `appPageRoutes` is mounted in both trees.
        path: 'alerts',
        loadComponent: () => import('../../pages/user/alerts/alerts.component').then(m => m.AlertsPageComponent),
        resolve: { user: UserResolver },
        canActivate: [authzGuard],
        data: {
            title: 'Alerts',
            animation: 'alerts',
            authz: { resource: 'account', action: 'read' },
        },
    },
    {
        // The browser-session lease list. Deliberately NOT `crawlpack/browser`,
        // which already exists and configures the crawl engine's browser rather
        // than leasing one. Reachable as `/browser` and as `/{orgId}/browser`,
        // because `appPageRoutes` is mounted in both trees.
        path: 'browser',
        loadComponent: () => import('../../pages/user/browser/browser-session.component').then(m => m.UserBrowserPageComponent),
        resolve: { user: UserResolver },
        // `authzGuard` alone, NOT `paywallGuard`. The BFF registers the session routes
        // with `access` + `perm('crawl','execute')` and never `requirePaidAccess`, and
        // `browser-sessions.ts` states why in its own header: a 402 would refuse a free
        // caller before the domain could answer from its tier table. A paywall here
        // would be stricter than the server and would hide a surface the caller is
        // entitled to.
        canActivate: [authzGuard],
        data: {
            title: 'Browser',
            animation: 'browser',
            authz: { resource: 'crawl', action: 'execute' },
        },
    },
    {
        // The machine surface: the caller's own containers AND the machines their
        // browser sessions own, in one place. Moved here from the
        // `crawlpack/machines` tab, because a machine is not a crawl-pack setting --
        // the same console deploys any Fly container, and half of what it lists is
        // now created by a browser session rather than by the crawl pack.
        //
        // `paywallGuard` + `authzGuard`, matching the server exactly: the BFF
        // registers `GET /api/machines` with `paid` + `perm('machine','read')`.
        // `machine.read` is correct HERE because the scope is the caller; the
        // platform-wide fleet uses `platform` for the opposite reason.
        //
        // The component still lives under `crawl-pack/machines/` -- the URL is what
        // moved. Relocating the files is a separate, purely cosmetic change.
        path: 'machines',
        loadComponent: () => import('../../pages/user/crawl-pack/machines/machines.component').then(m => m.MachinesComponent),
        resolve: { user: UserResolver },
        canActivate: [paywallGuard, authzGuard],
        data: {
            title: 'Machines',
            animation: 'machines',
            authz: { resource: 'machine', action: 'read' },
        },
    },
    {
        // The destroyed machines this caller has had. A sibling of the list rather
        // than a tab inside it: the list is paginated through a callable and this is
        // one read of an archive, and the two answer different questions.
        //
        // Declared BEFORE `machines/:machineId` so the literal segment wins; the
        // detail route would otherwise try to load a machine called "history".
        //
        // Same guards as the list, because the server registers the route with the
        // same `paid` + `perm('machine','read')` pair.
        path: 'machines/history',
        loadComponent: () => import('../../pages/user/crawl-pack/machines/machine-history.component').then(m => m.MachineHistoryComponent),
        resolve: { user: UserResolver },
        canActivate: [paywallGuard, authzGuard],
        data: {
            title: 'Machine history',
            animation: 'machines',
            authz: { resource: 'machine', action: 'read' },
        },
    },
    {
        // One machine, in detail. Same guards as the list it is reached from, because
        // both read through `paid + perm('machine','read')` on the server: a paywall
        // here would be stricter than the API, and a missing one would land a free
        // caller on a page whose every request 402s.
        //
        // A real path segment rather than a query parameter, so the URL is shareable
        // and the back button returns to the list.
        path: 'machines/:machineId',
        loadComponent: () => import('../../pages/user/crawl-pack/machines/machine-detail.component').then(m => m.MachineDetailComponent),
        resolve: { user: UserResolver },
        canActivate: [paywallGuard, authzGuard],
        data: {
            title: 'Machine',
            animation: 'machines',
            authz: { resource: 'machine', action: 'read' },
        },
    },
    {
        path: 'billing',
        loadComponent: () => import('../../pages/user/billing/billing.component').then(m => m.BillingComponent),
        loadChildren: () => import('./billing.route').then(m => m.billingRoutes),
        canActivate: [authzGuard],
        data: {
            title: 'Billing',
            animation: 'billing',
            authz: { resource: 'billing', action: 'read' },
        },
    },
    {
        path: 'settings',
        canActivate: [authzGuard],
        data: {
            title: 'Account',
            animation: 'settings',
            authz: { resource: 'organization', action: 'read' },
        },
        loadComponent: () => import('../../pages/user/settings/account.component').then(m => m.AccountSettingsComponent),
        loadChildren: () => import('./settings.route').then(m => m.settingsRoutes),
    },
];

/**
 * Canonical org-scoped children. The org root IS the dashboard, so it is mounted at `''`:
 * `dashboard.deepscrape.dev/{orgId}` is the home page and `/{orgId}/billing` is billing.
 * There is deliberately no `dashboard` segment under an org.
 */
export const OrgRoutes: Routes = [
    { ...dashboardRoute, path: '' },
    ...appPageRoutes,
];

/** Bare paths: legacy URLs, and the console tree at `/admin/**`. */
export const MainRoutes: Routes = [
    dashboardRoute,
    ...appPageRoutes,
];