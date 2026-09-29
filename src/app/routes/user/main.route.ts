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
        path: 'crawlpack',
        loadComponent: () => import('../../pages/user/crawl-pack/crawl-pack.component').then(m => m.CrawlPackComponent),
        loadChildren: () => import('./crawlpack.route').then(m => m.crawlerPackRoutes),
        providers: [provideMarkdown()],
        canActivate: [paywallGuard, authzGuard],
        data: {
            title: 'Crawl Pack',
            animation: 'parentcrawlpack',
            authz: { resource: 'crawl', action: 'execute' },
        },
    },
    {
        path: 'operations',
        loadComponent: () => import('../../pages/user/operations/operations.component').then(m => m.OperationsComponent),
        resolve: { user: UserResolver },
        canActivate: [paywallGuard, authzGuard],
        data: {
            title: 'Operations',
            animation: 'operations',
            authz: { resource: 'crawl', action: 'execute' },
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