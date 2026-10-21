# Must-fix ledger — deepscrape platform

**Rewritten 2026-10-21.** This file is no longer an audit report; it is a status ledger.

Two things were removed, deliberately:

1. **Lines 1–7,300-odd of a pasted tool transcript** that preceded the audit body. It was
   not documentation, it was a session log, and it is what made this file 8,595 lines.
2. **Every item that is closed.** Their number, title and paragraph described files that
   have since been rewritten; keeping them invited "closing a number" instead of fixing a
   defect. Git history has the originals.

## How to read this

- **Status** is one of `open`, `verify`, `decision`.
  - `open` — I read the code and the defect is there today.
  - `verify` — the audit's claim did not reproduce as written; the item needs re-deriving
    from source before anyone acts on it.
  - `decision` — the defect may be real, but the fix changes money, a public contract, or
    user-visible behaviour, so it is not mine to take.
- **Do not work this list in numeric order.** The numbers are the old audit's, kept only so
  a commit message can reference them. Order by blast radius: request path → money →
  trust boundary → correctness → polish.
- **Evidence rule.** An item without a current `file:line`, or whose premise I could not
  reproduce, is not actionable. Line numbers rot within days in this repo; re-locate
  before editing.

## Ranked open work

### 1. Request path / product dead ends

| # | Status | What | Where |
|---|---|---|---|
| 81 | open | `isAuthenticated()` re-runs the whole login per subscriber (Firestore read, forced `getIdTokenResult(true)`, a callable) and writes `token`/`userSubject` as a side effect. `AppComponent` subscribes once and `authGuard` again, so a cold load of a protected page pays it twice and the two chains race on one `BehaviorSubject`. Its `catchError` also turns any transient failure into "signed out". | `core/services/auth.service.ts` (isAuthenticated) |
| 87 | open | The full Firebase ID token is placed in the WebSocket URL: `?token=${jwtToken}`. Ends up in proxy/CDN/access logs and is replayable by anyone who can read them. `websocket.service.ts` documents this as the reason the old transport was removed. | `core/services/webrtc.service.ts:111`, `:163` |
| 120 | open | `deepscrape-bff-*.run.app` is `--allow-unauthenticated` and serves the app directly with no CSP and no HSTS, because `security.ts` omits `helmet` on the stated assumption that only Hosting's CSP reaches a browser. Its own comment names the hole. | `bff/security.ts`, Cloud Run deploy flags |

### 2. Money under concurrency

| # | Status | What | Where |
|---|---|---|---|
| 58 | open | Two caps, one counter: `SESSION_CAPS.paid` is `{dedicated: 1, byo: 3}`, but one `liveSessions` number is compared against both — three free BYO sessions block the dedicated machine the customer pays for. | `domain/browser-session.domain.ts:52-64` |
| 59 | decision | `machinesToRelease` is written at erasure and **read by nothing**, a retry can overwrite it with `[]`, `users/{uid}/machines` is never enumerated, and stopping a machine needs a service credential because machine control relays the caller's token. | `gfunctions/admin-users.ts` |
| 69 | decision | `blob-purge` now reports `complete`, but `purgedAt` and the `purgeAfter` correction are two writes: a crash between them restores the original false "erased" claim. One-line fix, lands in `admin-users.ts`. | `gfunctions/admin-users.ts` ~1578, ~1598 |
| 74 | decision | Shared-tier objects are immortal: first anonymous fetch is served forever, `storageDelete` refuses shared keys. Egress half is fixed; this needs a retention window (7 vs 30 days) nobody has chosen. | `handlers/storage.ts`, `domain/storage-scope.domain.ts` |
| 133 | open | Event ingress capacity is ~2,000/hour and silently drops the oldest: the drain commits 1,000 per half hour into a head-trimmed list. | `src/config/redis-keys.ts` (`CLIENT_EVENT_LIST_MAX`) |
| 134 | decision | `byIP.<raw address>` is an uncapped dimension on `metrics_daily`, `metrics_hourly` and the dashboard singleton. Near 1 MiB the **whole batch** fails, taking `newGuests` and every funnel counter with it. Fix is per-(day, IP) documents, which three readers depend on. The audit pointed at the wrong file. | `gfunctions/analytics-realtime.ts` |

### 3. Correctness users see

| # | Status | What | Where |
|---|---|---|---|
| 61 | open | Every session read is a full subcollection scan, twice per create; closed records are never pruned, so cost grows with account age. | `infrastructure/browser-session.store.ts` |
| 67 | open | A retry appends a second row for one target (`arrayUnion` on an element carrying `ms`/`data` dedupes equal values only), and `deriveStatus` mixes row counts with URL counts — two failures plus one duplicate `ok` row reads as `Failed` with a page actually scraped. Needs one doc per target keyed by `sha1(url)`. | `handlers/webrain-jobs.ts` |
| 89 | open | The service worker activates on `VERSION_READY` and immediately `location.reload()`s, destroying unsaved state mid-crawl or mid-checkout, triggered by someone else's deploy. | `core/services/ngsw-update.service.ts` |
| 99 | open | One machine page change costs two billed callable reads, and a jump to page *n* costs *n+1*: the cursor chain is walked then thrown away. | `core/services/machine-store.service.ts` |
| 124 | open | Meilisearch sits in `fra` while the BFF is in `us-central1`; every `/api/search` pays ~110 ms RTT before any work. | `deploy/meilisearch/fly.toml` |

### 4. Decisions

| # | Status | The decision |
|---|---|---|
| 43 | decision | `resolveIdentifier` returns the account's real email to anonymous callers. The audit's "return `maskEmail`" is **not viable** — that helper is private and masking breaks username/phone login. Real fix is proof of ownership (send a code, or verify the password in the same request and mint a custom token). |
| 53 | decision | An empty wallet disables the 20-credit ceiling: the ceiling check sits *after* the charge inside the same `try`, so a zero balance throws and jumps to `catch`. Fix changes when a session is stopped. |
| 62 | decision | `mode:"byo"` and `kind` are dead — the CDP URL is written to Secret Manager and never read, `kind` never reaches `machineRequestFor`. A **shipped client sends both**, so removal is a client regression and wiring is a new transport. |
| 95 | decision | `LoggerService` patches global `console` as a module side effect. Redaction is fixed (all arguments, nested, cycle-safe); the patch itself should move behind an explicit opt-in initialiser. |
| 105 | decision | `PackService` is `providedIn:'root'` with a constructor token that has no root provider, so three components `new` it: each tab switch builds a fresh instance, refetches, and `ngOnDestroy` never runs. |
| 113 | decision | `listMyOrganizations()` has a write side effect that races `AuthzService.refreshMemberships()` for the active tenant. |

### 5. Needs re-deriving from source

These did not reproduce as written. Do not act on the audit text.

| # | What the audit says | What I found |
|---|---|---|
| 48 | Two answers to "is this platform admin": `admin-users.ts` accepts `superadmin`, the middleware does not. | `superadmin` is handled in `gfunctions/sessions.ts` and `gfunctions/admin-users.ts`; the cited lines have moved. Re-derive before changing authz. |
| 49 | The `/oauth` layer is mounted twice and `authproxy.ts` is dead. | `authproxy.ts` is indeed not mounted by the BFF; whether the duplicate mount matters needs the current route table. |
| 50 | "App Check is off everywhere." | `APP_CHECK_ENFORCED` and `applyAppCheckPolicy` exist in `callable-limiter.ts`. That is a config question, not a missing guard. |
| 60 | "The money paths have no test." | Six store-side specs now exist (caps, watch, cdp-host, provisioner, request, machine). `handlers/browser-sessions.ts` still has none. |
| 35 | Two copies of "find the price on an invoice line". | Not verified. Low value. |

## Refused — checked, not defects

Recorded so they are not re-attempted. Each was read in source.

| # | Why it is not a fix |
|---|---|
| 33 | The two Stripe round-trips are already behind `Boolean(user?.stripeId)`; a caller with no Stripe customer makes none. |
| 47 | The WHATWG URL parser already normalises `2130706433`, `0x7f000001`, `0177.0.0.1`, `0` to loopback before the guard sees them. The prescribed check would be dead code. |
| 52, 56 | A stop is already terminal in `keepaliveBrowserSession`, and every session→machine path already fails on `closed`. |
| 54 | `applyBillingCreditMutation` already returns `replayed`, and `consumeBillingCredits` already returns `null` for it. |
| 64 | The frame route already refreshes through `shouldRefreshOnWatch`, stop-aware and throttled. |
| 65, 68 | `terminalFrameStatus` and `finishedJobStatus` already exist and refuse a finished cancel. |
| 66 | The page-state guard exists in `webrain-mcp.ts` before any worker is acquired. `webrain_observe` **was** missing from it and is now covered. |
| 108 | "Today" is not a UTC date bug: the local-day key queries a document that never exists. |
| 116, 119 | Rules/indexes already deploy from the merge workflow; `no-cache` is already set for HTML, `ngsw.json` and `ngsw-worker.js` in all three hosting blocks. |
| 125 | `vite.config.ts` is dead; the postcss half is not. |
| 126, 127 | No `dataGroups` and `/index.html` is mandatory; the codemods are manual and referenced by no CI job. |
| 137, 138 | Exporting `trackGuest` double-counts every registration. Four analytics helpers are wired by their spec — deleting them broke the suite. |

## Closed in this campaign

Numbers only; the paragraphs were stale and are in git history.

§1 BFF `13 14 15 16 17 18 19 21` · §2 billing `22 23 24 25 26 27 28 29 30 31 34` ·
§3 auth `36 37 38 39 40 41 42 44 45 46 51` · §4 sessions `55 57 63` ·
§5 crawl/storage `70 71 72 73 76 78 79 80` · §6 Angular core `82 83 84 85 86 88 90 91 92 93 94 95(redaction)` ·
§7 features `96 97 98 100 101 102 103 104 106 107 109 110 111 112` ·
§8 deploy `114 115 117 118 121 122` ·
§9 analytics `129 130 131 132 135(docstring) 136(tests)`.
