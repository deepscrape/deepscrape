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
| 6 | 87 | H | security | The full ID token rides in the WebSocket URL (`?token=`), so it lands in proxy/CDN logs and is replayable. | `webrtc.service.ts:111`, `:163`. Needs a transport change (subprotocol or first-frame auth) plus whatever terminates the socket. |
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
