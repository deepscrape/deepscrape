import { RenderMode, ServerRoute } from '@angular/ssr';

// ponytail: there is no top-level `billing/plans/:planId` route — the plan page is
// `/user/billing/plans/:planId` behind authGuard. Prerendering the un-prefixed path
// shipped five live-but-empty URLs (`/billing/plans/starter` …) that the SEO strategy
// correctly noindexes; delete the entry rather than publish soft 404s.
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
    { path: '**', renderMode: RenderMode.Prerender },
];
