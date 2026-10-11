# Phase 6 — frontend wiring and the remaining UI surfaces

Status: created 2026-10-10 from a **measured audit**, not a reading of the plan. Branch `next`.

The question this phase answers: *the master list (operations, playgrounds, browsers, jobs,
machines, proxies, "the rest") — how much of it is actually built, and what is genuinely left?*

The answer is that **most of it was already built**, so this phase is short. It is a wiring
phase, not a feature phase, and the two things it found were both cases of a surface that
existed in code and could not be reached from the product.

## Method

Every claim below is from a measurement, and each measurement is repeatable:

| Measurement | Command / method |
|---|---|
| Route inventory | `grep 'loadComponent' src/app/routes/**` |
| Frontend↔BFF parity | `bunx tsx scripts/route-parity.ts` |
| Orphan detection | grep for the component **selector** across `src/app/**` |
| Backend contract | read the handler + the callable pair, not the docs |
| Gates | app TSC, `bun run build`, `bunx ng test --watch=false` |

`grep` for the selector is the load-bearing one. A component can have a spec, a service, a
template and translations and still be unreachable, and nothing else in the toolchain notices.

## The master list, measured

| # | Item | Surface | Status | Evidence |
|---|---|---|---|---|
| 1 | Operations | `/operations` | **built** | `pages/user/operations/operations.component.ts`; Save/Run/Schedule with `multiCrawlEnqueue` and `task_id` |
| 2 | Playgrounds | `/playground` | **built** | `pages/user/playground/playground.component.ts`; hosts the browser-session panel in its `browser` mode |
| 3 | Browsers | `/browser` | **built** | `browser-session.component.ts` → panel (24 specs) → frame component (11 specs) |
| 4 | Create jobs | inside `/operations` | **built** | three distinct actions, previously all identical |
| 4b | Machines | `/machines` | **built** | composes `<app-browser-session-panel />` over the container console; session-owned rows refuse Stop/Destroy |
| 4c | Proxies & providers | engine: **was missing** → **built**; proxies: admin-only | `SCRAPE_PROVIDER.*` in 5 locales had **no frontend reference**; see below |
| 5 | The rest | billing, 6 settings tabs, chatai, crawl-pack (5 tabs), 11 admin pages | **built** | `src/app/routes/**` |

`4c` was the only item with a real hole in it, and it was not a missing feature — it was a
missing wire.

## What the audit found

### 1. The BYOK surface was an orphan

`<app-ai-keys>` (`core/components/ai-keys/ai-keys.component.ts`) was referenced **nowhere**
outside its own file. Grep for `app-ai-keys` and `AiKeysComponent` across `src/app/**` returned
only the selector declaration and the class declaration.

So the UI for storing a per-vendor API key was built, styled, and unreachable. A customer could
not add their own key from anywhere in the product, which made the whole BYOK capability inert
even though `ai_handler.ts`'s `keyFor` has always read a stored key first.

### 2. The scraping-engine preference had no consumer at all

The platform stores a per-user scraping engine and **honours it on the request path**:

- `domain/scrape-providers.domain.ts` — the catalogue: `crawl4ai` (frozen), `jina`, `webrain`.
- `infrastructure/scrape-provider.store.ts` — `readStoredProvider` / `writeStoredProvider`.
- `handlers/scrape.ts` — `scrapeMiddleware`, the handler for `POST /api/crawl`, resolves it.
- `handlers/webrain-jobs.ts` — the job path resolves it too.
- `gfunctions/user-settings.ts` — `getMySettings` returns `scrape.{stored, selectable}`, and
  `setMyScrapeProvider` is the validated writer.
- `assets/i18n/*.json` — `SCRAPE_PROVIDER.TITLE | CRAWL4AI | JINAAI | WEBRAIN` in **all five** locales.

And the client consumed **none** of it. `MyAiSettings` was even documented as *"the part of the
`getMySettings` reply this surface consumes"* with only `ai` declared, so the omission was
structural rather than an oversight in a template.

**Consequence:** a preference that decides which backend actually serves a customer's crawl was
unreachable, and `FALLBACK_PROVIDER` governed every account silently.

### 3. The orphan had never been compile-checked

There is no `ai-keys.component.spec.ts`, and the component was unreferenced. `tsc --noEmit` never
parses templates, Karma only compiles components a spec imports, and an unreferenced component is
not reached by the build — so its template had passed through **no** gate.

Mounting it is what fixes that, and it is worth naming rather than leaving as a side effect:
the change below is the first time `ai-keys.component.html` has been compiled at all.

## Built in this phase (2026-10-10)

The two findings share one fix, because the server deliberately composes both halves into a
single `getMySettings` call so they cannot disagree about which plan they were answered under.
So one component owns one callable.

| File | Change |
|---|---|
| `core/types/ai-provider.interface.ts` | `ScrapeProviderState`, `SetMyScrapeProviderRequest`, `ScrapeProviderMutationResponse`; `MyAiSettings` now declares the `scrape` half |
| `core/services/ai-keys.service.ts` | `engines` + `storedEngine` signals, read in `load()`; `storeEngine()` writing through `setMyScrapeProvider` |
| `core/components/ai-keys/ai-keys.component.ts` \| `.html` | engine rows above the vendor rows: select, active marker, the catalogue's own `notes` |
| `pages/user/settings/general/general.component.ts` \| `.html` | mounts `<app-ai-keys />` in a new section |
| `pages/user/settings/general/general.component.spec.ts` | provides an `AiKeysService` stub (the page now injects it) |

Three decisions inside that are not stylistic:

1. **`storeEngine` stores the server's reply, not the request.** The server validates the choice
   against the same catalogue `scrapeMiddleware` resolves from, so echoing the requested value
   would let the UI show an engine the platform had refused. The server's own comment on
   `setMyScrapeProvider` calls that outcome worse than a rejection.
2. **The engine rows sit ABOVE the vendor rows.** The engine changes where a crawl *goes*; a
   vendor key only changes who pays for an AI call. Ordering is the cheapest way to say that.
3. **The engine list is whatever the server says is `selectable`.** No client-side allowlist —
   a second, drifting copy of the plan rules is exactly the bug this wiring is fixing.

### Gates

| Gate | Result |
|---|---|
| `bunx tsc --noEmit -p tsconfig.app.json` | 0 |
| `bun run build` | 0 — `Application bundle generation complete`, no budget or `NG5*` errors |
| `bunx ng test --watch=false` | **756 SUCCESS**, unchanged from the pre-change baseline (so the spec edit caused no regression) |

**Not verified:** the engine selection has **no spec of its own**. The gates above prove the
wiring compiles, renders and does not regress; they do not pin the `storeEngine` reply-echo
branch or the no-op on an already-stored engine. Two specs are the honest next step and are
listed below rather than implied as done. The flow was also never exercised against a live
engine.

## Where we are, overall

| Phase | State |
|---|---|
| Phase 0 — security blockers | complete |
| Phase 1 — leasing, store, routes, reaper, metering | complete except `§1.6`'s remaining surfaces |
| Phase 2 — live view | **closed end to end 2026-10-10** — arachnefly `POST /machine/mcp/:id`, `observeMachineFrame`, `browserSessionFrame`, `GET /api/browser/session/:id/frame`, fps from `SESSION_CAPS` |
| Phase 3 — production readiness | `08`; frames done, owner decisions and the profiles claim open |
| Phase 4 — organizations / BYO compute | not started |
| Phase 5 — pricing & budgets | spend cap and `GET /api/pricing/estimate` complete end to end (2026-10-11) |
| Phase 6 — this file | the two wiring gaps closed |

## What is genuinely left, in priority order

**Correctness, cheapest first**

1. The **profiles durability claim**. `src/assets/i18n/en.json:401` advertises persistent profiles
   the platform could not deliver (no volume, process-global vault, Fly resets a stopped machine's
   root filesystem). **Addressed 2026-10-11**: the account vault carries the cookie jar across
   machines and is wired into the panel. Residual is `state.json` only — see `08` §3.3.
2. `ADR-2026-10-BROWSER-SESSIONS.md:64` still asserts a zero-result sweep for
   `webrtc|rtc|neko|vnc|mjpeg|sse` and claims no WebSocket server exists. The ADR's cited evidence
   is false. Note the SECOND half of this item was itself stale: the neko WebRTC viewer is **not**
   mounted on the dashboard — it was unmounted 2026-10-10 (decision recorded in `12` §3), so the
   live claim to re-check is the frontend's WS to crawlagent, not a viewer.
3. `SCRAPE_PROVIDER` reads `getConfigValue("SCRAPE_PROVIDER", "webrain")` while the comment above
   it says `'crawl4ai' (the default)` and promises byte-for-byte behaviour. An unconfigured
   deployment now routes `/api/crawl` to webrain.
4. Delete the two verified dead constants: `API_ARACHNEFLY_UPLOAD_URL` (a ternary with identical
   branches, consumed only as an unused import) and `CRAWL_PROVIDERS` (exported, never read).

**The two owner decisions** (both are destructive acts on another tenant's money, so they are
asked rather than taken): the fleet's lifecycle actions, and one-click reclaim.

**Then, the remaining surfaces**

5. Two collection-group indexes are declared but undeployed; the first live sweep is the real test.
6. ~~`GET /api/pricing/estimate` (`07` Part F) does not exist.~~ Built 2026-10-11; the handler and the client had both shipped, and only the route was missing.
7. A user-facing **proxy** surface. The pool is platform-admin only today
   (`/admin/webrain` + `webrain-config.service.ts`). Whether a tenant may bring their own proxy is
   a product decision, not a missing wire — and per `06`, the default must not be
   "residential for every request".
8. The specs this phase owes: `storeEngine` reply-echo, and the already-stored no-op.

## What this phase does NOT claim

- Nothing was deployed. Every result above is local.
- The audit covered the **Angular** surfaces of the master list. The three backend repos were read
  for contract (handler, callable, domain) rather than re-audited in full; Phase 3's `08` remains
  the backend-side record.
- `crawlagent`'s browser pool was deliberately out of scope, per instruction that it is a draft.
