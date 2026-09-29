import {
  hostClassOf,
  orgScopedUrl,
  redirectTargetFor,
  ruleForPath,
  SPLIT_APEX,
} from './host-routing.policy';

const APEX = SPLIT_APEX;
const APP_ORIGIN = `https://dashboard.${APEX}`;
const CONSOLE_ORIGIN = `https://console.${APEX}`;

describe('host-routing.policy', () => {
  describe('orgScopedUrl', () => {
    it('maps the dashboard onto the org root', () => {
      expect(orgScopedUrl('/dashboard', 'acme')).toBe('/acme');
      expect(orgScopedUrl('/dashboard?tab=1', 'acme')).toBe('/acme?tab=1');
    });

    it('nests every other app page under the org', () => {
      expect(orgScopedUrl('/billing', 'acme')).toBe('/acme/billing');
      expect(orgScopedUrl('/billing/plans/starter', 'acme')).toBe('/acme/billing/plans/starter');
      expect(orgScopedUrl('/settings', 'acme')).toBe('/acme/settings');
    });

    it('leaves the console, the auth surface and marketing links alone', () => {
      expect(orgScopedUrl('/admin/users', 'acme')).toBe('/admin/users');
      expect(orgScopedUrl('/service/login', 'acme')).toBe('/service/login');
      expect(orgScopedUrl('/contact', 'acme')).toBe('/contact');
    });

    it('is a no-op without an active org, or for an external url', () => {
      expect(orgScopedUrl('/dashboard', null)).toBe('/dashboard');
      expect(orgScopedUrl('https://example.com/x', 'acme')).toBe('https://example.com/x');
    });
  });

  describe('hostClassOf', () => {
    it('classifies the three split hosts', () => {
      expect(hostClassOf(APEX)).toBe('marketing');
      expect(hostClassOf(`www.${APEX}`)).toBe('marketing');
      expect(hostClassOf(`dashboard.${APEX}`)).toBe('app');
      expect(hostClassOf(`console.${APEX}`)).toBe('console');
    });

    it('ignores the port and letter case', () => {
      expect(hostClassOf(`Dashboard.${APEX}:4200`)).toBe('app');
    });

    it('treats non-split hosts as single-origin', () => {
      expect(hostClassOf('localhost')).toBeNull();
      expect(hostClassOf('127.0.0.1')).toBeNull();
      // Firebase default domains for this project: deriving an apex from these
      // would invent `dashboard.deepscrape-app.web.app`, which does not exist.
      expect(hostClassOf('deepscrape-app.web.app')).toBeNull();
      expect(hostClassOf('deepscrape--pr-123.web.app')).toBeNull();
      expect(hostClassOf('')).toBeNull();
    });
  });

  describe('ruleForPath', () => {
    it('gives the console its own origin and keeps admin off the app', () => {
      expect(ruleForPath('/admin')?.preferred).toBe('console');
      expect(ruleForPath('/admin/users')?.preferred).toBe('console');
      expect(ruleForPath('/admin')?.allowed).toEqual(['console']);
    });

    it('assigns the authenticated app prefixes to the app origin', () => {
      const appPaths = [
        '/dashboard',
        '/dashboard/sites',
        '/settings/security',
        '/operations',
        '/billing/plans/starter',
        '/crawlpack',
        '/crawlpack/machines',
        '/playground',
        '/chatai',
        // Org-scoped form: the org owns the first segment, the page name the second.
        // There is no `/acme/dashboard` — the org root IS the dashboard.
        '/acme/billing/plans/starter',
        '/acme/settings/security',
        '/acme/playground',
        '/acme/crawlpack/machines',
      ];
      for (const path of appPaths) {
        expect(ruleForPath(path).preferred).toBe('app');
      }
    });

    it('allows the auth surface on both authenticated origins, never marketing', () => {
      expect(ruleForPath('/service/login').allowed).toEqual(['app', 'console']);
      expect(ruleForPath('/service/verification').allowed).toEqual(['app', 'console']);
      expect(ruleForPath('/service/resetpassword').allowed).toEqual(['app', 'console']);
      expect(ruleForPath('/service/login').preferred).toBe('app');
    });

    it('tolerates a trailing slash', () => {
      expect(ruleForPath('/dashboard/').preferred).toBe('app');
      expect(ruleForPath('/admin/').preferred).toBe('console');
    });

    it('keeps segment boundaries, and reads an unclaimed single segment as an org root', () => {
      // Not a prefix bleed: `/dashboardish` is still not `/dashboard`.
      // But the org root is `/{orgId}`, so an unclaimed single segment is structurally
      // indistinguishable from an org id and is app-owned rather than pushed to the apex.
      expect(ruleForPath('/dashboardish').preferred).toBe('app');
      expect(ruleForPath('/administrator').preferred).toBe('app');
      expect(ruleForPath('/services').preferred).toBe('app');
      // The org root itself, with and without the trailing slash.
      expect(ruleForPath('/acme').preferred).toBe('app');
      expect(ruleForPath('/acme/').preferred).toBe('app');
      // The enumerated marketing surface still owns its own one-segment names.
      expect(ruleForPath('/contact').preferred).toBe('marketing');
      expect(ruleForPath('/pricing').preferred).toBe('marketing');
    });

    it('gives the apex every path no other rule claims', () => {
      // `/user` is included deliberately: the user routes mount at `path: ''`, so
      // there is no `/user` route and it must not be treated as an app prefix.
      const marketingPaths = [
        '/',
        '/pricing',
        '/contact',
        '/privacy',
        '/terms',
        '/deep-scraper',
        '/alternatives/crawl4ai',
        '/mcp-web-scraping',
        '/user/profile',
      ];
      for (const path of marketingPaths) {
        expect(ruleForPath(path).preferred).toBe('marketing');
      }
    });
  });

  describe('redirectTargetFor', () => {
    it('moves marketing-page app links off the apex', () => {
      expect(redirectTargetFor('/service/signup', APEX)).toBe(`${APP_ORIGIN}/service/signup`);
      expect(redirectTargetFor('/dashboard', `www.${APEX}`)).toBe(`${APP_ORIGIN}/dashboard`);
      expect(redirectTargetFor('/crawlpack', APEX)).toBe(`${APP_ORIGIN}/crawlpack`);
      expect(redirectTargetFor('/crawlpack/machines', APEX)).toBe(`${APP_ORIGIN}/crawlpack/machines`);
      expect(redirectTargetFor('/playground', APEX)).toBe(`${APP_ORIGIN}/playground`);
      expect(redirectTargetFor('/admin/users', APEX)).toBe(`${CONSOLE_ORIGIN}/admin/users`);
    });

    it('preserves the query string and hash', () => {
      expect(redirectTargetFor('/service/signup?plan=pro', APEX)).toBe(
        `${APP_ORIGIN}/service/signup?plan=pro`,
      );
      expect(redirectTargetFor('/service/login?returnUrl=%2Fdashboard', APEX)).toBe(
        `${APP_ORIGIN}/service/login?returnUrl=%2Fdashboard`,
      );
    });

    it('leaves same-origin navigations alone', () => {
      expect(redirectTargetFor('/dashboard', `dashboard.${APEX}`)).toBeNull();
      expect(redirectTargetFor('/settings/general', `dashboard.${APEX}`)).toBeNull();
      expect(redirectTargetFor('/admin/users', `console.${APEX}`)).toBeNull();
    });

    it('works on the console origin — the flow that used to loop forever', () => {
      // Sessions are origin-scoped, so the console must be able to sign in on its
      // own origin. If `/service/**` were app-owned, this would hand the sign-in to
      // the dashboard, mint the session there, and bounce back to a console that
      // still has no session: `admin` → `authGuard` → `login` → `admin`, endlessly.
      expect(redirectTargetFor('/service/login?returnUrl=%2Fadmin', `console.${APEX}`)).toBeNull();
      expect(redirectTargetFor('/service/verification', `console.${APEX}`)).toBeNull();
      expect(redirectTargetFor('/admin/users', `console.${APEX}`)).toBeNull();
    });

    it('keeps the two authenticated surfaces apart', () => {
      expect(redirectTargetFor('/admin', `dashboard.${APEX}`)).toBe(`${CONSOLE_ORIGIN}/admin`);
      expect(redirectTargetFor('/dashboard', `console.${APEX}`)).toBe(`${APP_ORIGIN}/dashboard`);
    });

    it('never serves a marketing page from an authenticated origin', () => {
      // The requirement: `dashboard.` shows only auth + app pages and `console.` only
      // auth + admin pages. Everything unclaimed belongs to the apex.
      for (const host of [`dashboard.${APEX}`, `console.${APEX}`]) {
        expect(redirectTargetFor('/', host)).toBe(`https://${APEX}/`);
        expect(redirectTargetFor('/contact', host)).toBe(`https://${APEX}/contact`);
        expect(redirectTargetFor('/pricing?plan=pro', host)).toBe(`https://${APEX}/pricing?plan=pro`);
      }

      // …and the apex keeps them, on both the apex and www.
      expect(redirectTargetFor('/', APEX)).toBeNull();
      expect(redirectTargetFor('/contact', APEX)).toBeNull();
      expect(redirectTargetFor('/pricing', `www.${APEX}`)).toBeNull();
    });

    it('never redirects on a single-origin host', () => {
      expect(redirectTargetFor('/service/signup', 'localhost')).toBeNull();
      expect(redirectTargetFor('/admin/users', 'localhost')).toBeNull();
      expect(redirectTargetFor('/dashboard', '127.0.0.1')).toBeNull();
      expect(redirectTargetFor('/service/signup', 'deepscrape--pr-123.web.app')).toBeNull();
    });
  });
});
