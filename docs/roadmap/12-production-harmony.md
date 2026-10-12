# Phase 7 — production harmony: what exists, what each service decides, what is left

Status: created 2026-10-10 from a **measured** audit of all four repositories, the BFF,
the Functions layer and the Angular client. Branch `next`.

The question this phase answers, in the requester's words: *audit and understand all three
backend projects plus deepscrape, wire them so they have harmony, and find the frontend
gaps — what exists, what is unused, what must be wired or removed before production?*

The short answer, and it is the important one: **there is very little left to build.**
The wiring is closed (measured, §1), the client has no orphan components, and the gaps
that remain are almost all **decisions**, not code. The previous phases were right that
this is a completeness problem, not a construction problem.

---

## 1. Method — every claim is a measurement

| Measurement | How |
|---|---|
| Repo inventory | `codebase-memory list_projects` (nodes/edges), `get_architecture` (routes, layers, clusters) |
| Frontend↔BFF parity | `bunx tsx scripts/route-parity.ts` |
| Orphan components | grep each component's **class name** across `src/app/**`, excluding `.spec.ts` |
| Dead services/constants | same sweep over `*.service.ts` + a grep for each exported symbol |
| Runtime gates | app `tsc --noEmit -p tsconfig.app.json`, `bun run build`, `bunx ng test --watch=false` |

Two traps this audit had to avoid, both already recorded in the skill:

- **A selector grep over-reports.** Page components are mounted by `loadComponent: () =>
  import(...)`, not by a selector, so the first sweep flagged ~85 live pages as "orphans".
  The class-name sweep is the correct one and it returned **0**.
- **A barrel `export *` hides death.** `core/services/index.ts` re-exports by wildcard, so a
  class name that appears nowhere else still looks "exported". The class-name sweep sees
  through it.

---

## 2. What exists — four repos, six layers

| Repo | Shape | Graph | Owns |
|---|---|---|---|
| `deepscrape` | Angular 20 (zoneless) + Bun/Elysia `bff/` + Firebase Functions (TS) | 21,391 nodes / 39,930 edges | the product: UI, the only served route table, callables, scheduled jobs, domain + persistence |
| `arachnefly` | Go / Fiber, Fly.io machine orchestrator | 1,039 / 2,119 | machine lifecycle, ownership, idle reaper, the MCP transport to a leased machine |
| `webrain` | Rust engine, MCP over HTTP, **also a portable desktop binary** | 2,549 / 5,958 | the browser: 17 MCP tools, CDP backends (Chrome / Obscura / Lightpanda), the credential vault, SERP |
| `crawlagent` | Python / FastAPI, crawl4ai browser pool | 3,079 / 7,517 | **legacy, frozen.** The crawl4ai provider. A draft pool, not a production dependency |

Layer map, runtime:

```
  browser ── Angular 20 ──────────────► Firebase Hosting (prerender + CSR shell)
                │  https
                ▼
        Cloud Run: deepscrape-bff (Elysia)   ◄── THE ONLY SERVED ROUTE TABLE (57 routes)
                │                                    (functions/src/infrastructure/syncaiapi.ts
                │                                     is a LIBRARY the BFF imports; its own
                │                                     route table is NEVER mounted)
                ├──► Firestore / Storage / Redis / QStash / Stripe
                ├──► arachnefly …… Fly Machines API …… leased browser machine
                │                                     └── webrain (MCP :11235)
                └──► webrain（WEBRAIN_MCP_URL, shared pool）
                            │
        crawlagent ─────────┘  (frozen; `crawl4ai` provider only)
```

**Client surface, measured.** 128 components, **0** orphaned by class reference. **57** BFF routes;
18 client roots; **0** client calls with no route; the 9 client-less routes are all explained
(4 reached through the computed `WebrainToolsService` path — `/extract`, `/extract/schema`,
`/pdf`, `/search`; 3 job stream routes; 2 webrain→platform callbacks). The master list from
`11` — operations, playgrounds, browsers, jobs, machines, proxies — was already built, and the
two real holes it named (BYOK, the scraping-engine preference) are closed.

Re-measured **2026-10-11**, and the parity had drifted since this section was written: the client
called `GET /api/admin/sessions`, which no route served, so the admin Sessions page answered
nothing. The backend was already complete — `handlers/session-fleet.ts` and the store's
`listAdminSessions`, whose `AdminSession` projection has no field a credential could occupy —
so only the binding was missing. It now carries the same `perm('platform','read')` gate as
`/api/admin/machines`. Hence 57 routes and 0 unrouted calls *again*, for a different reason than
the paragraph above. The lesson is `11`'s, twice over: **a hole in this codebase is usually a
wire, not a feature.** Run `bunx tsx scripts/route-parity.ts` before believing either number.

---

## 3. What each service decides — the harmony contract

The value of this table is the *Never* column. Most future drift will be a change landing in
the wrong repo.

| Service | Decides | Never |
|---|---|---|
| Angular client | presentation, auth session, which route to render | a browser-launch decision; a credential; a second copy of a plan/allowlist rule |
| `bff/` (Elysia) | **the served HTTP surface**, guards, request shaping | being bypassed — a new customer route goes here, not into `syncaiapi.ts` |
| Functions (`domain/`, `infrastructure/`) | business rules, pricing, metering, persistence | being reached over HTTP directly — the BFF imports these |
| Functions (`gfunctions/`) | callables + scheduled jobs | authenticating as a machine's owner (a schedule cannot; that is why the reaper lives in arachnefly) |
| arachnefly | Fly machine lifecycle, ownership, idle reaping, MCP relay | the UI; a browser-launch decision; holding a tenant credential |
| webrain | the browser, the vault, CDP, SERP | platform auth, platform secrets, a platform-only code path — **it must run standalone as a desktop binary** |
| crawlagent | nothing new | being developed. Frozen: installed, supported, no new work |
| Firestore | documents, rules, indexes | secrets — those live in Secret Manager, and a public shape has **no field a credential could occupy** |
| Redis / QStash | rate limits, queues, leases | money. A spend cap must fail **closed**; the rate limiter deliberately fails open |

### crawlagent's capabilities — who owns each one now

`crawlagent` is frozen (the table above), so its stack is not *migrated*, it is **superseded**.
This is the row the table cannot express, because the answer is not "crawlagent decides nothing"
but "each of its capabilities has a different owner now" — and a new feature that reaches for an
old one is exactly the drift this section exists to prevent.

| crawlagent used | owned now by | Never |
|---|---|---|
| Celery task queue | **QStash** (`ADR-2026-09-QSTASH-JOB-QUEUE`) | a worker fleet — queues are HTTP |
| Redis as broker / state | **Upstash Redis**, for rate limits and leases only | money — a spend cap fails **closed**, a rate limiter fails open |
| SSE task progress | **BFF streaming** (`bff/streaming.ts`) | a second progress transport, or one route per task |
| WebSockets | **nobody** — no server WS exists, and the only client WS is the dead neko viewer | assuming a WS transport; this is also what falsified `ADR-2026-10`'s evidence |
| its own storage | **Tigris/S3** (`s3-blob-store.ts` + `resolveBlobStore`), credentials in **Secret Manager** | a credential in Firestore; a store that does not fail closed |

### The WebRTC question — decided

Explicitly requested, so stated rather than left implicit.

**The neko WebRTC viewer is dead code and is NOT the interactive live view's transport.**
Three facts, each verified:

1. `core/components/browser/browser.component.ts` (class `BrowserComponent`) is unreachable —
   no route loads it, no template uses `app-browser`. It was unmounted from the dashboard on
   2026-10-10 because it pinned every visit to a fixed external host this repo does not control.
2. Its client stack — `clipboard.component`, `control.component`, `resolution.component`,
   `core/services/webrtc.service.ts`, `core/types/neko.*` — is reachable **only** through it.
3. The live view that shipped is a different transport: one `image/png` per poll,
   `GET /api/browser/session/:id/frame`, relayed through arachnefly's `POST /machine/mcp/:id`
   to `webrain_observe(what="screenshot")` on the session's OWN machine.

**Decision: keep the files, do not wire them, do not delete them yet.** They are the only
mouse/keyboard/clipboard/resolution handling in the tree and roadmap `09` (interactive live view)
has not chosen a transport. Their transport is the *neko server protocol*, which is not what the
platform runs — so they are a UI prototype, not a reusable client. **Delete them the day `09`
picks a transport; wire them the day `09` picks neko.** Until then they are inert, and inert is
the correct state for an unmounted experiment.

---

## 4. Verified gaps

Ordered, cheapest first. **Correctness before features**, and note how many are decisions.

| # | Gap | Kind | Evidence |
|---|---|---|---|
| 1 | ~~Profiles durability claim~~ — **CLOSED 2026-10-11, and the cite here was WRONG.** `en.json:401` is `F2_T`, and `F2_D` says only "Stealth browser profiles"; the word "Persistent" was not in the i18n at all. The claim was live on a PUBLIC prerendered route instead: `pages/marketing/mcp-web-scraping.component.html:238` — "**Persistent stealth profiles.** Real browser profiles that survive between runs" — undeliverable on the very path that page sells, because a session machine has **no volume** (`deploy/browser-session/Dockerfile:47`, `BuildConfigMap` sets no `mounts`) and Fly resets a stopped machine's root filesystem while the reaper suspends idle machines every minute. Rewritten to the true claim: a stable identity **for the life of a session**. **Now also closed:** `en.json`'s `UPC_DESC_2` ("keep cookies, sessions across runs") and `UDD_DESC` ("permanent sessions") promised persistence the platform does not guarantee, so both were rewritten to describe the mechanism (a profile directory) instead of the outcome. The outcome is genuinely not ours to promise either way: `deploy/webrain-engine/fly.toml` declares no `[mounts]`, so an engine machine has no volume, while the `machines` surface DOES support `mounts`/`Volume` — so a caller who brings a machine with a volume would get persistence and a blanket "this never persists" would be its own false claim. | correctness, **published claim** | `pages/marketing/mcp-web-scraping.component.html:238`; `deploy/browser-session/Dockerfile:47` |
| 2 | **`ADR-2026-10-BROWSER-SESSIONS.md:64` cites false evidence** — a zero-result grep for `webrtc\|rtc\|neko\|vnc\|mjpeg\|sse` and "no WebSocket server exists". A neko viewer is in the tree (above) and the client holds a live WS. The *decision* may stand; the evidence does not. **DONE 2026-10-11** — the ADR carries an amendment at that section: the decision stands, it is reached again from the neko cluster's *unreachability*, and the half that survives is kept (webrain has no server-side streaming transport). The lesson it records is the general one: a repo-scoped sweep was cited for a platform-scoped claim. | doc correctness, **amended** | `ADR-2026-10-BROWSER-SESSIONS.md`, section "no streaming transport exists" |
| 3 | ~~**Two undeployed collection-group indexes** (`state` and `idleDeadline`, both on `browserSessions` — this row previously said `idleDeadline` was on `machines`, which was wrong).~~ **DONE 2026-10-11**: deployed to the `easyscrape` database, both `READY` with `COLLECTION_GROUP` scope. | done | `firestore.indexes.json`; §5 of the skill |
| 4 | ~~**`GET /api/pricing/estimate`** (roadmap `07` Part F)~~ built 2026-10-11. It was never a missing feature: handler, domain function and client all existed, and the route was not registered. | done | `bff/api.ts` |
| 5 | **Fleet lifecycle actions** (`/api/admin/machines`) and **admin session reclaim** need an owner sign-off: arachnefly's `MachineOwnershipMiddleware` has **no admin bypass**, and moving a session's idle deadline suspends a customer's live, still-billing machine. **Narrowed 2026-10-11:** the session READ now exists (`GET /api/admin/sessions`, bound in `bff/api.ts`), so the open gap is the ACTIONS only — reclaim still moves another tenant's deadline. | **decision** | `05` Part D; `admin-sessions.component.*`; `handlers/session-fleet.ts` |
| 6 | ~~**`TransactionsComponent` is dead**~~ — **CORRECTED 2026-10-11: false, and this row was inherited into an audit as fact.** It IS routed (`billing.route.ts:40`), IS referenced (`_nav.ts:206`), and calls `billingService.getUsageReport()`. It needs no ledger endpoint. Remaining question is nav placement only. | **product decision (nav placement)** | `routes/user/billing.route.ts`; `_nav.ts` |
| 7 | **crawlagent is wired as a live default in places** (`API_CRAWL4AI_URL` → `crawlagent.fly.dev`; `SCRAPE_PROVIDER` frozen provider). That is intended — `crawl4ai` is a supported *frozen* provider — but the legacy pool's contract must not be extended. | decision already made | `config/env.ts`; `scrape-providers.domain.ts` |

Closed during this audit: the `SCRAPE_PROVIDER` comment/code drift (the comment now states
`webrain` is the default and names the old error).

---

## 5. Dead-code ledger (measured 2026-10-10)

| Symbol | Verdict | Action |
|---|---|---|
| `CRAWL_PROVIDERS` (`types/crawl.interface.ts`) | unused export | **removed** |
| `API_ARACHNEFLY_UPLOAD_URL` (`variables/deployment.var.ts`) | imported, never read; ternary with identical branches | **removed** |
| `FirestoreCacheService` (`core/services/firestore-cache.service.ts`) | referenced nowhere outside itself | **removed** |
| `PlutoService` + `PLUTO_ID` + spec | a third-party payments call on a personal domain, superseded by Stripe; the token's only two consumers were its own providers | **removed** |
| `pages/landpage/` (4 files) | the marketing home is `pages/home`; this shell is referenced by nothing | **removed** |
| ~~`TransactionsComponent`~~ | **not dead — corrected 2026-10-11.** Routed at `billing.route.ts:40`, linked at `_nav.ts:206`, calls `getUsageReport()`. | **kept — nav placement only** |
| `BrowserComponent` + neko cluster (6 files) | dead, but the prototype for `09` | **kept — decided §3** |

Gates after the removals: app `tsc` **0**, `bun run build` **0** (34.8 s, no budget errors),
`ng test` **751 SUCCESS** (was 756; the three removed specs account for the difference).

> **Concurrent editing was observed.** Three of the four items this audit independently found
> (`CRAWL_PROVIDERS`, `API_ARACHNEFLY_UPLOAD_URL`, the `SCRAPE_PROVIDER` comment) were already
> fixed by another writer between the audit and the edit. If two agents work this list, re-measure
> before editing; a stale finding is a double edit, and this repository has been corrupted by
> batched same-file edits twice.

---

## 6. The production checklist

Ordered. Steps 1–3 are correctness and cost nothing to decide.

1. Settle the **profiles claim** (§4.1): land the storage work, or change the copy. A published
   claim the product cannot honour is a correctness item.
2. **Deploy the two collection-group indexes** and let one real sweep run (§4.3).
3. ~~Correct the **ADR evidence** (§4.2). One paragraph.~~ **Done 2026-10-11** — the amendment is
   in the ADR.
4. Owner sign-off on the **two admin action classes** (§4.5) — or accept read-only as the answer,
   which is what the code does today.
5. ~~`GET /api/pricing/estimate` (§4.4) — the last absent pricing surface.~~ Built 2026-10-11.
6. ~~Decide `TransactionsComponent` (§4.6): wire it against the credit ledger, or delete it.~~
   **Resolved 2026-10-11 — it was already wired.** Routed, nav-linked, calling `getUsageReport()`.
   There is nothing to wire and nothing to delete; only nav placement is a product call.
7. Phase 4 (`04-organizations-and-billing.md`) — BYO Fly org + `computeSource`. **Not started**,
   and it is the only remaining *feature* block.

**Nothing in this list is a wiring gap.** The frontend is wired. Re-measured 2026-10-11: steps 1,
2, 3, 5 and 6 are closed, so what remains is **two owner decisions** (§4.5 admin actions, §4.6 nav
placement) and **Phase 4**, the only feature block. Four rows above were already fixed at the
moment they were read, which is the cost this file exists to remove — a checklist row that outlives
its fix makes the next reader re-derive the whole list, so strike a row in the commit that closes
it.

---

## 7. What this audit did not verify

- No repo other than `deepscrape` was **built** during this session; arachnefly, webrain and
  crawlagent were read through the code graph, not gated. Their last green runs are recorded in
  the skill.
- The `deepscrape` graph is current; the **arachnefly graph is stale** (13 routes vs the 14 the
  skill records after `POST /machine/mcp/:id`) — re-index before trusting its route list.
- The neko stack was judged by reachability, not by reading all ~1,000 lines of
  `webrtc.service.ts`. Unreachable is sufficient for "do not wire"; deletion needs the `09`
  decision.
- No live engine, deployment or Firestore write was exercised. This was a source audit plus three
  client-side gates.

---

## 8. The owner's ten-item list, re-measured 2026-10-10

Asked for directly, so it is answered item by item against the code rather than against the plan.
Measurements: `bunx tsx scripts/route-parity.ts` → **62 routes / 19 client bases / 0 client calls
with no route** (re-measured 2026-10-11; read 57/18 when first written); a class-name orphan sweep over 189 components + services → **4 dead surfaces** (§5).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Operations | **built** | `pages/user/operations/operations.component.ts` |
| 2 | Playgrounds | **built** | `pages/user/playground/` — hosts the browser-session panel in `browser` mode |
| 3 | Browsers | **built** | `/browser` → panel (24 specs) → frame (11 specs) |
| 4 | Create jobs | **built** | three distinct actions inside `/operations` |
| 4b | Machines | **built** | `/machines`, composing the panel over the container console |
| 4c | Proxies & providers | **half** | *engine* selection is wired in `settings/general` (`app-ai-keys` + `setMyScrapeProvider`). A **caller-facing proxy surface does not exist** — proxies are platform-admin only (`/admin/webrain` + `webrain-config.service`). This is the one item with a real hole |
| 5 | The rest | **built** | billing, 6 settings tabs, chatai, crawl-pack (5 tabs), 11 admin pages |
| 6 | Settings | **built** | `api-keys`, `general`, `profile`, `security`, `storage`, `workspace` |
| 7 | Crawl packs | **built** | 5 tabs; the `machines` tab was deliberately moved to `/machines` |
| 8 | Dashboard | **built** | the neko WebRTC viewer was unmounted on purpose (§3) |
| 9 | Analytics | **built** | `admin-analytics` + `firestore-analytics` + `analytics-range` |
| 10 | Payments | **built** | plans, plan-details, usage, rates, success, cancel, passes, paymentmethods, and `TransactionsComponent` — **which is routed and wired, not dead** (`billing.route.ts:40`, corrected 2026-10-11) |

### The dead / legacy ledger, re-measured

| Symbol | Verdict |
|---|---|
| `BrowserComponent` + its client stack | dead, **kept** — the prototype for roadmap `09` (§3) |
| `FirestoreCacheService` | dead — no reference outside itself |
| `LandPageComponent` (whole `pages/landpage/`) | dead — the marketing home is `pages/home` |
| ~~`TransactionsComponent`~~ | **NOT dead — removed from this ledger 2026-10-11.** Routed and nav-linked; see §4.6. |

**Repeatedly reverted:** the `FirestoreCacheService` and `pages/landpage/` deletions, and the
`graph` resource work, have each been restored by a `git` operation in this tree. Two writers are
editing it concurrently and the working tree carries **325 uncommitted changes**. **Commit before
making more changes**, or the next revert takes the work again — this section and `13` are the parts
that survived, because they are documentation.
