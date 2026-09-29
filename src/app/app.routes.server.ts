import { RenderMode, ServerRoute } from '@angular/ssr';

// ponytail: `UserRoutes` is mounted at the root (`path: ''`), so `billing/plans/:planId`
// is a real, auth-guarded route — NOT a marketing page. Prerendering it baked the guest
// shell into five live URLs (`/billing/plans/starter` …); `billing/**` below serves the
// whole family per-request instead, which also satisfies the parameterised route (a
// Server route needs no getPrerenderParams, a `**` Prerender fallback does).
export const serverRoutes: ServerRoute[] = [
    // ponytail: do NOT statically bake authenticated/private pages. They only
    // render a guest shell, and building them executes browser-only Firebase
    // Auth (TOTP/MFA) on the server, spamming auth/operation-not-supported.
    // Serve them per-request instead (SSR engine, CSR fallback until deployed).
    { path: 'admin/**', renderMode: RenderMode.Server },
    { path: 'settings/**', renderMode: RenderMode.Server },
    { path: 'dashboard/**', renderMode: RenderMode.Server },
    { path: 'operations/**', renderMode: RenderMode.Server },
    { path: 'user/**', renderMode: RenderMode.Server },
    { path: 'billing/**', renderMode: RenderMode.Server },
    // Auth-restricted app pages, not marketing. Prerendering them bakes the guest
    // shell into a real URL — the same failure this list already documents for
    // `/billing/plans/:planId` — and the host guard sends them to the app origin.
    { path: 'crawlpack/**', renderMode: RenderMode.Server },
    { path: 'playground/**', renderMode: RenderMode.Server },
    // Same reason as playground: auth-gated, so prerendering only bakes a guest shell.
    { path: 'chatai/**', renderMode: RenderMode.Server },
    // Marketing and auth pages, listed EXPLICITLY and ahead of the `:orgId` rule below.
    // `:orgId/**` matches any first segment, so without these it would pull every one of
    // them into Server mode and silently stop baking them — an SEO regression that no
    // type check would catch. Verified by diffing the baked files after a build.
    { path: 'contact', renderMode: RenderMode.Prerender },
    { path: 'privacy', renderMode: RenderMode.Prerender },
    { path: 'terms', renderMode: RenderMode.Prerender },
    { path: 'deep-scraper', renderMode: RenderMode.Prerender },
    { path: 'mcp-web-scraping', renderMode: RenderMode.Prerender },
    { path: 'alternatives/crawl4ai', renderMode: RenderMode.Prerender },
    { path: 'service/action', renderMode: RenderMode.Prerender },
    { path: 'service/device-verification', renderMode: RenderMode.Prerender },
    { path: 'service/login', renderMode: RenderMode.Prerender },
    { path: 'service/onboarding', renderMode: RenderMode.Prerender },
    { path: 'service/resetpassword', renderMode: RenderMode.Prerender },
    { path: 'service/signup', renderMode: RenderMode.Prerender },
    { path: 'service/verification', renderMode: RenderMode.Prerender },
    // Canonical org-scoped app shell. Server mode because `:orgId` is a parameter and a
    // Prerender fallback would demand `getPrerenderParams`.
    { path: ':orgId/**', renderMode: RenderMode.Server },
    { path: '**', renderMode: RenderMode.Prerender },
];
