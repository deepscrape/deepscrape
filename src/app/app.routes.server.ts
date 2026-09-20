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
    { path: '**', renderMode: RenderMode.Prerender },
];
