# Must-fix ledger — deepscrape platform

**Rewritten 2026-10-21.** This file is no longer an audit report; it is a status ledger.

**Status re-verified 2026-10-21 against the code, in a working terminal.** What that proves and
what it does not:

| Ran | Result |
|---|---|
| `functions` build / lint / test | 0 / 0 errors (8 pre-existing warnings) / 974 tests, 965 pass, 0 fail, 9 skipped |
| `app` `tsc --noEmit -p tsconfig.app.json` | 0 |
| `app` `bun run build` | 0, 14 routes prerendered — the only template and SSR gate |
| `app` Karma | 902 / 902 (900 + the 2 auth specs added when #81 closed) |
| `bff` `tsc --noEmit` / `bun test` | 0 / **83 tests, 0 fail** |
| `arachnefly` `go build` / `go vet` | 0 / 0 |
| `crawlagent` `compileall` | 0 |

Not run today: any profiling, any bundle measurement, `gcloud describe`, and a preview deploy —
so the suite is green in **all four code surfaces**, and green says nothing about production
configuration.
Rows were re-read against source; only the rows marked *(re-proved 2026-10-21)* were re-checked
end to end. The rest still carry their original evidence and could be stale.

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
- **Work the list in the order given, not by audit number.** The audit numbers are kept only
  so a commit message can reference them; the work list below is easiest-first (1 = smallest
  verified change). `Risk` is a column, so a one-line money item still gets its own proof even
  though it is small.
- **Evidence rule.** An item without a current `file:line`, or whose premise I could not
  reproduce, is not actionable. Line numbers rot within days in this repo; re-locate
  before editing.

## Re-audit 2026-10-23 — production readiness, money, and surfaces that promise what is retired

Run against the working tree after `crawl4ai` was retired (`23-crawlagent-second-provider.md` §24).
Four measurements were made rather than re-read: `scripts/route-parity.ts` (81 BFF routes / 29 client
bases / **0 client calls with no route** / 6 routes with no client), both Stripe accounts' price
lists, the webrain tier sets in `domain/webrain-tools.domain.ts`, and the `/operations` enqueue path.
Everything else is cited.

| # | Sev | Status | Finding |
|---|---|---|---|
| **R1** | critical | **fixed** | `/operations` ran on a retired engine's config; Run was a silent no-op on a fresh account. |
| **R2** | ops | **closed** | Price fallbacks are test-account ids; every `STRIPE_PRICE_*` is confirmed bound on the production revision (2026-10-23). |
| **R3** | — | **fixed** | Enterprise pricing drift between the accounts; test brought to the live floor. |
| **R4** | high | **fixed** | Three tool tabs advertised a capability whose door is deliberately locked. |
| **R5** | high | open | The crawl job SSE routes have no consumer, by a documented choice — so the expensive poll carries the whole document. |
| **R6** | info | recorded | Three credential/capacity clients my earlier audit called missing are in fact wired. |

### R1. `/operations` ran on a retired engine's config — FIXED 2026-10-23

Two faults compounding:

- `enqueueCrawlOperation` → `multiCrawlEnqueue(urls, operationData, pack)`, and the service built the
  body as `{ urls, operation_data, ...crawlPack.config.value }`. The job route is served by webrain
  (`handlers/webrain-jobs.ts:3`), which reads neither `crawler_config` nor `browser_config`, so every
  setting the operator chose was transmitted and discarded.
- Run **refused** without a pack. Once `/crawlpack` began redirecting, no pack could be created, so a
  fresh account's Run was an early `return` with no message at all — a silent no-op on the most
  obvious button in the product.

Four small edits, and the first one is the root cause:

| File | Change |
|---|---|
| `core/services/crawlapi.service.ts` | `multiCrawlEnqueue(urls, operationData)` — the third parameter and the `...crawlPack.config.value` spread are gone. This is the only place the body is built, so both callers were fixed at once. |
| `pages/user/operations/operations.component.ts` | the `if (!pack) refuse` guard deleted; `enqueueCrawlOperation(operationData)` |
| `core/components/app-crawl/app-crawl.component.ts` | `submitCrawlJob` no longer refuses on a default pack selection; the pack is no longer passed |
| both `.html` files | the pack picker deleted, and with it the `SETUP_CONFIGURATION *` link that pointed at the retired editor while marking the choice required. `app-crawl` keeps its stream toggle, which lives in the same branch. |

Specs moved with the code rather than being deleted: the old `refuses Run without a pack` and
`should stop submit when crawl pack selection is default` now assert the opposite, and
`crawlapi.service.spec.ts` pins the body's key set to exactly `operation_data` + `urls`, so a
crawl4ai-shaped field cannot come back unnoticed.

Gates: app `tsc --noEmit` 0 · `bun run build` 0 (templates + prerender) · Karma **904 / 904**.

Left behind deliberately: `packsByCode`, `loadCrawlPacks`, `crawlConfigPack`, `crawlpack`,
`crawlPackSelector` and `openJsonFormat` in `app-crawl` are now unreferenced. `loadCrawlPacks` is the
only one with a cost — one ≤10-document read plus a `localStorage` write on every playground mount,
with nothing reading the result.

### R2. The test-account price fallbacks are a KNOWN, MONITORED condition — ops item, not a code gap

I first filed this critical and was wrong to: the mechanism is documented in the module that owns it.

- `functions/src/app/stripe-price-resolution.ts` header states it outright — *"the catalog used to
  carry hardcoded `price_…` ids, and Stripe ids do not cross modes. The 14 ids in the catalog are
  test-mode … so a live deployment with unset env vars failed every checkout with 'No such price'.
  Lookup keys are mode- and environment-independent."* `resolvePriceId` resolves by `lookup_key`
  first and falls back to the hardcoded id **on purpose**, so a miss degrades rather than breaking
  checkout, and logs `[billing] lookup_key … not found in this account`.
- It is watched: `checkStripeCatalogHealth` (`stripe.ts:4642`, hourly) walks every sellable price and
  records a `billing_incidents` row for each one that could not be sold, with a cooldown.
- **Residual was an OPS item — CLOSED 2026-10-23.** The fallbacks are still
  `env.STRIPE_PRICE_* || "price_1UHr…FVGcR0rD8f…"`, and `FVGcR0rD8f` is the test account while live
  is `FBBAUAyJFB`, so an unbound variable would have shown a customer `No such price` before the
  incident row. **The operator confirmed every `STRIPE_PRICE_*` is bound on the production revision**,
  which is the only check that could have closed this. Refusing in production instead stays
  **declined**: converting a degraded checkout into a hard one trades a visible Stripe error for an
  outage.

### R3. Enterprise pricing drift between the accounts — FIXED in TEST 2026-10-23

Live `acct_1OELbFBBAUAyJFB` was the reference and the **code already matched it**
(`billingPlanCatalog` prices Enterprise at 9900 / 27900 / 99900 minor units, no `stripePriceId`,
`salesLed`, `unlimited`). Test was the stale side; it now matches.

| | Test `acct_1Qag9KFVGcR0rD8f`, before | Test, after |
|---|---|---|
| Enterprise monthly | 49.99 active, product default | **99 active** `price_1UTTGQFVGcR0rD8fB8c7KHWJ`, `ds_enterprise_monthly`, product default |
| Enterprise quarterly | 149.99 active | **279 active** `price_1UTTHSFVGcR0rD8fgpPrMu1r`, `ds_enterprise_quarterly`, **`interval_count: 3`** |
| Enterprise annual | 499.99 active | **999 active** `price_1UTTGPFVGcR0rD8fwXj5UyHM`, `ds_enterprise_annual` |
| the three old ones | — | archived, nicknamed `superseded 2026-10-23`, lookup keys cleared |

Verified by re-reading `GET /v1/prices?product=prod_U5l65btpkNeKPm`: exactly three active prices, all
at the live floor. Starter, Pro and the credit packs were already identical in both accounts.

Two things paid for in the doing:

- **A price that is a product's `default_price` cannot be archived.** Move `default_price` first
  (`PostProductsId` — `PostProductsProduct` does not exist).
- **`interval_count` is part of the parity contract, not just the amount.** Quarterly is
  `interval: month, interval_count: 3`; re-creating it as `count: 1` sells 279 EUR **every month**.
  The first replacement I wrote did exactly that and had to be archived.
- Residual: `tax_behavior` is immutable after creation, so two re-created floor prices are
  `unspecified` where live is `inclusive`. Harmless — no code path resolves an Enterprise price id,
  because the tier is refused before resolution. Do not "fix" it in code.

### R4. `batch` / `spider` / `watch` promised what the guard refuses — FIXED 2026-10-23

Corrected while fixing it: it was **three** tabs, not two, and the note mechanism was not what the
code said it was.

- **What the code claimed:** the comment above `costs` read *"`vision` and the three capacity tools
  (`batch`, `spider`, `watch`) are PAID routes, so their `note` says so in words rather than the box
  implying 'free, so it works'."*
- **What was true:** `NOTE_BATCH` never used the word paid, `NOTE_SPIDER` never did, and neither
  mentioned the lease. Meanwhile `bff/api.ts:443-465` says of batch and spider — *"These two
  therefore answer a refusal until an exclusive pool exists. The door is built and locked on
  purpose."* So the panel shipped three tabs whose only possible answer was a refusal, with nothing
  on screen explaining why or what would change the answer.
- **The fix uses the mechanism that already existed** instead of adding a badge component: three rows
  in the `costs` table, which the template already renders as `TOOLS.REQ_LEASE` + a credit price +
  `TOOLS.LEASE_COST`. Credits are `billing-pricing.domain.ts`'s own numbers — 3, 10, 5 — so nothing
  was estimated. The row type gained `paid?: boolean`, rendered with an existing string
  (`FEATURE_GATE.REQUIRES_PLAN_TITLE`) so **no locale was touched**: a free caller's remedy is an
  upgrade, a paid caller's is a machine, and the two had been collapsed into silence.
- The stale comment was rewritten rather than left contradicting the table; `vision` is now the only
  tool with no row, deliberately, with the reason stated.

Gates: app `tsc --noEmit` 0 · `bun run build` 0 · Karma **904 / 904**.

### R5. The SSE job routes have no client, deliberately — so make the poll cheap — OPEN

- **Measured:** `scripts/route-parity.ts` → 6 routes with no client: `/api/download` (capacity tool,
  no UI, intentional) and five job routes (`/api/job/:taskId/cancel`, `/api/job/stream/:taskId`,
  `/api/job/stream/status/:taskId`, `/api/jobs/crawl/failed`, `/api/jobs/crawl/worker`).
- **Not a defect:** `websocket.service.ts:45-46` documents the choice — *"same data as SSE at
  `GET /api/job/stream/status/:taskId` … So this class is now a [poller]"*. The QStash targets are
  server-to-server by definition.
- **What it means:** the platform pays for the cheap transport's absence. The polled route is
  `getTaskStatus` on a document holding every item's `data` (`handlers/webrain-jobs.ts`), which is
  O16 in `21-optimizations.md`. So O16 is not an optimisation, it is the bill for choosing polling.
  The fix is O16 option 1 (pre-serialise each item's `data` at write time) plus a `liveStatus` field
  so the status read never touches `items` — a schema change, not a client feature.

### R6. Three "missing clients" are wired — recorded so they stop being re-derived

My 2026-10-11 note said no Angular code sent `store`/`load` to the durable vault. It does:
`core/services/browser-session.service.ts:195-218` posts `POST /api/browser/vault`. Same round:
`/api/storage/*` has `bucket-storage.service.ts` plus three AI tool entries, `/api/compute` has
`compute.service.ts` (mounted in the settings general tab), `/api/admin/machines` has
`machine-fleet.service.ts` behind the platform-admin route. `/api/vision` is registered
(`bff/api.ts:488`) — the 404 it used to answer is closed.

## Work list — easiest first

Ordered by what the change costs: files touched, then the gate that proves it, then whether a
decision is needed at all. Blast radius is a column, not the sort key — "easy" is about the size
of the diff, never about how much damage a wrong one does.

| Do | Audit # | Size | Risk | What | Proof / blocker |
|---|---|---|---|---|---|
| 1 | 58 | S | money | **Fixed 2026-10-21 — after one wrong verdict here.** `decideLease` compares a single `liveSessions` number against both caps. The count *inside* `createBrowserSession` is per mode, so the first read of this said "not a defect". It is: the **pre-flight in `browserSessionCreate`** passed `listBrowserSessions(uid).length`, which counts both modes — three free BYO sessions refused the dedicated machine the caller pays for. The fix is `countLiveForMode(live, mode)` in the domain, so both call sites share one rule. | `domain/browser-session.domain.ts` (`countLiveForMode`), `handlers/browser-sessions.ts:241`. Gates: functions build 0, lint 0 errors, **976 tests / 967 pass / 0 fail**, two new specs. |
| 2 | 120 | S | trust boundary | **Half fixed 2026-10-21.** The BFF now emits `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin` on every response — raw `Response` handlers included, which is the case a hook usually misses — and `Strict-Transport-Security` in production only, because HSTS from localhost pins the developer's browser to https with no way back. **CSP stays Hosting's:** its own comment in the file records that a nonce policy here would block the CSR shell, so the remaining gap is a CSP for a direct `.run.app` request, which needs a policy chosen deliberately. | `bff/security.ts` `onAfterHandle`; `bff/security.spec.ts` asserts all four, and that HSTS is absent without `PRODUCTION`. Gates: bff tsc 0, 83 tests 0 fail. |
| 3 | 60 | M | money | **Half fixed 2026-10-21 — and the blocker recorded here was wrong.** Importing `handlers/browser-sessions.ts` works under `tsx` with no credentials (measured: `IMPORT_OK`), so "builds the Admin SDK at import" was never the obstacle. What needs an emulator is the **I/O**: `db` is imported straight from `app/config` and called inside the store functions, and there is no injection seam. The decisions that run *before* any I/O are now pinned, and neither had a spec: `refusalFor` (every reason answers a 4xx with a sentence; quota is 429, a byo request with no endpoint is 403 — collapsing them is what makes a support ticket) and `parseCreateRequest` (bad mode, unknown engine **at runtime**, and an absent/blank/trimmed `cdpUrl`). | `domain/browser-session.domain.ts`; **7 new specs**. Gates: functions build 0, lint 0 errors, **983 tests / 974 pass / 0 fail**. Remaining: attach/close/keepalive behaviour, which still needs an emulator or a seam. |
| 4 | 89 | S | user data | **Fixed 2026-10-21, with the conservative half of the choice.** The worker still activates immediately, so the next navigation gets the new assets, but the page reloads **only while the tab is hidden** — someone else's deploy can no longer wipe a half-typed checkout in front of the user. The better end state is prompt-then-reload, and it stays open: it needs a string in five locales plus a snackbar action. | `ngsw-update.service.ts`; the spec asserts reload-when-hidden and **no** reload-when-visible. Gates: app tsc 0, `bun run build` 0 (14 routes prerendered), Karma **903**. |
| 5 | 67 | H | correctness | A retry appends a second row for one target, and `deriveStatus` mixes row counts with URL counts. | One document per target keyed by `sha1(url)` — schema change plus migration. |
| 6 | 87 | H | security | **Fixed 2026-10-22 — the leak was dead code.** `reconnect()` was the only place that put an ID token in a URL (`/ws/:id?token=`), and **nothing called it** — `connect()` is the only entry the live viewer uses. Deleting the method removes the leak with no transport change. The `?token=` on the `connect` path was already only a comment. What remains is neko's own `password=`/`username=` query pair, which neko's upgrade handler requires: that is server-side auth to build, not a client fix. | `src/app/core/services/webrtc.service.ts` (`reconnect` deleted). Gates: app tsc 0, `bun run build` 0 (14 routes prerendered), Karma 904/904. |
| 7 | 134 | H | cost | `byIP.<raw address>` is uncapped on `metrics_daily`, `metrics_hourly` and the dashboard singleton; near 1 MiB the **whole batch** fails. | Three readers depend on the shape, so it is a schema change. |

### Verified as nice-to-have — do not start these next

Each was checked in source on **2026-10-21** and the cost-to-benefit went the wrong way. The reasons
are recorded so nobody re-derives them into a defect.

| Audit # | Why it is not worth doing yet |
|---|---|
| 61 (remainder) | The create's transaction does read a **query** whose range a keepalive updates, so a poll can abort and replay it — but `keepaliveBrowserSession` reads and writes **one document** (`transaction.get(ref)`), a create is one fast transaction, and the SDK retries on contention. The prescribed counter document would add a second source of truth for a cap that decides **money**, to remove a retry the SDK already hides. The scan half was the real cost, and it is fixed. |
| 99 | Cursors are **persisted, not discarded**: `getCursorStore` hands back a per-state `Map` held on the service, and the walk writes every intermediate page (`cursorStore.set(knownPage + 1, …)`). A repeat jump and a forward step cost one callable each; only the *first* jump to a far page costs *n−1*, once per service instance. |
| 133 (remainder) | Capacity is right — `CLIENT_EVENT_MAX` **200** × `DRAIN_CHUNKS_PER_RUN` **5** = 1,000 events per run, twice an hour — and the constants live in **`src/config/redis-keys.ts:132-144`** (repo-root `src/`; an earlier note here "corrected" that to `functions/src/config/`, which does not exist — **the original citation was right**). The multi-chunk loop already landed after the 2026-09-14 backlog measurement (4.6k of a 5k cap), so what remains is only "ingress above ~2,000/hour trims the oldest", which wants a real ingress number before anyone spends Firestore writes on it. |

Verify-only rows cost a lookup rather than a change — see *Needs re-deriving from source* below.
#50 is the one that cannot be settled here at all: it needs the deployed `FUNCTIONS_ENV_JSON`.
Since 2026-10-22 that question is a `curl`, not a secret read: `GET /status` reports the
presence (never the value) of `WEBRAIN_MCP_URL`, `WEBRAIN_MCP_TOKEN` and `BROWSER_MACHINE_IMAGE`
as `browser.engineUrl` / `engineToken` / `machineImage`. **The path is `/status`, not
`/api/status`** — it and `/services/contact` are the two public routes the api group carries,
every other route spells its own `/api/...`. Verified in production the same day:
`https://deepscrape.dev/status` answers `production=true`, `trustProxy=true`,
`rateLimitStore=redis`; the `browser` block appears only after the next deploy.

## Decisions — not mine to take


| # | Status | The decision |
|---|---|---|
| 43 | decision | `resolveIdentifier` returns the account's real email to anonymous callers. The audit's "return `maskEmail`" is **not viable** — that helper is private and masking breaks username/phone login. Real fix is proof of ownership (send a code, or verify the password in the same request and mint a custom token). |
| 53 | decision | An empty wallet disables the 20-credit ceiling: the ceiling check sits *after* the charge inside the same `try`, so a zero balance throws and jumps to `catch`. Fix changes when a session is stopped. |
| 62 | decision | `mode:"byo"` and `kind` are dead — the CDP URL is written to Secret Manager and never read, `kind` never reaches `machineRequestFor`. A **shipped client sends both**, so removal is a client regression and wiring is a new transport. |
| 95 | decision | `LoggerService` patches global `console` as a module side effect. Redaction is fixed (all arguments, nested, cycle-safe); the patch itself should move behind an explicit opt-in initialiser. |
| 105 | decision | `PackService` is `providedIn:'root'` with a constructor token that has no root provider, so three components `new` it: each tab switch builds a fresh instance, refetches, and `ngOnDestroy` never runs. |
| 113 | decision | `listMyOrganizations()` has a write side effect that races `AuthzService.refreshMemberships()` for the active tenant. |
| 59 | decision | `machinesToRelease` is written at erasure and **read by nothing**, a retry can overwrite it with `[]`, `users/{uid}/machines` is never enumerated, and stopping a machine needs a service credential because machine control relays the caller's token. |
| 69 | decision | `blob-purge` reports `complete`, but `purgedAt` and the `purgeAfter` correction are two writes: a crash between them restores the original false "erased" claim. One-line fix, lands in `admin-users.ts` ~1578/~1598 — held back because it changes what erasure claims. |
| 74 | decision | Shared-tier objects are immortal: the first anonymous fetch is served forever and `storageDelete` refuses shared keys. Egress half is fixed; this needs a retention window (7 vs 30 days) nobody has chosen. |

## Needs re-deriving from source

These did not reproduce as written. Do not act on the audit text.

| # | What the audit says | What I found |
|---|---|---|
| 48 | Two answers to "is this platform admin": `admin-users.ts` accepts `superadmin`, the middleware does not. | *(re-proved 2026-10-21)* `superadmin` has **0** matches in `infrastructure/authz.middleware.ts`, and is handled in `gfunctions/sessions.ts` and `gfunctions/admin-users.ts`. So two readers of the role exist. Before changing authz, find out whether `superadmin` is claimed at all — if nothing mints it, the middleware branch is the only live one and this is dead vocabulary, not a hole. |
| 49 | The `/oauth` layer is mounted twice and `authproxy.ts` is dead. | *(re-proved 2026-10-21)* "Dead" does not hold: `authproxy` is referenced from `bff/oauth.ts:22` and from the functions entry, so something does reach it. The duplicate-mount half still needs the current route table, and the BFF is the only table that is served. |
| 50 | "App Check is off everywhere." | *(re-proved 2026-10-21)* `APP_CHECK_ENFORCED` appears twice in `infrastructure/callable-limiter.ts`, so the guard and its policy switch exist. Whether enforcement is **on** is a config question — check the deployed `FUNCTIONS_ENV_JSON`, which this session did not read. |
| 60 | "The money paths have no test." | *(re-proved 2026-10-21)* Six store-side specs exist (caps, watch, cdp-host, provisioner, request, machine), and `functions/src/handlers/browser-sessions.spec.ts` **does not exist** — the attach/close/keepalive handler, which is where a stranded machine or a double charge would come from, is the untested part. Promoted to an open gap, not a doubt. |
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
| 124 | **Latent, not a cost.** No service calls Meilisearch: the name appears **only under `docs/`** (5 files) and in no `functions/`, `bff/` or `src/` file. `deploy/meilisearch/fly.toml` is undeployed infrastructure with no client, so no request pays the `fra` round trip today. Re-open the day a search client is written — and put it beside webrain, not in `fra`. |

## Closed in this campaign

Numbers only; the paragraphs were stale and are in git history.

§1 BFF `13 14 15 16 17 18 19 21` · §2 billing `22 23 24 25 26 27 28 29 30 31 34 58` ·
§3 auth `36 37 38 39 40 41 42 44 45 46 51 81` · §4 sessions `55 57 63` ·
§5 crawl/storage `70 71 72 73 76 78 79 80` · §6 Angular core `82 83 84 85 86 88 89 90 91 92 93 94 95(redaction)` ·
§7 features `96 97 98 100 101 102 103 104 106 107 109 110 111 112` ·
§8 deploy `114 115 117 118 121 122` ·
§9 analytics `129 130 131 132 135(docstring) 136(tests)`.
