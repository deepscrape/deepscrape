# ADR-2026-09: Split the app across marketing / dashboard / console subdomains

Status: **accepted** · Date: 2026-09-26 · Supersedes nothing

## Decision

Serve **three** origins from **one build artifact** using **classic Firebase Hosting
multi-site**, all three rewrites pointing at the **existing** Cloud Run service
`deepscrape-bff`:

| Origin | Hosting site | Serves | Rewrite target |
|---|---|---|---|
| `deepscrape.dev` | `deepscrape` *(exists)* | prerendered marketing / non-auth pages | `deepscrape-bff` |
| `dashboard.deepscrape.dev` | `deepscrape-app` *(created)* | authenticated app | `deepscrape-bff` |
| `console.deepscrape.dev` | `deepscrape-console` *(created)* | admin console (`/admin/**`) | `deepscrape-bff` |

No new backend, no new build, no new product. The three sites differ **only** in
`redirects` / `rewrites` / `headers`.

**`/admin` must never be served by `dashboard.deepscrape.dev`.** The two authenticated
surfaces are kept strictly apart, and the guard enforces it in both directions. The one
non-obvious consequence is that the console needs its own sign-in — sessions are
origin-scoped — which is why the auth surface is allowed on *both* authenticated origins.
See *Why the console needs its own sign-in, not its own auth stack*.

## Why not the alternatives

**Firebase App Hosting — rejected.** It provisions one managed Cloud Run backend per
app, built from a repo or image via `apphosting.yaml`. Three domains would mean three
backends and three builds of the same Angular app, replacing a hand-tuned Elysia
service that is deliberately *not* a framework build (it owns `security.ts` CSRF,
the limiter, guest tracker, traffic counter). There is no `apphosting.yaml` in the
repo — the `emulators.apphosting` block in `firebase.json` is scaffolding for a
product this project does not use. Classic Hosting already serves prod today.

**A separate `api.deepscrape.dev` — rejected, and this is the load-bearing part.**
Every client call is already a **relative path**: `/api/*`, `/event/*`, `/oauth/*`,
`/csrf-token`, `/ws/*`, `/services/contact`. Because each site rewrites those same
prefixes to the same BFF, **every origin stays same-origin with its own API.** Move
the API to its own hostname and you inherit: CORS preflights on every call, the
`_csrf` cookie becoming cross-site (so `withXsrfConfiguration({cookieName: '_csrf'})`
breaks), and the `ALLOWED_ORIGINS` list growing with every future origin. Data
included no request for an API subdomain; the backend stays behind relative rewrites.

## What the split actually buys

1. **`console.` gets its own origin.** The current CSP (single site, `firebase.json`)
   contains both `'unsafe-inline'` and `'unsafe-eval'` because the marketing page
   needs them. The admin console needs neither. Per-site headers give console a strict
   CSP — and because the BFF emits **no** CSP of its own, the Hosting header is the
   only one on that origin, so it is fully enforceable.
2. **Origin isolation for privileged sessions.** Today the admin console shares an
   origin with GTM, GA, reCAPTCHA and Turnstile. An XSS anywhere on that origin reads
   admin storage and cookies. Same-origin policy is the only thing that makes this
   structurally impossible, and it requires a separate origin.
3. **Apex ships no auth and no privileged surface** — nothing on the marketing origin
   is worth stealing, and app paths 301 away at the edge.
4. **Edge access control without app code.** Cloudflare Access / Cloud Armor on
   `console.` is a DNS/proxy change, not a code change.

## What it costs — state these plainly

- **Sessions are per-origin.** `indexedDBLocalPersistence` does not cross subdomains.
  Signing in on `dashboard.` does **not** sign you in on `console.`. For console that is
  desirable (an admin deliberately authenticates separately); it also means login must
  live on `dashboard.` or a future `auth.` origin — **never on the apex**, or the
  marketing origin gains a credential surface.
- The app bundle is fetched and cached once per origin (dashboard + console).
- Deep links that cross origins change shape, which is what the risk list below is about.

## Risk inventory — verified, not assumed

Every single-origin assumption in the tree, with the consequence at cutover. **Order
matters: widen accept-lists before the new origins serve traffic.**

| # | Location | Assumption | Consequence if untouched |
|---|---|---|---|
| 1 | `functions/src/app/stripe.ts:246` `billingAllowedOrigins` | prod = apex + `web.app` | **Stripe checkout hard-fails.** `plans.component.ts` sends `window.location.origin + '/billing/success'`, and `assertAllowedReturnUrl` (:309) throws `permission-denied` for any other origin. Billing breaks the moment `dashboard.` loads. |
| 2 | `bff/security.ts:61` `ALLOWED_ORIGINS` | prod = apex + `web.app` | BFF CSRF/CORS origin gate refuses the new origins. |
| 3 | `functions/src/config/env.ts:192` `APP_ORIGIN` | one origin for everything | 5 email/CTA links (`admin-users.ts` :662 `Appeal`, :1105 `Appeal`, :1302 `Sign in`; `alert-presentation.ts:44` and `alert-fanout.ts:70` `securityUrl`). `Sign in` must be the dashboard origin; `/contact` is marketing. One constant cannot serve both. |
| 4 | `src/app/core/functions/global.fun.ts:208` `resolveSafeReturnUrl` | `parsed.origin === window.location.origin` | **No change needed.** The check only rejects a *foreign* origin, and every builder of `returnUrl` uses `window.location.origin`, so a foreign one cannot occur while the app has a single origin. Widening an open-redirect guard for an unreachable case is the wrong trade. |
| 5 | `src/app/pages/service/action/action-handler.component.ts:175` `resolveRedirectUrl` | `url.host === window.location.host`, else the raw URL | **FIXED 2026-09-26.** An absolute `continueUrl` reached `router.navigateByUrl`, which treats it as an in-app path, fails to match, and strands the user silently. Now uses `window.location.assign`. A latent bug that predates the split. |
| 6 | `src/app/pages/service/verification/verification.component.ts:340` `getAbsoluteContinueUrl` | builds an absolute URL for one origin | **No change needed.** It resolves against the current origin, and `/service/**` moves to the dashboard origin, so it produces the correct absolute URL by definition. |
| 7 | `src/app/core/services/seo-title.strategy.ts:6` `ORIGIN` | hardcoded apex | **No change needed.** `updateTitle` keys off an exact-path allowlist of seven marketing paths and already removes `canonical`, `og:*` and sets `robots: noindex, nofollow` for anything else — so a dashboard/console path emits no canonical at all. Nothing claims the apex. |
| 8 | `src/environments/prod_gen.ts:38`, `prod.ts:4` `assetsUri` | `https://deepscrape.dev/assets/` | **FIXED 2026-09-26** → `"/assets/"` (relative) in `prod_gen.ts`, `prod.ts`, `staging.ts` and the CI workflow. Consumed only by `customImageLoader` (`app.config.ts:43`) for `NgOptimizedImage`; the absolute apex base made every optimised image on the app origins load cross-origin. Router base was never affected (`<base href="/">`). |
| 9 | `bff/security.ts:128-138` `_csrf` cookie | `Domain=` attribute | **RESOLVED — no `Domain` is set**, so both `_csrf` and `_csrf_secret` are host-only, `sameSite: 'lax'`, `secure` in prod. Each origin keeps its own token and the isolation is real. (`lax` is also why a separate `api.` origin was rejected: it would not send the cookie cross-site.) |
| 10 | `public/sitemap.xml`, `public/robots.txt` | apex URLs | Must not be served from dashboard/console. Console should also carry `X-Robots-Tag: noindex`. |
| 11 | `src/app/pages/user/settings/security/security.component.html:1445`, `public/*`, `README.md`, `docs/SECURITY_TXT_GUIDE.md` | apex for contact/security URLs | Cosmetic, but `security.txt` should state the canonical origin. |
| 12 | `src/app/layout/landpage/hero/hero.component.html:196` | documents `api.deepscrape.dev/v1/crawl` | Currently fictional in a code sample. Either make it real or change the sample — shipping a sample for a hostname you do not own invites support tickets. |

Not a problem, worth recording: **Stripe success/cancel/portal URLs and the
signup-verification `continueUrl` already use `window.location.origin`**
(`plans.component.ts` :581/:610/:640/:668, `paymentmethods.component.ts:86`,
`signup.component.ts:100`, `onboarding.component.ts:338`) — they follow the split for
free. Likewise the CSRF/payment/session interceptors resolve `new URL(req.url,
location.origin)`, which stays correct on a relative path.

Backend callables need **no code change**: they are reached via the AngularFire SDK at
`us-central1-libnet-d76db.cloudfunctions.net` (already in the CSP `connect-src`), and
CORS is derived from the Firebase Auth authorized-domains list.

## Migration

### Phase 1 — provision, no traffic
1. `firebase hosting:sites:create libnet-d76db:deepscrape-app` and `…:deepscrape-console`.
   **DONE 2026-09-26** — both created. The site id is `deepscrape-console`, not
   `deepscrape-gate`, so the site matches its domain; site ids are globally unique and
   permanent, so this name is worth fixing before it ever serves traffic.
2. Add targets to `.firebaserc` (currently only `{"projects":{"default":"libnet-d76db"}}`
   — **no hosting targets exist**, the existing site is referenced by literal
   `"site": "deepscrape"`):
   ```jsonc
   "targets": { "libnet-d76db": { "hosting": {
     "marketing": ["deepscrape"], "dashboard": ["deepscrape-app"], "console": ["deepscrape-console"]
   }}}
   ```
3. Add `dashboard.deepscrape.dev` / `console.deepscrape.dev` as custom domains on their
   sites; create the DNS records the console prints. Follow the existing apex pattern
   (A → Hosting anycast, `proxied=false`, plus the `hosting-site=` TXT).
4. Firebase Authentication → Settings → **Authorized domains**: add both. Without this,
   `signInWithPopup`/`signInWithRedirect` fail on the new origins — and the console signs in
   on its **own** origin, so it is not optional there. The AppCheck reCAPTCHA v3 key needs
   the same two origins — see Phase 5 step 3.
5. Nothing is live yet. Verify: the new hostnames resolve and serve the default
   "Site Not Found" page.

### Phase 2 — widen every accept-list **while the new origins are still dark**
Deploy the BFF and functions with the new origins permitted. The old origin keeps
working, so this is a no-op deploy that de-risks Phase 5.

- `billingAllowedOrigins` and `ALLOWED_ORIGINS` — **DONE 2026-09-26**: both prod lists carry
  `https://dashboard.deepscrape.dev` and `https://console.deepscrape.dev` while the origins
  are still dark, so neither list can be the thing that breaks cutover.
- `APP_ORIGIN` → split into `DASHBOARD_ORIGIN` and `MARKETING_ORIGIN`; repoint the five
  call sites (`Sign in` → dashboard, `Appeal`/`contact` → marketing)
  — **PARTLY DONE 2026-09-26**: `MARKETING_ORIGIN` added (defaults to the apex, so no
  behaviour change today) and the two `/contact` CTAs in `admin-users.ts` repointed.
  `APP_ORIGIN` keeps the app links and its doc comment now names it as the authenticated
  origin — flip its value to the dashboard origin at cutover. Also fixed a dead
  `/login` link in `admin-users.ts` that should have been `/service/login`.
- confirm `firebase.json` CSP `connect-src`/`frame-src` still covers what the app
  needs from the new origins (it is `'self'`-based for app assets, so no change expected)

Verify: full billing checkout on the **old** origin still works (regression), and
`assertAllowedReturnUrl` accepts a new origin when called directly.

### Phase 3 — make cross-origin links host-aware

**Most of this phase turned out to be unnecessary once the code was read.** The app is
already origin-relative by construction: the same-origin guards are fed URLs built from
`window.location.origin`, so they never see a foreign origin in practice. Three of the
five items are struck out below with the reason, rather than implemented speculatively.

- **DONE 2026-09-26** `assetsUri` → `"/assets/"` (relative) in `prod_gen.ts`, `prod.ts`,
  `staging.ts` and the CI workflow. Consumed only by `customImageLoader`, and an absolute
  apex base made every optimised image on the app origins load cross-origin from the
  marketing site. `<base href="/">` means relative resolves correctly everywhere.
- **DONE 2026-09-26** `resolveRedirectUrl` / `completeEmailVerification` — an absolute
  `continueUrl` was being passed to `router.navigateByUrl`, which treats it as an in-app
  path, fails to match, and strands the user with no error. Now handed to
  `window.location.assign`. This is a **latent bug that predates the split**; any
  external `continueUrl` already hit it.
- ~~`seo-title.strategy.ts`~~ — **no change needed.** `SEO` is an exact-path allowlist of
  seven marketing paths, and `updateTitle` already removes `canonical`, `og:*` and sets
  `robots: noindex, nofollow` for everything else. A dashboard or console path therefore
  emits no canonical at all, which is what we wanted. Nothing claims the apex.
- ~~`getAbsoluteContinueUrl`~~ — **no change needed.** It resolves against the *current*
  origin, and the verification pages move to the dashboard origin with the rest of
  `/service/**`, so it builds the right absolute URL by definition.
- ~~`resolveSafeReturnUrl`~~ — **no change needed while the app has one origin.** Its
  same-origin check only rejects a foreign origin, and nothing emits a foreign
  `returnUrl` (every builder uses `window.location.origin`). Widening an open-redirect
  guard for a case that cannot occur is the wrong trade; revisit only if a second app
  origin is ever introduced.

- **DONE 2026-09-26** Cross-origin in-app links — **one guard, zero call-site edits.**
  The items above all reasoned about *code* (guards, URL builders, the SEO strategy), which
  is why they mostly collapsed. They missed the *templates*: a grep for
  `routerLink="/(service|dashboard|admin|settings|billing|user|operations|onboarding)`
  returns **23 links across 15 files**, plus ~10 more in the `pages/marketing/**` SEO pages
  that link into `/service/signup` (the header's sign-in/dashboard buttons among them).

  Per-link rewriting would **not have worked anyway**, for two reasons:
  1. `routerLink` cannot express a cross-origin href, and the target origin cannot be baked
     into a template — marketing pages are prerendered, so no host is known at build time.
  2. Even with `href`, every link would have to be found, and `Router.navigate`,
     the session-revocation interceptor, manual URL entry and back/forward would each
     still escape — including links added later.

  So the policy lives once, in `core/guards/host-routing.policy.ts`, and is enforced by
  `provideHostRouting()` (registered in `app.config.ts`) against `NavigationStart`. That
  covers **every** entry point in one place. It is deliberately one-directional: only paths
  owned by the app/console move, so the guard can never hijack a marketing route. It keys
  off an exact apex allowlist, not suffix inference — inference would invent
  `dashboard.deepscrape-app.web.app` from the Firebase default domain and break preview
  channels. Localhost, IPs and `*.web.app` are therefore single-origin and never redirect.

  ⚠️ **This is live on arrival — unlike the Phase 2 allowlist widening.** The marketing host
  today *is* `deepscrape.dev`, so the moment this code ships, every marketing sign-up CTA
  redirects to `dashboard.deepscrape.dev` (and `/admin` links to `console.…`). Deploying it
  before those domains resolve breaks sign-up on the live site, via a different path than
  the Phase 4 301s. **Same rule: batch with cutover, no early production deploy.**

  The guard and the Phase 4 301s are complementary, not redundant: the 301s cover cold
  document loads where no JavaScript has run (typed URLs, bookmarks, `target="_blank"`,
  crawlers), the guard covers everything the router handles. Note `/service/**` is currently
  *prerendered* (it falls under `**` → Prerender; it is absent from `app.routes.server.ts`),
  but Hosting evaluates `redirects` before static files, so the planned apex 301 still wins
  over those prerendered files — no build change needed.

Verify: `resolveSafeReturnUrl` still rejects hostile input (`//evil.com`,
`https://evil.com/x`); an email verification link with an absolute `continueUrl`
navigates instead of stranding; billing success/cancel round-trip on the dashboard origin;
a marketing page's sign-up CTA leaves the apex for the dashboard origin; `/contact` and `/`
do **not** redirect on any host; and `deepscrape--pr-*.web.app` behaves exactly as it does
today.

### Phase 4 — hosting configs
Convert `hosting` in `firebase.json` from an object to an **array of three**, each with
`target`, `site`, `public: "dist/deepscrape/browser"` (the same artifact — no build
change), the same `run` rewrite, and site-specific `headers` / `redirects`:
- **marketing**: current CSP (unchanged), apex-only `robots.txt`/`sitemap.xml`.
  301 app paths: `/admin{,/**}` → **console** origin, and `/dashboard{,/**}`,
  `/settings{,/**}`, `/operations{,/**}`, `/user{,/**}`, `/billing{,/**}`, `/service{,/**}`
  → dashboard origin. Leave `/api`, `/event`, `/oauth`, `/ws`, `/status` alone — those are
  BFF routes, not pages, and redirecting them breaks the app.

  **Shipped form (verified, not guessed).** Firebase globs capture with a `:`-prefixed
  segment and `*` for the remaining path, reused in `destination` — there is no `**`
  substitution:
  ```jsonc
  { "source": "/admin", "destination": "https://console.deepscrape.dev/admin", "type": 301 },
  { "source": "/admin/:rest*", "destination": "https://console.deepscrape.dev/admin/:rest", "type": 301 }
  ```
  A bare-prefix rule precedes each wildcard. **Verified live:** `dashboard…/admin/users`
  → `console…/admin/users`, path intact. Note a directory path that has an `index.html`
  is first canonicalised to a trailing slash (`/service/login` → `/service/login/`); that
  is Firebase's own behaviour and predates the split — it happens on the apex today too.

  **Do not ship these redirects before both custom domains resolve**, or every bookmarked
  app URL on the apex 301s to a dead host. They are the last step before cutover.
- **dashboard**: `X-Robots-Tag: noindex, nofollow`. No `/admin` here — the guard redirects
  it to the console, and the 301 above covers cold loads.
- **console**: stricter CSP — drop `'unsafe-eval'` and tighten `'unsafe-inline'` for scripts
  as far as the console allows — but it **must** still permit the auth providers, because the
  console signs in on its own origin: `accounts.google.com`, `apis.google.com`,
  `www.gstatic.com` and the reCAPTCHA/AppCheck hosts in `script-src` / `frame-src` /
  `connect-src`. That is the price of a separate console session; `unsafe-eval` removal is
  still a real tightening. Also `X-Robots-Tag: noindex, nofollow`,
  `Referrer-Policy: no-referrer`, and no `robots.txt` from the apex.

**Bare-root URLs — easy to miss, because all three sites deploy the same artifact.** The
catch-all `{"source": "**", "run": …}` sends unmatched paths to the BFF, which serves the
CSR shell, so `/admin/users` boots correctly on the console host with **no route or build
change**. But `/` *does* match a static file — the prerendered `index.html` (the ~370 KB
marketing home) — and static content is served before the rewrite. So without a redirect,
`dashboard.deepscrape.dev` and `console.deepscrape.dev` would each render the **marketing
landing page**. Per-site redirects fix it (redirects outrank static content):

- **dashboard**: `/` → `/dashboard`.
- **console**: `/` → `/admin`.

**The root redirect is not a patch for the artifact-sharing leak — it is what an app host is
supposed to do.** `dashboard.stripe.com/` has no landing page either: it goes to login, or
straight into the dashboard when a session already exists. An app subdomain's root belongs to
the app, never to marketing. The rule would be wanted even if marketing were a separate
application; it merely *happens* to close the `/` leak listed above, which is why it was
mis-framed there as a workaround.

The edge cannot know authentication state, so this is necessarily two-stage — the same shape
Stripe's own host has:

1. **Edge**: `/` → the app's own entry route, unconditionally.
2. **App**: `authGuard` sends a signed-out visitor to `/service/login?returnUrl=/dashboard`,
   and `LoginGuard` on `/service/login` sends a signed-in one back to the return URL — the
   default being `/dashboard` via `resolveSafeReturnUrl`. Unverified users land on
   `/service/verification` instead of the app.

**Both app-side halves already exist**, so the edge redirect above completes the loop with no
code change: `/service/login` and `/service/signup` are already wrapped in `LoginGuard`, and
`resolveSafeReturnUrl`'s same-origin check still guards the round trip. Worth stating plainly
because it is easy to re-implement by accident.

**Is this normal? Not for most SaaS — and it is worth being straight about why.** The root
collision is a consequence of *sharing one build artifact across three hosts*, not of the
split itself. Marketing pages never turn up on product URLs in the industry's common shape:

- The usual SaaS topology is a **separate marketing app** — Next.js/Astro/Webflow/Framer/CMS
  — on its own host, with the product SPA on `app.example.com` or `example.com/app`. The two
  share no code, so this entire leak class simply cannot occur. A `dashboard.` URL can never
  serve a marketing page when there is no marketing page in that build.
- A **separate admin origin** is the enterprise/regulated variant rather than the default.
  Most products gate `/admin` inside the app by role. Taking the third origin here is a
  deliberate hardening choice, weighed in *"The cheaper alternative"* below.
- What *is* universal, and what this ADR does get right: one origin per trust boundary, a
  knowingly looser CSP on the marketing origin than the app, `noindex` on authenticated
  origins, and cookies/storage scoped per origin.

One artifact on three hosts buys a single build pipeline, zero duplicated code, and no
second framework. The price is a small, bounded family of leaks. They are listed here so
they are *accepted deliberately* rather than rediscovered one at a time:

| Leak | Status |
|---|---|
| `/` resolves to the prerendered marketing home on both app origins | **Fixed** — by the app-host root redirect, which convention requires anyway (see above). A leak only incidentally |
| Every *other* prerendered marketing path is likewise reachable there | **Fixed 2026-09-26** — the authenticated origins now 301 the marketing prefixes (`/contact`, `/privacy`, `/terms`, `/deep-scraper`, `/alternatives`, `/mcp-web-scraping`) plus `/` to the apex at the **edge**, and the guard sends any remaining unclaimed path there too. Originally *accepted*; the requirement is that an app origin never serves a marketing page at all. |
| The marketing bundle contains the product's JS, and its `/**` CSP must satisfy the loosest consumer (`unsafe-eval`) | **Accepted** — pre-existing; the console gets its own stricter CSP |
| An app dependency upgrade rebuilds and redeploys marketing too — one blast radius | **Accepted** — inherent to a single build |

None of this justifies a second build pipeline now. Revisit only if marketing wants a CMS or
a non-Angular framework — at which point a separate marketing app becomes the *cheaper*
option, not the more expensive one.

Two things **now verified**, so they no longer need checking at Phase 4:
- A Hosting `redirects.destination` **does** accept a full absolute URL — the official
  example redirects to `https://www.firebase.com`. The cross-origin 301s need no app code.
- The `_csrf` cookie is host-only (risk 9, resolved above), so per-origin token isolation
  holds without any cookie change.
- Whether the SW should stay on console. It can stay (it caches only the shell); dropping
  it means a `404` on `/ngsw-worker.js` and a console error, so keep it unless there
  is a reason not to.

Also delete the speculative `emulators.apphosting` block.

### Phase 5 — cut over and verify
1. Deploy hosting for all three targets.
2. Add both origins to the Firebase Auth authorized-domains list if not already done.
3. **Add both origins to the reCAPTCHA admin console.** AppCheck uses a reCAPTCHA v3 site
   key, and v3 keys are **domain-scoped** — the new hosts are not allowed just because the
   apex is. Miss this and AppCheck attestation fails on `dashboard.` and `console.`, so every
   protected callable/API rejects and the console breaks in a way that looks like a
   permissions bug rather than a config one. Same class of trap as the Auth
   authorized-domains list, but it fails *silently*.
4. **Sign in on the console origin and reach `/admin`.** This is the check that would have
   caught the loop: `console.deepscrape.dev/admin` signed out must go to sign-in *on the
   console* and return to the console, not hand the session off to the dashboard.
5. Checklist on **each** new origin: sign-in (popup + redirect), MFA challenge, `_csrf`
   present and **not** shared with the apex, `/api/*` reaches the BFF, callables
   authenticate, **AppCheck token mints**, Stripe checkout + portal return, email
   verification link, password reset link, `adminGuard` blocks a non-admin at `/admin`,
   `/admin` on `dashboard.` redirects to the console rather than rendering, `canonical`
   absent, `robots.txt` absent or disallowing, the console CSP has no `unsafe-eval`,
   `dashboard.` and `console.` bare roots land on `/dashboard` and `/admin` rather than the
   marketing page, and neither app origin can read storage written by the apex.
6. Confirm cross-origin isolation empirically: `document.cookie` and `localStorage` on
   `console.` must be empty of both apex **and dashboard** values.

## The alternative that was rejected

**Two origins: the console as a path on the app.** Keep the console at
`dashboard.deepscrape.dev/admin/**` and harden it with **path-scoped Hosting headers**. That
is a `firebase.json`-only change: no new site, no DNS, no authorized-domain or reCAPTCHA
churn, no second sign-in — because the session is shared.

It was briefly adopted during this work and then reverted. **Rejected because the requirement
is that `dashboard.deepscrape.dev` must not serve `/admin` at all.** Path-scoped headers
cannot deliver that: on a single origin a console route is still reachable from any app
page's JavaScript, and the admin session *is* the app session. The third origin is what makes
the two surfaces genuinely separate; the sign-in cost is bounded and now understood. If the
requirement ever softens to "tighten the admin CSP", this route is the cheap one.

### Why the console needs its own sign-in, not its own auth stack

A `console.` origin cannot work unless the auth surface is allowed there. Session storage is
**origin-scoped**, so if `/service/**` belonged to the app alone:

1. `console.deepscrape.dev/admin` while signed out → `authGuard` →
   `/service/login?returnUrl=/admin`.
2. The guard moves that navigation to `dashboard.deepscrape.dev`. The sign-in therefore
   happens **on the dashboard origin**, and the resulting session exists only there.
3. `returnUrl=/admin` then navigates to `/admin` → the guard moves it back to `console.`…
4. …where there is still no session, so `authGuard` begins again at step 1. **It never
   converges**, and the console is unreachable.

The fix is the path table, not a second auth stack: `/service/**` is allowed on **both**
authenticated origins and is only moved off marketing. The console therefore signs in on its
**own** origin, mints its own session, and `/admin` resolves. The guard has a spec pinning
exactly this flow — `works on the console origin — the flow that used to loop forever`.

**Two consequences, accepted deliberately:**

- **The console's CSP must permit the auth providers** (`accounts.google.com`,
  `apis.google.com`, `gstatic`, reCAPTCHA/AppCheck) in `script-src` / `frame-src` /
  `connect-src`. It can still drop `'unsafe-eval'` and tighten `'unsafe-inline'`, which is
  where most of the hardening lives — but it is not a scripts-from-self-only policy.
- **An admin who also uses the app signs in twice**, once per origin. That is the intended
  trade: the console session is never reachable from a marketing page, and an app page can
  never render console screens.

## Deliberate ceilings

- Sessions remain per-origin; no attempt at cross-subdomain SSO, so an admin who uses both
  surfaces signs in twice. Accepted: it is the direct cost of keeping the console's session
  unreachable from the app and marketing origins. A future `auth.` origin or an explicit
  token handoff is the upgrade path if the double sign-in becomes a real complaint — do not
  build it speculatively.
- Single Cloud Run service for all three origins. If console ever needs to scale or be
  isolated independently (different limits, separate blast radius), split its rewrite to
  a second service — a config change, not a rewrite.
- No CSPRNG nonce plumbing was added. The BFF emits no CSP, so the Hosting header is
  authoritative and `'self'` + explicit hosts is the whole story.
