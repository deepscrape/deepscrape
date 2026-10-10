/**
 * Host-routing policy for the three-origin split
 * (`docs/ADR-2026-09-DOMAINS-MULTISITE-SPLIT.md`).
 *
 * The edge can only fix *document* loads — a typed URL, a bookmark, a
 * `target="_blank"` link. It cannot fix an Angular router navigation, because
 * `routerLink` / `Router.navigate` never issue an HTTP request: the click would
 * render the app page straight onto the marketing origin, which is the exact
 * thing the split exists to prevent. `routerLink` also cannot express a
 * cross-origin href at all.
 *
 * So the policy is declared once here, and enforced twice from the same table:
 *   - `provideHostRouting()` — client-side navigations (see the guard)
 *   - `firebase.json` `redirects` — cold document loads
 *
 * Pure functions only: no `window`, no Angular, no injection. The caller passes
 * the current location in, which is what makes this unit-testable.
 */

/** The origin that owns a path. `marketing` is the apex. */
export type HostClass = 'marketing' | 'app' | 'console';

/**
 * Apex this policy applies to.
 *
 * Deliberately an exact allowlist rather than a derived suffix. The inferred
 * version would invent hosts that do not exist: `deepscrape-app.web.app` (a real
 * Firebase default domain for this project) would yield
 * `dashboard.deepscrape-app.web.app` and send the user to a dead host. Preview
 * channels (`deepscrape--pr-123.web.app`) would break the same way. Anything not
 * named below is treated as single-origin and never redirected, so previews and
 * local dev behave exactly as they do today.
 *
 * Change this one constant if the domain ever moves.
 */
export const SPLIT_APEX = 'deepscrape.dev';

/** Subdomain label per non-apex host class. The apex itself carries `marketing`. */
const SUBDOMAIN_LABELS: Readonly<Record<'app' | 'console', string>> = {
  app: 'dashboard',
  console: 'console',
};

/** The three origins of the split. */
export const ORIGINS: Readonly<Record<HostClass, string>> = {
  marketing: `https://${SPLIT_APEX}`,
  app: `https://${SUBDOMAIN_LABELS.app}.${SPLIT_APEX}`,
  console: `https://${SUBDOMAIN_LABELS.console}.${SPLIT_APEX}`,
};

/**
 * Which origins may serve a path prefix, and where to send a navigation that lands
 * on one that may not.
 */
export interface PathRule {
  /** Path prefix, matched on segment boundaries (`/admin` does not match `/adminx`). */
  prefix: string;
  /** Host classes permitted to serve this prefix. */
  allowed: readonly HostClass[];
  /** Origin that takes over when the current host is not in `allowed`. */
  preferred: HostClass;
}

/**
 * The path table. A path matching no rule is a marketing path and is deliberately
 * given no opinion, so this guard can never hijack a marketing route.
 *
 * Note that `/admin` is absent from the app's prefixes and `/dashboard` &c. are
 * absent from the console's: the two authenticated surfaces are kept strictly
 * apart, so a dashboard URL can never render console screens and vice versa.
 */
export const PATH_RULES: readonly PathRule[] = [
  // Admin console. Its own origin, because the session must not be reachable from
  // app or marketing pages.
  { prefix: '/admin', allowed: ['console'], preferred: 'console' },
  // Authenticated app — exactly the children of the auth-guarded root in
  // `routes/user/main.route.ts`; keep the two in step. `/crawlpack` and
  // `/playground` are auth-restricted app pages, NOT marketing, even though they
  // were previously prerendered (see `app.routes.server.ts`).
  { prefix: '/dashboard', allowed: ['app'], preferred: 'app' },
  { prefix: '/playground', allowed: ['app'], preferred: 'app' },
  { prefix: '/chatai', allowed: ['app'], preferred: 'app' },
  { prefix: '/crawlpack', allowed: ['app'], preferred: 'app' },
  { prefix: '/operations', allowed: ['app'], preferred: 'app' },
  { prefix: '/machines', allowed: ['app'], preferred: 'app' },
  { prefix: '/billing', allowed: ['app'], preferred: 'app' },
  { prefix: '/settings', allowed: ['app'], preferred: 'app' },
  // Auth surface: allowed on BOTH authenticated origins, and only moved off
  // marketing. This entry is what makes an independent console origin workable.
  // Sessions are origin-scoped, so the console needs its own sign-in; if
  // `/service/**` belonged to the app alone, `console/admin` → `authGuard` →
  // `/service/login` would be redirected to the app origin, mint the session there,
  // return to `/admin`, and bounce back — an endless loop with no way to sign in.
  { prefix: '/service', allowed: ['app', 'console'], preferred: 'app' },
];

/**
 * The apex owns every path no other rule claims.
 *
 * Applying that to the authenticated origins is what stops `dashboard.` or
 * `console.` from ever serving the landing page or any other marketing route: an
 * app origin shows only the auth pages, its own pages, and — for the console —
 * `/admin`.
 *
 * Safe *only* because this drives router navigations. `provideHostRouting()`
 * listens to `NavigationStart`, so it never sees an asset fetch; a Hosting-wide
 * `/**` redirect would instead swallow `/assets/*`, `/ngsw-worker.js` and the web
 * manifest and break the app outright. That is why the edge rules stay limited to
 * the claimed prefixes above and never encode this catch-all.
 */
export const MARKETING_RULE: PathRule = {
  prefix: '/',
  allowed: ['marketing'],
  preferred: 'marketing',
};

/**
 * Normalises a hostname for comparison.
 *
 * @param hostname Host with or without a port and trailing dot.
 * @returns Lower-cased host without port or trailing dot.
 */
function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * Classifies a hostname.
 *
 * @param hostname Host to classify (port optional).
 * @returns Its host class, or `null` when the host is not part of the split.
 */
export function hostClassOf(hostname: string): HostClass | null {
  const host = normalizeHost(hostname);
  if (host === SPLIT_APEX || host === `www.${SPLIT_APEX}`) return 'marketing';
  if (host === `${SUBDOMAIN_LABELS.app}.${SPLIT_APEX}`) return 'app';
  if (host === `${SUBDOMAIN_LABELS.console}.${SPLIT_APEX}`) return 'console';
  return null;
}

/**
 * Whether a path sits under a prefix, respecting segment boundaries so that
 * `/dashboardish` is not treated as `/dashboard`.
 *
 * @param pathname Clean path, e.g. `/dashboard/sites`.
 * @param prefix Prefix to test, e.g. `/dashboard`.
 * @returns True when the path is the prefix or nested inside it.
 */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Strips trailing slashes so `/dashboard/` matches `/dashboard`.
 *
 * @param pathname Raw pathname.
 * @returns Pathname without trailing slashes (`/` stays `/`).
 */
function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

/**
 * One-segment paths the apex owns.
 *
 * The org ROOT is `/{orgId}`, and a single segment carries no page name, so an org id can only
 * be told apart from a marketing path by elimination. This is the marketing surface — derived
 * from the prerendered routes in `app.routes.server.ts` — and it exists so a marketing page can
 * never be pulled onto an app origin. `pricing` and `user` are here because the spec pins them
 * as marketing even though neither is a routed page yet.
 *
 * A new one-segment marketing route must be added here as well as to `app.routes.server.ts`.
 */
const MARKETING_SINGLE_SEGMENT_PATHS: ReadonlySet<string> = new Set([
  'contact', 'privacy', 'terms', 'deep-scraper', 'mcp-web-scraping', 'pricing', 'user',
]);

/**
 * The app pages that sit under an org segment: `/{orgId}/billing`, `/{orgId}/billing/plans`, … .
 * The dashboard is NOT here — it is the org root. Kept in step with `routes/user/main.route.ts`.
 */
const ORG_APP_PAGES: ReadonlySet<string> = new Set([
  'playground', 'chatai', 'crawlpack', 'operations', 'billing', 'settings',
]);

/**
 * Whether a path segment names an app page that sits under an org — `/{orgId}/{page}`.
 *
 * Exported for `org-scope.guard.ts`, which has to tell a real org id from a bare legacy path
 * (`/dashboard`, `/billing`) that the `:orgId` route swallowed. The dashboard is deliberately
 * not a member: it is the org ROOT (`ORG_ROOT_SEGMENT`) and that guard handles it separately.
 *
 * @param segment Candidate segment, e.g. `billing`.
 * @returns True when the segment is an org-scoped app page.
 */
export function isAppPageSegment(segment: string): boolean {
  return ORG_APP_PAGES.has(segment);
}

/** The dashboard is mounted at the org ROOT, so its segment is replaced rather than nested. */
export const ORG_ROOT_SEGMENT = 'dashboard';

/**
 * The org-scoped form of an app url, for link generation.
 *
 * `/dashboard` -> `/{orgId}` (the org root IS the dashboard) and `/billing/plans` ->
 * `/{orgId}/billing/plans`. Anything that is not a known app page — `/admin/**` on the console
 * origin, `/service/**`, marketing links — is returned untouched, and so is everything when
 * there is no active org, because the bare routes still resolve.
 *
 * @param url Absolute in-app url, query string and hash optional.
 * @param orgId Active organization, or `null`.
 * @returns The org-scoped url, or `url` unchanged when it must not be scoped.
 */
export function orgScopedUrl(url: string, orgId: string | null): string {
  if (!orgId || !url.startsWith('/')) return url;

  const [pathname, ...suffix] = url.split(/(?=[?#])/);
  const [page, ...rest] = pathname.split('/').filter(Boolean);

  if (page === ORG_ROOT_SEGMENT) {
    const tail = rest.length ? `/${rest.join('/')}` : '';
    return `/${orgId}${tail}${suffix.join('')}`;
  }

  return page && ORG_APP_PAGES.has(page) ? `/${orgId}${url}` : url;
}

/**
 * Rule for the org-scoped form, which the prefix table above cannot express: there is no
 * literal prefix to match when the org owns the first segment.
 *
 * Recognised structurally rather than by inverting the whole table to a deny-list. An
 * inversion would hand every *unlisted* marketing path to the app origin — the spec pins
 * `/pricing` and `/user/profile` as marketing precisely because the apex owns every path no
 * rule claims. This direction can only ever CLAIM a path, never release one.
 */
const ORG_SCOPED_RULE: PathRule = { prefix: '/', allowed: ['app'], preferred: 'app' };

/**
 * The rule governing a path, if any.
 *
 * @param pathname Pathname to resolve.
 * @returns The matching rule. A path no rule claims returns {@link MARKETING_RULE},
 *   so unmatched routes belong to the apex rather than to whichever origin the
 *   user happens to be on.
 */
export function ruleForPath(pathname: string): PathRule {
  const path = stripTrailingSlash(pathname);
  const claimed = PATH_RULES.find((rule) => underPrefix(path, rule.prefix));
  if (claimed) return claimed;

  const segments = path.split('/').filter(Boolean);

  // `/{orgId}/{page}` — the org owns the first segment.
  if (segments.length >= 2 && ORG_APP_PAGES.has(segments[1])) return ORG_SCOPED_RULE;

  // `/{orgId}` — the org root, which IS the dashboard.
  if (segments.length === 1 && !MARKETING_SINGLE_SEGMENT_PATHS.has(segments[0])) {
    return ORG_SCOPED_RULE;
  }

  return MARKETING_RULE;
}

/**
 * The absolute URL a client-side navigation must be moved to, if any.
 *
 * @param pathWithQuery Router navigation URL, e.g. `/service/signup?plan=pro`.
 * @param currentHostname `window.location.hostname`.
 * @returns Absolute cross-origin URL to hand to `window.location.assign`, or
 *   `null` when the navigation should proceed untouched.
 */
export function redirectTargetFor(pathWithQuery: string, currentHostname: string): string | null {
  const from = hostClassOf(currentHostname);
  if (!from) return null; // Not a split deployment: never redirect.

  const pathname = pathWithQuery.split(/[?#]/)[0] || '/';
  const rule = ruleForPath(pathname);
  if (rule.allowed.includes(from)) return null;

  return ORIGINS[rule.preferred] + pathWithQuery;
}
