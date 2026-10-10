# ADR-2026-09-PLATFORM-ARCHITECTURE: platform shape and the decisions that hold it

- **Status:** accepted
- **Date:** 2026-09-30
- **Context of record:** written from code read and commits authored across 2026-09-25..30. The
  knowledge-graph index was last built on 2026-09-26 (17,216 nodes / 26,828 edges) and is 14
  commits stale; a refresh is pending because the MCP server currently refuses this root.

## Context

Three surfaces ship from one repository: a marketing site, the signed-in app, and an admin
console. They share a Firebase project, a Firestore database, and one Firebase Auth tenant.
Two runtimes serve them — Angular 20 (zoneless, standalone, SSR/prerender via `@angular/ssr`)
and a Bun + Elysia BFF on Cloud Run — plus a Python Crawl4AI agent. Stripe bills subscriptions
and prepaid credits; Upstash Redis fronts the hot auth/session paths.

The pressure that shaped the decisions below is not scale. It is that **the same data is
addressed by more than one identity**, and the failure mode of that is silent: a page that
renders an empty state, a webhook that is never delivered, an id that resolves in one account
and not the other.

## Decisions

### 1. Origins are split by a policy table, enforced twice

`src/app/core/guards/host-routing.policy.ts` declares one table of path prefixes and permitted
host classes. It is enforced by `provideHostRouting()` for client-side navigations and by
`firebase.json` redirects for cold document loads. The edge alone cannot work: a router
navigation never issues an HTTP request, so a `routerLink` click would render an app page onto
the marketing origin — the exact thing the split prevents — and `routerLink` cannot express a
cross-origin href anyway. The apex is an exact allowlist rather than a derived suffix, because
the derived version invents hosts that don't exist (`dashboard.<default-web-app-domain>`) and
breaks preview channels.

The pure functions take the location as a parameter, which is what makes the table testable
without a browser. See `docs/ADR-2026-09-DOMAINS-MULTISITE-SPLIT.md`.

### 2. A Stripe id means nothing outside the account that minted it

One Firestore sits behind **two Stripe accounts** (a sandbox and the live one), and a stored
`stripeId` carries no mode or account marker. Ids written while the sandbox key was configured
became unretrievable the moment livemode was switched on, and unhandled that surfaced as a 500
on the whole callable.

`resolveStripeCustomerId` now treats `resource_missing` as "no customer yet", clears the dead
field, and returns null so the caller takes its no-customer path; `ensureStripeCustomerId`
wraps it with resolve-or-mint and is the single entry point for both checkout and the billing
portal. The general rule: **never let an identifier from another environment reach a user-facing
path unguarded** — resolve it, and self-heal when it's stale.

### 3. Stripe owns payment data; Firestore may only mirror presentation

The saved-card list reads a Firestore mirror written by `payment_method.*` webhooks, not Stripe
directly. That mirror has now failed three distinct ways: a missing rules block (read denied,
rendered as "no cards"), fields that are null in the attach-time snapshot (stale forever), and
an event that was never subscribed (silent, because a missing subscription means the handler is
simply never called).

**Consequence:** the mirror is a liability that scales with the number of webhook subscriptions
it requires. Where a value can be fetched on demand, fetch it; reserve the mirror for data that
must survive Stripe being unavailable.

### 4. Every user subcollection needs its own rules block

`match /users/{userId}` does **not** grant access to `/users/{uid}/<anything>`. Each
subcollection needs a nested `match`, or it falls to the recursive catch-all at the top of
`firestore.rules`, which grants read to admins only. This has now bitten three times
(`alerts`, `payment_methods`, and the general class), and each time the client's
`catchError(() => of([]))` converted a permission-denied into a plausible empty state.

**Consequences:** owners may read, clients may never write (the Admin SDK bypasses rules, so a
client that could write would forge its own security notices); and an empty state must never be
reachable from a swallowed error — log the failure with the path and the uid.

### 5. The user document is the cache for per-login facts

New-login-location detection reads `users/{uid}.knownCountries`, which the same request already
fetches for the notification opt-out. It previously scanned `loginSessions` by `userId` — up to
20 full session documents, awaited inside the login response, with no `orderBy`, so the sample
was an arbitrary old slice of history that degraded as the collection grew. Redis holds the
revocation and device-trust fast paths, but those caches must not be the only place a **state**
is recorded: a cache that stores only the rare answer (revoked) pays full price on the common
one.

### 6. Account erasure is a schedule, not a request

`requestMyAccountDeletion` mails a code; `confirmMyAccountDeletion` locks the account and sets a
deadline (30 days self-service, 7 admin); only the nightly `purgeDeletedAccounts` erases
anything. The policy is pure functions in `account-deletion.domain.ts` so the destructive path
is testable without an emulator, the refusals are `last_platform_admin` and
`sole_owner_of_shared_org`, and every action writes an append-only `admin_audit` record.

**Consequences:** erasure is irreversible by design, so the kill switch is the schedule, not a
flag. `admin_audit` is admin-read and never writable; `deletion_requests` is closed in both
directions, because a readable hash is a crackable code and a writable record is minted
authority.

### 7. Commit history is the review surface

Conventional commits validated by commitlint on a `commit-msg` hook, released by
semantic-release on push. Commits are cut with an explicit pathspec — `git commit -- <paths>` —
because this tree routinely carries dozens of unrelated modified files and a bare `git commit`
captures all of them. Deletions and removals get their own commit: a dead component still
compiles, so it is found by the next person grepping for a card form, and they fix the wrong
one.

## Consequences and open items

- The knowledge graph is 14 commits stale and must be refreshed before it can be trusted for
  structure queries; the MCP server also needs this root re-allowed.
- `src/app/pages/user/billing/transactions/**` is orphaned — no route, no nav entry, and dead
  i18n keys. Delete it or restore the route; leaving it is the failure mode decision 7 names.
- `getBillingUsage` still returns `invoices[]` and `payments[]` arrays the usage page ignores.
- The card mirror (decision 3) is the strongest candidate for deletion in favour of a live
  `paymentMethods.list` call resolved from the caller's token, which would also make a
  uid/path mismatch impossible.

## Residual risk: our crawl guard runs before the fetch, not on it (2026-09-30)

`crawl4aiCore` validates the target list before handing the job on: scheme allowlist
(`http`/`https` only), a private-space host blocklist (RFC1918, link-local, `::1`,
IPv6 `fc00::/7`, `.local`, `.internal`), a 2048-char cap and a 50-URL cap. That closes
the direct read primitive — `POST /api/crawl {"urls":["http://169.254.169.254/latest/meta-data/iam/"]}`
no longer returns the metadata body.

It does **not** cover redirects. The guard inspects the URL we submit; the crawler makes
the connection. A submitted public URL that 302s to `169.254.169.254`, or to any internal
host, is followed and the private body returns as crawl output. Re-validating each hop has
to happen where the socket is opened, which is not here.

Verified 2026-09-30: this cannot be fixed in deepscrape **or** arachnefly. arachnefly has
no redirect handling at all — a project-wide search for `CheckRedirect`, `Location` and any
redirect re-validation returns nothing — because its crawl path only replays a request onto
the tenant's machine (`fly-replay: instance=<id>`) and forwards the body verbatim. The fix
belongs to the crawler itself: the shared agent for shared traffic, and the tenant container
for paid traffic.

Until it lands there, treat the blocklist as defence in depth, not as an SSRF boundary, and
do not describe the crawl path as redirect-safe.

## Crawl egress is same-origin from the browser (2026-09-30)

`CrawlAPIService` and `SeedingService` both built their endpoint as
`environment.API_CRAWL4AI_URL + '/api/v1'` in production — a third-party origin that then
received the caller's Firebase ID token on every one of their methods, and which could not
have worked regardless: the production CSP `connect-src` does not allow that host, and
`bff/security.ts` records that Hosting is the only emitter of CSP.

Both now use the relative `API_CRAWL4AI_URL` base in every configuration, so the token
never leaves our origin and there is exactly one door. The two env keys they used
(`environment.API_CRAWL4AI_URL`, `environment.CRAWL4AI_API_KEY`) were deleted once nothing
read them.

Consequence for the paid tier: a tenant's **custom container URL must stay server-side**.
If the client ever holds that URL and the user's token, the paid path re-opens exactly the
leak this closed. The paid path therefore goes
`browser → BFF → POST /api/machines/execute-task/:machineId → arachnefly → tenant container`,
which also removes user-supplied-URL SSRF. The shared agent is reached at
`bff/api.ts`'s `/api/crawl` instead.

### The shared worker's auth contract (verified 2026-09-30)

Verified by running the worker locally (`webrain mcp --http 9333` with `WEBRAIN_HTTP_TOKEN`
set) and probing it, rather than by reading alone:

| Request | Result |
|---|---|
| `GET /health` | 200 — unauthenticated by design |
| `POST /` with no `Authorization` | 401 |
| `POST /` with a relayed end-user Firebase token | **401** |
| `POST /` with the server-held secret | 200 |
| `POST /` with lowercase `bearer` | 200 |

So `crawl4aiCore` relaying the caller's bearer was not only a leak — it was a **401**. The
worker wants `Authorization: Bearer $WEBRAIN_HTTP_TOKEN` (`webrain-mcp/src/lib.rs`, constant
time, scheme case-insensitive). It now sends `env.CRAWL4AI_API_KEY`, matching what
`jinaAICrawl` in the same file already did.

That is also the real reason the key was a silent no-op: `CRAWL4AI_API_KEY` was declared
only in `src/config/env.ts`, while `functions/src/config/env.ts` — the module the handler
actually imports — never declared it, so there was nothing to resolve. It is now declared in
both. Two env modules exist, not three, and they have drifted; de-duplication is tracked
under Phase 3.3. In production the key must be present in the `FUNCTIONS_ENV_JSON` secret or
the shared crawl path answers 401.

`CrawlAPIService`'s job/stream siblings (`getTaskId`, `getTaskStatus`, `cancelTask`,
`multiCrawlEnqueue`, `streamTaskResults`) stay relative and will 404 until the worker is
deployed and the BFF routes are added. They were already non-functional — the host serving
them is not deployed — so this is not a regression. `CrawlerHandler` in
`functions/src/handlers/crawler.ts` still relays `req.app.locals["user"]` and must be
switched to the same credential when those routes are wired.

## Tenant endpoints are arbitrary Fly URLs (2026-09-30)

Decision: a paid tenant's worker lives at an **arbitrary `*.fly.dev` URL**, not under a
deepscrape-owned hostname. Three verified consequences, each measured rather than assumed.

**1. CSP cannot whitelist the tenant.** A static policy cannot name per-tenant hosts, so
`connect-src` must open the provider's domain (`https://*.fly.dev`, `https://*.fly.io`) and
CSP stops being a tenancy control on this path. The boundary becomes the container itself,
plus `WEBRAIN_NO_STATE=1` on shared workers, plus the per-request credential check. Be
honest about the trade: `script-src` already carries `'unsafe-inline' 'unsafe-eval'`, so CSP
was never the last line — but opening the provider domain is still a real widening and must
not be described as a boundary.

Measured: the policy is **three byte-identical 1569-char strings**, one per hosting target
(`marketing`, `dashboard`, `console`), so the edit is a coordinated 3x change. A partial
update leaves one surface working and another blocked, and because CSP failures only appear
in a browser, nothing catches it in CI. Nothing tests or pins the policy today — adding that
check belongs with the change, so "did you update all three?" becomes mechanical.

**2. The browser cannot derive the endpoint.** `Machine` / `FlyMachine`
(`src/app/core/types/machine.interface.ts`) carries `id`, `instance_id`, `private_ip`,
`region`, `state`, `image_ref` and `config` — and **no public address, no app name, no URL**.
The Fly app name exists only in arachnefly's own config. So the worker endpoint must either
be stored on the machine record or resolved for the client; it cannot be computed from what
the client already receives.

**3. Resolution is a lookup, not a proxy.** Fetching the endpoint once and caching it in
Redis preserves the one-hop rule: the BFF authorizes and resolves, then the browser moves
the crawl traffic straight to the worker. Proxying every request through Cloud Run is
precisely what must not happen — it bills Cloud Run and the container for the same request,
which is the multi-tier pricing this decision exists to avoid.



