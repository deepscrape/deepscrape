# 12 — Service orchestration & layer inventory

Status: living document. Created 2026-10-10. Branch `next`.

This is the **answer sheet** for "what exists in all four projects, and which service owns what".
Every count here was measured, not remembered; the prose says which command produced it, so you can
re-run it. Where a number is inherited rather than re-measured, it says so.

Predecessors: `08-production-readiness.md` (Phase 3), `10-refactor-priorities.md` (Tier 0–4),
`11-frontend-wiring-and-ui.md` (Phase 6).

---

## §1 The four projects, measured

| Project | Path | Language / runtime | What it is | Surface | Count |
|---|---|---|---|---|---|
| **deepscrape** | this repo | Angular 20 / Bun | The product: SSR frontend + **BFF** + Firebase Functions | BFF HTTP routes | **57** (measured by `bunx tsx scripts/route-parity.ts`) |
| | `functions/src/index.ts` | TypeScript / Node | Callables + Firestore/analytics triggers + scheduled sweeps | exported symbols | **101** (`grep -c '^export '`) |
| **arachnefly** | `D:\Windows\Documents\Programming\Projects\Go\deepscrape\arachnefly` | Go / Fiber | Machine lifecycle on Fly: deploy, start, suspend, stop, destroy, execute-task, MCP | HTTP routes | **14** (was 13; `POST /machine/mcp/:id` added this session) |
| **webrain** | `D:\Windows\Documents\Programming\Projects\Rust\webrain` | Rust | The crawl/scrape/serp/extract/pdf engine + job queue, exposed over MCP-by-HTTP | MCP tools | tier-allowlisted; reached **only** through the BFF |
| **crawlagent** | `D:\Windows\Documents\Programming\Projects\Python\crawlerai\crawlagent` | Python / FastAPI | **LEGACY.** The old crawler + browser pool. Draft. | 20 HTTP routes + a websocket router | not the target |

**The one structural fact that decides everything else:** `bff/api.ts` is the **only served `/api`
surface**. `functions/src/infrastructure/syncaiapi.ts` registers `this.router.*` handlers that are
**never mounted** — `index.ts` exports no Express app and every Hosting rewrite points at Cloud Run
`deepscrape-bff`. So a route that exists only in `syncaiapi.ts` does not exist. See Tier 2.1.

### What the BFF actually serves, by path family

Measured by reading the route declarations in `bff/api.ts`. 12 families:

| Family | Routes | Gate | Backing service |
|---|---|---|---|
| `/api/orgs*` | 10 | `perm('organization', …)` | functions (`org` domain) |
| `/api/machines/*` | 9 | `paid` + `perm('machine', …)` | **arachnefly** |
| `/api/crawl/*`, `/api/job/*`, `/api/seeder/*` | 8 | `paid` + `perm('crawl','execute')` | **webrain jobs** |
| `/api/{serp,scrape,search,extract,pdf}` | 5 | `access` + `perm('crawl','execute')` | **webrain** |
| `/api/monitor/*` | 5 | `access` + `perm('crawl','execute')` | webrain + Firestore monitor docs |
| `/api/browser/session*` | 5 | `access` + `perm('crawl','execute')` | Firestore session + arachnefly frames |
| `/api/storage/*` | 5 | `perm('storage', read/write)` | S3/Tigris |
| `/api/{anthropic,openai,groq}/*` | 3 | `paid` + `perm('ai','execute')` | vendor APIs (keys never reach the browser) |
| `/api/webrain/config*` | 3 | `perm('platform', …)` — **platform admin only** | webrain control plane |
| `/api/admin/machines`, `/api/admin/sessions` | 2 | `perm('platform','read')` — **read-only** | Firestore projections |
| `/api/jina/:url` | 1 | `paid` + `perm('ai','execute')` | JinaAI reader |
| `/status`, `/services/contact` | 2 | public (CSRF-bypassed on purpose) | functions |

---

## §2 Service of record — who owns what

This is the "decide what service does what" table. `Owner` is the **only** place the capability may
be implemented. `Never` is the failure mode being ruled out.

| # | Capability | Owner (service of record) | Never | Why |
|---|---|---|---|---|
| 1 | Lease / list / keepalive / close a browser session | **BFF route + Firestore session doc**; arachnefly holds the machine | The Angular app holds the state | `decideLease` is pure and unit-tested with no Fly token (`02 §1.1`); the app cannot be the authority |
| 2 | Machine lifecycle (deploy/start/suspend/stop/destroy/execute-task) | **arachnefly** | BFF talks to Fly directly | arachnefly owns `MachineOwnershipMiddleware`; a BFF fast path would need a uid-forwarding bypass — an authz change, not an implementation detail |
| 3 | Live-view **frames** | **arachnefly** produces → **BFF** relays `/api/browser/session/:id/frame` → app renders | App calls the machine directly | The BFF relay is what turns a raw frame stream into a rate-limited, entitlement-checked, `no-store` response |
| 4 | Live-view **interactive** (WebRTC/clipboard/control) | **Nobody. Removed from wiring 2026-10-10.** | Re-mounting a build-constant endpoint | The old transport pointed at one external host this repo does not control. See §4 |
| 5 | Crawl / scrape / serp / search / extract / pdf | **webrain** | The BFF reimplementing any of it; the browser calling webrain directly | webrain is the tier-allowlisted engine; the BFF is the only authenticated door |
| 6 | Long-running job enqueue / status / stream / cancel | **webrain jobs**, exposed at `/api/crawl/stream/job`, `/api/job/*` | The app opening a websocket to a crawler host | **This is the biggest live gap.** See §3.1 |
| 7 | Proxies | **webrain** control plane, `POST /api/webrain/config/proxies` | Per-tenant proxy config leaking into the app | Proxies are a platform credential; the route is `perm('platform','write')` for that reason |
| 8 | AI vendor calls | **BFF** (`/api/anthropic`, `/api/openai`, `/api/groq`) | The browser holding a vendor key | BYOK keys live server-side; the browser sends a model + prompt, never a key |
| 9 | Monitors | **Firestore doc + `drainDueMonitors` scheduled function** | A long-lived in-BFF scheduler | A scheduled function is the only thing that survives a Cloud Run scale-to-zero |
| 10 | Storage objects | **BFF `/api/storage/*` → S3/Tigris** | The app presigning with an access key it holds | `storagePresign` mints a scoped URL; the client never sees a credential |
| 11 | Payments / entitlements | **Stripe functions** + BFF billing routes | Entitlement computed in the app | The app renders what `getMyEntitlements` returns; it never decides |
| 12 | Analytics | **Firestore triggers + scheduled aggregations** | Client-side counters | `onUserCreated`, `computeDailyTrends`, `computeRangeMetrics` etc. |
| 13 | Search index | **Meilisearch** (`deploy/meilisearch/`) | A Firestore full-scan per query | — |
| 14 | Crawler + browser pool (the old world) | **crawlagent — LEGACY** | Building anything new on it | Draft per the owner; its context model shares one browser process |

---

## §3 Layer inventory — exists / orphaned / absent

### 3.1 The one wiring gap that matters

The `/operations` page creates jobs through **BFF → webrain** (`multiCrawlEnqueue`) but reads task
status from **crawlagent's** `wss://agent.deepscrape.dev/api/v1/ws/task/status` — a websocket
**outside the BFF**, with no guard, no entitlement and no metering in front of it
(Tier 1.2). The BFF serves **no `/ws` at all**.

Consequence today: retire crawlagent and the operations rows go inert **silently** — no error, just
no progress. That is a correctness problem, not a cosmetic one.

**Decision.** Job status is a webrain capability, so it must be served by the BFF. The BFF needs a
`/ws` (or SSE) route in front of `webrainJobs.getTaskStatus`. Until that exists, do **not** delete
crawlagent — it is load-bearing for one page even though it is legacy.

### 3.2 Angular — pages present

`src/app/pages/user/` — 9 directories: `admin`, `billing`, `browser`, `chatai`, `crawl-pack`,
`dashboard`, `operations`, `playground`, `settings`. Every route is lazy via `loadComponent`.
`analytics` and `payments` are **not** top-level page dirs — they live under `admin/` and `billing/`
respectively, which is correct (both are gated surfaces, not user-facing dashboards).

### 3.3 Orphaned / dead, verified

| Area | State | Evidence |
|---|---|---|
| `API_ARACHNEFLY_UPLOAD_URL` (`src/app/core/variables/deployment.var.ts`) | Dead three ways | Both ternary branches are the identical string; one unused import; no BFF route or rewrite serves `/upload/machines` |
| `CRAWL_PROVIDERS` (`src/app/core/types/crawl.interface.ts`) | Exported, never consumed | whole-tree grep |
| `functions/src/handlers/machines.ts` | Misnamed | It is the **arachnefly client**, not a handler table. Has already misled this repo's own skill twice |
| `syncaiapi.ts` route registrations | Never mounted | §1 |
| neko / WebRTC transport | **Removed from wiring 2026-10-10** | §4 |
| `crawlagent` pool surface (`/contexts/*`, `/janitor/*`, `/displays`, `/display_metrics`, `/memory_stats`) | Draft | Owner: keep what works, do not build on it |

### 3.4 Absent, and known to be absent

- **No `/ws` on the BFF** (§3.1).
- **The i18n catalogues ARE now validated** — `scripts/i18n-keys.ts`, wired into
  `.github/workflows/test.yml` beside the OnPush check (2026-10-11). Its first run found 19 keys
  that rendered as raw text. What remains uncheckable is a key built at runtime
  (`'PREFIX_' + value`): those are covered only by the prefix check, which proves the namespace
  exists, not that the value does.
- **No template coverage in the code graph** — 151 `parse_partial` ranges in `src`, all `.html`/`.scss`.
  This is why every template claim needs `bun run build`.
- `docs/ADR-2026-10-BROWSER-SESSIONS.md:64` asserts a zero-result sweep for `webrtc|rtc|neko|vnc|mjpeg|sse`
  and claims no WebSocket server exists. **Both were already false** and are now doubly stale. Not yet corrected.

---

## §4 Removal list

Applied this pass (all verified dead, none behaviour-changing):

1. **neko endpoint as a build constant.** `nekoUrl: "wss://neko-rtc.fly.dev"` removed from
   `prod_gen.ts` and from all three generated environments. `app-browser` unmounted from the
   dashboard; `browser.component.ts` now takes `@Input() endpoint` from the caller and **throws**
   when none is supplied — so no future edit can silently reintroduce a fixed host. The component,
   `WebRtcService`, the clipboard/control/resolution children and the protocol types are **kept** as
   a reference implementation (owner: "keep it as information github repo"). Upstream projects and
   how to stand them up: `09-interactive-live-view-and-vault.md`.
   *Pinned by spec:* `browser.component.spec.ts` asserts that with no endpoint, `rtc.connect` is
   never called and the error names the endpoint.
2. `API_ARACHNEFLY_UPLOAD_URL` + its import — deleted.
3. `CRAWL_PROVIDERS` — deleted.
4. `SCRAPE_PROVIDER` comment corrected (it claimed `'crawl4ai' (the default)` above code that
   defaults to `webrain`).

Deliberately **not** done, with reasons:

- **`syncaiapi.ts` route registrations** — potentially the largest single deletion in the repo, but
  the count is unmeasured and the middleware the BFF *does* bind must survive. Measure first (Tier 2.1).
- **crawlagent** — load-bearing for `/operations` until §3.1 is built.
- **`handlers/machines.ts` rename** — safe, but it is a pure rename with no behaviour change and it
  touches every import site. Do it on its own commit, not inside a feature pass.

---

## §5 Frontend design-piece backlog — the 10-item list

`BFF` = the route family backing it (§1). `State` is measured against the current tree.

| # | Surface | Page / anchor | BFF backing | State |
|---|---|---|---|---|
| 1 | **Operations** | `pages/user/operations` | `/api/crawl/stream/job`, `/api/job/*` | **Built, but status channel is legacy** — §3.1 |
| 2 | **Playgrounds** | `pages/user/playground` | `/api/{serp,scrape,search,extract,pdf}` | Built |
| 3 | **Browsers** | `pages/user/browser` | `/api/browser/session*` + `/api/machines/*` | Session panel + frames wired; interactive view removed (§4.1) |
| 4 | **Create jobs** — how | inside Operations | same as 1 | Partially defined; the honest model is *enqueue a webrain job, poll/stream via the BFF, never via a crawler host* |
| 4b | **Machines** | `pages/user/admin` (fleet) | `/api/machines/*` (tenant) + `/api/admin/machines` (read-only fleet) | Tenant actions wired; fleet is read-only **by design**. Two owner decisions withheld: fleet lifecycle actions, one-click reclaim — both destructive on another tenant's money |
| 4c | **Proxies** — all providers | platform admin | `/api/webrain/config/proxies` | Route exists; the UI is the gap |
| 5 | **Remaining UI features** | — | — | Ordinary backlog; not a wiring gap |
| 6 | **Settings** | `pages/user/settings/general` | `/api/*` + callables | BYOK (`app-ai-keys`) + scrape-engine picker **mounted this session**; was mounted nowhere before |
| 7 | **Crawl-packs** | `pages/user/crawl-pack` | `/api/crawl/*` | Built; the project selector is already the natural key for a future graph surface |
| 8 | **Dashboard** | `pages/user/dashboard` | aggregations | Built; the neko viewer was unmounted, `app-browser-session-panel` is the live view |
| 9 | **Analytics** | `pages/user/admin` | analytics triggers + `/api/admin/*` | Admin-gated, correctly |
| 10 | **Payments** | `pages/user/billing` | Stripe functions + BFF billing | Built end to end incl. the spend cap |

### The four design pieces this list is actually missing

Naming them, because "remaining UI features" is not actionable:

1. **A proxy-management surface** (4c) — the route exists and has no screen.
2. **A job-creation form with a defined contract** (4) — what fields map to a webrain job payload is
   currently implicit in the Operations page.
3. **A `/ws` progress surface** (1 + §3.1) — this is the piece that makes Operations honest.
4. **The graph/MCP surface** — see `ADR-2026-09-MCP-SERVICE-EXPOSURE.md`; keyed by the crawl-pack
   selector (7), which already exists.

### The four pieces, with verified anchors (audited 2026-10-10)

Routes and guards below were read from source, not inferred. **Piece 1 is the pick**, and it is the
only one with no backend work: the route exists, the handler exists, and the gap is a screen.

| # | Piece | Size | Verified anchors | Blocker |
|---|---|---|---|---|
| 1 | **Proxy-management surface** | small — one admin page, one client service | `GET /api/webrain/config` -> `getWebrainConfig`, guard `perm('platform','read')` (`bff/api.ts:594`, `functions/src/handlers/webrain-config.ts:60`). Writes: `POST /api/webrain/config/proxies` -> `setWebrainProxies` (`:124`) and `POST /api/webrain/config/token` -> `setWebrainToken` (`:92`), both `perm('platform','write')` | none |
| 2 | **Job-creation form + contract** | medium | `/api/crawl/stream/job`, `/api/job/*` | needs the fields->payload **contract decided first** |
| 3 | **`/ws` progress surface** | medium — new BFF route | in front of `webrainJobs.getTaskStatus` | a new route, and `14` §3 tracks a webrain-side progress channel |
| 4 | **Graph/MCP surface** | large | keyed by the crawl-pack selector | ADR `2026-09-MCP-SERVICE-EXPOSURE.md` is an **owner decision**, not implementation |

Two facts that make piece 1 cheap, and one that is easy to get wrong:

- **`perm('platform', ...)` IS the admin gate.** No role in `POLICIES` holds `platform`, so only the
  `isPlatformAdmin` short-circuit in `canPerform` admits a caller. Do not invent a second admin check,
  and do not gate it on `machine` or `crawl` — those are tenant-scoped and every paid user holds them.
- **No `paid` guard**, deliberately: this surface spends no credits, it rotates a credential the
  platform owns.
- **The proxy pool is a CREDENTIAL.** A proxy URL is `user:pass@host`. Anything the page renders must
  come from the handler's labeller (`labelFor` -> hostname only), never from the raw URL, and a
  screenshot of this screen must not be able to leak an exit. The handlers already do this; a new
  screen must not undo it by asking for the `WebrainConfig` document directly.

`GET /api/webrain/config` answers the proxy pool **and** the worker pool together, because both live in
the one `WEBRAIN_CONFIG` secret (`{"mcpToken", "proxies", "workers"}`). A proxies-only surface reads one
half of a document that has two; say so on the page rather than implying the token is absent.

---

## §6 Orchestration sequence

Ordered so nothing is built on a service that is about to move.

| # | Step | Depends on | File |
|---|---|---|---|
| 1 | Security fixes 2–5 (`06` §0) | nothing | `01-security-blockers.md` |
| 2 | `/ws` (or SSE) on the BFF in front of `webrainJobs.getTaskStatus` | 1 | this doc §3.1 |
| 3 | Repoint `/operations` at it; then crawlagent is deletable | 2 | Tier 1.2 |
| 4 | Tier 0 deletions (§4) | 1 | `10-refactor-priorities.md` |
| 5 | Measure and delete the `syncaiapi.ts` registrations | nothing | Tier 2.1 |
| 6 | Proxy UI (4c) | 1 | this doc §5 |
| 7 | Job-creation contract (4) | 2 | this doc §5 |
| 8 | Commit webrain's uncommitted load-bearing work — **no tagged release contains the auth gate** | nothing | Tier 1.4 |

---

## §7 Storage consolidation — one writer, one credential, one bucket

Measured 2026-10-10, after the six storage defects were closed.

| Fact | Where | Value |
|---|---|---|
| Storage service of record | `functions/src/infrastructure/s3-blob-store.ts` + BFF `/api/storage/*` (5 routes) | fail-closed `tigrisConfigFrom()`; `TIGRIS_BUCKET` defaults to **`""` = not configured** (deliberate) |
| Platform credential names | `functions/src/config/env.ts` | `AWS_*` first, `TIGRIS_*` fallback |
| crawlagent credential names | `crawlagent/storage.py` | `AWS_*` first, `TIGRIS_*` fallback — **aligned** |
| crawlagent region | `crawlagent/storage.py` | `AWS_REGION` → config `region` → `auto` — **aligned** |
| crawlagent default bucket | `crawlagent/config.yml` `storage.primary` | `crawlagent.bucket.a` — **hardcoded, unlike the platform's empty default** |
| Second artifact writer | `upload_compressed_file`, `_upload_multipart`, `download_file_decompressed` | **zero callers** — proven dead by whole-repo grep |
| Live crawlagent storage users | `server.py` (init), `routers/diagnostics_router.py` (health), `backup_tasks.py` (backups) | diagnostics + backup only — **the crawl path never touches storage** |

### Decision

1. **Storage service of record = the BFF `/api/storage/*` surface over `s3-blob-store.ts`.** No other
   component mints artifact writes or presigns client downloads.
2. **crawlagent stops being an artifact writer.** The dead `upload_compressed_file` /
   `_upload_multipart` / `download_file_decompressed` trio *is* the second writer; removing it is the
   consolidation. It is an **owner decision**, not an obvious one: that code was just carefully fixed,
   which implies an intent to keep it. Either delete it, or record why it is kept.
3. **crawlagent keeps exactly three storage responsibilities** — health check, backups,
   `list_files_paginated`. None is client-facing, none is an artifact path.
4. **One credential, one region, one endpoint** — already true (§§ 2/3 above).

### The one thing blocking a true single storage system

**Bucket identity is a deployment fact, not a code fact.** The platform's default is empty
(fail-closed, deliberate: "a wrong default is a bucket"); crawlagent's is a hardcoded
`crawlagent.bucket.a`. Whether production points them at one bucket or two lives in the
secret/env store and **cannot be read from the repo**.

Until that is answered, "one storage system" is a *shared code layer with possibly two buckets* —
which is a coherent state, but it must be a **chosen** one. Decide it before any migration, because
the migration differs completely: one bucket means the dead trio is a duplicate writer to delete;
two buckets means they are separate systems that merely share credential names.

---

## §8 Why this is a refactor, not a rebuild

The ask was "rebuild or refactor the whole system to a unique architecture". The measurements say
refactor, and specifically **not** rebuild:

- **The frontend↔BFF wiring is already closed** — 57 routes, **0** client calls with no route
  (`bunx tsx scripts/route-parity.ts`). There is no wiring problem to rebuild away.
- **The six storage defects were specific and small**, and all six are now closed.
- **webrain and functions/Firestore are, in the owner's own words, OK** — a rebuild discards them.
- **The remaining gaps are three named things** (§3.1 the missing `/ws`, §5's four design pieces,
  `syncaiapi.ts`'s unmounted routes) — not a structural failure.

Rebuilding four services to fix "a missing `/ws` route, a legacy storage module, and stale docs" is
the most expensive possible response to the smallest possible problem set. The gaps are cheaper to
close directly, and §6 sequences them.

**What would actually justify a rebuild** — none of it currently evidenced:

1. `scripts/route-parity.ts` reporting unrouted client calls.
2. More than one component writing the same bucket with divergent metadata.
3. A service whose test suite cannot be made green.
4. The same defect class recurring after being fixed (i.e. a missing *gate*, not missing code).

Point 4 is the one to watch: the storage defects recurred because **no gate validates
`ContentType`/`ContentEncoding` on write**, and because two components each had their own writer.
The fix for a recurring defect class is a test, not a rewrite.

---

## §9 Code-graph service exposure (`mcp_codebase-memo_*`) — what remains

Audited 2026-10-10 against `docs/ADR-2026-09-MCP-SERVICE-EXPOSURE.md` (5 phases, 7 tasks).
**Headline: 0 of 7 tasks are done, and 0 of the 5 phases are implemented.** The ADR is still
`Status: proposed`. What exists is the *prerequisite* — local artifact generation — and nothing else.

### Per layer, measured

| Layer | ADR expects | Measured | Status |
|---|---|---|---|
| **Phase 0** artifact | `graph.db.zst` + `artifact.json` | **Exists.** `.codebase-memory/{graph.db.zst, artifact.json, .gitattributes}`, regenerated **2026-10-10T10:07Z**, 60.3 MB → **7.7 MB**, `compression_level: 3`, pinned `commit` | ✅ generates **locally only** |
| **Phase 0** publication | publish on push to `main` | `.codebase-memory/` is **gitignored** (`.gitignore:77`), **untracked**; the 5 workflows (`codeql`, `firebase-hosting-{merge,pull-request}`, `release`, `test`) publish nothing; **no R2 config exists** — `R2_*` / `CLOUDFLARE_R2` / `r2.dev` return **0 hits** | ❌ absent |
| **Phase 1** BFF | `bff/graph.ts` + `/api/graph/*` | `bff/graph.ts` **does not exist**; `/api/graph` appears in **docs only**, never in code; the BFF's 12 route families are unchanged | ❌ absent |
| **Phase 1** authz | `graph` resource if Q3 says so | `AuthResources` = `ai`, `crawl`, `machine`, `billing`, `organization`, `account`, `platform`, `storage` — **no `graph`** | ❌ absent (Q3 unanswered) |
| **Phase 1** client | paid user queries the graph | **0** `Graph*Service/Query/Api/Component/Route` under `src/app/**` | ❌ absent |
| **Phase 2** arachnefly | graph container as a **second machine class** + stdio↔HTTP bridge | the only `graph` match in the whole repo is `GET /metricsgraph` — a Prometheus metrics page. No CBM/`codebase-memory` reference, no second image class | ❌ absent |
| **Phase 3** free tier | artifact download + `--tool-profile=scout` | no route, no client. **Mechanism already exists:** `POST /api/storage/presign` already mints scoped, time-limited object URLs | ❌ absent, reusable piece exists |
| **Phase 4** metering | graph queries debited like crawl credits | nothing to meter (no route). **Instruments exist:** `applyBillingCreditMutation` (exactly-once on `idempotencyKey`) + the fail-closed spend cap | ❌ absent, instruments exist |
| **webrain** | no role in this ADR | `codebase-memory` matches only in **`.md` docs**. Its own `docs/adr/0002` records that `codebase-memory-mcp 0.11.x` **refuses webrain's repo path as a "system" directory**, so `cbm_workspace_root_allowed` never fires | ➖ no role; hazard documented |
| **crawlagent** | no role in this ADR | **zero** matches for `codebase-memory` / `graph.db` / `CBM_` / `mcp` | ➖ no role |

### Three blockers nobody has decided

1. **The publish target does not exist.** Both the ADR and `copilot-instructions.md` say "publish to
   **R2**", but there is **no R2 configuration anywhere in the repo**. The platform's object store is
   **Tigris/S3** via `s3-blob-store.ts` (`TIGRIS_BUCKET`, default `""` = not configured). Phase 0 is
   therefore blocked on a decision, not on code: reuse Tigris, or introduce R2 as new infrastructure.
2. **The artifact's identity field is machine-local.** `artifact.json.project` is
   `D-Windows-Documents-Programming-Projects-Angular-deepscrape` — the local path name. Publication
   is keyed by `owner/repo@sha`; the `commit` field is already there, the `project` key is not
   publishable as it stands. A transformation is needed, and nobody has specified it.
3. **`.gitattributes` and `.gitignore` contradict each other.** codebase-memory-mcp auto-writes
   `.codebase-memory/.gitattributes` (`graph.db.zst merge=ours binary`) on the assumption the
   artifact **is committed**, while `.gitignore:77` ignores the whole directory. The merge-conflict
   protection is therefore **inert**. Decide: commit it and accept the documented history growth
   (the ADR's ~6 GB warning; 7.7 MB × N commits is the real arithmetic), or publish out-of-band and
   drop the committed-artifact assumption.

Also unmet: the ADR names the **Best** tier (`zstd -9`, index-stripped, `VACUUM INTO`) as the
publishable quality, while the artifact on disk reports `compression_level: 3`.

**Corrected 2026-10-10 after reading upstream.** That is not a defect — it is the normal lifecycle.
Upstream writes **Best** only from `index_repository(persistence: true)`; every *other* index, including
the watcher's incremental refresh, rewrites the artifact at the **Fast** (`zstd -3`) tier. What is on
disk is therefore the watcher's refresh of an earlier Best export. The consequence for phase 0 is real
but narrow: the publish step must **trigger a Best export** rather than snapshot whatever the watcher
last left.

### What is genuinely reusable

This is not greenfield. Three pieces the plan can build on rather than invent:

- `POST /api/storage/presign` → phase 3's artifact download (a signed URL, no new pattern).
- `applyBillingCreditMutation` + the fail-closed spend cap → phase 4's meter (step 15 is complete).
- arachnefly's `POST /deploy` + `execute-task` + `MachineOwnershipMiddleware` → phase 2's second
  container class (the SKILL's own note: "the graph containers are just a second container class").

---

## §10 Production readiness & top-down gap analysis

Audited 2026-10-10, frontend as the top layer and the three services as the bottom, using
`check_index_coverage` plus direct source reads. **The graph generation was `2026-10-10T10:07:06Z`
while the tree is at `+185 ~125 -15`, so every row below was confirmed by reading source, not by
querying the graph.**

### A. Can each surface run on production env today?

| Layer | Service | Production env source | Verdict | Blocker |
|---|---|---|---|---|
| top | Angular app | `prod_gen.ts` → generated `environment.ts` (public config only; provider keys blanked) | ✅ | `wsUrl` is a build constant, not env |
| top | BFF (Bun/Elysia, Cloud Run) | `FUNCTIONS_ENV_JSON` + `FIRE_SERVICE_ACCOUNT_KEY` + `SSR_*`/`PORT` | ✅ | Upstash falls back; **serves no `/ws`** |
| top | Functions | the same `FUNCTIONS_ENV_JSON` | ✅ | two declared-but-undeployed indexes |
| bottom | **arachnefly** (Fly) | `PORT`, Fly token, Firebase JWT | ⚠️ | the reaper is **source-only** — the deployed build may predate it |
| bottom | **webrain** (Fly, `mcp.deepscrape.dev`) | `WEBRAIN_HTTP_TOKEN` | ⚠️ | platform calls it `WEBRAIN_MCP_TOKEN` — **one value, two names, two stores** |
| bottom | **crawlagent** (Fly, `crawlagent.fly.dev`) | its own `.env` | ❌ | LEGACY / do-not-push, yet still a live default *and* still the websocket host |

**The framing that matters:** 38 keys are read with **no default** (`getConfigValue("X")` with no second
argument) — `COOKIE_SECRET`, `CSRF_COOKIE_SECRET`, `WEBRAIN_MCP_TOKEN`, `TIGRIS_*`, `QSTASH_*`, the
provider keys, all 13 `STRIPE_PRICE_*`, and others. A missing one does **not** fail at boot; it fails at
**first use**. So "it runs on production env" and "it works on production env" are different claims —
the BFF booted cleanly locally with Upstash disabled, which is exactly this shape.

### B. Frontend surface → service, top down

| # | Frontend surface | Calls | Via BFF? | Service | State |
|---|---|---|---|---|---|
| 1 | Operations — create job | `/api/crawl/stream/job` | ✅ | webrain | works |
| 2 | **Operations — task progress** | `wss://agent.deepscrape.dev/api/v1/ws/task/status?token=…` | ❌ **direct** | **crawlagent** | **unguarded; legacy** |
| 3 | Playground | `/api/{scrape,serp,search,extract,pdf}` | ✅ | webrain | works |
| 4 | Browser sessions | `/api/browser/session*` | ✅ | functions + Firestore | works |
| 5 | Live frames | `/api/browser/session/:id/frame` | ✅ | arachnefly | works |
| 6 | Machines | `/api/machines/*` | ✅ | arachnefly | works |
| 7 | AI chat | `/api/{anthropic,openai,groq}/*` | ✅ | vendors | works |
| 8 | Storage | `/api/storage/*` | ✅ | Tigris/S3 | works |
| 9 | Billing | callables + `/api/billing/policy` | mixed | Stripe + functions | works |
| 10 | Analytics | callables | ✅ | functions | works |
| 11 | neko live view | `environment.nekoUrl` | ❌ | — | **removed** (unmounted 2026-10-10) |

**So: webrain and arachnefly capabilities DO reach the frontend — every row except 2 and 11 goes
through the BFF with a guard.** The single hole is row 2.

### C. The websocket, precisely

`src/app/core/services/websocket.service.ts`:

```ts
this.webSocketAPI_URL = `${environment.production ? environment.wsUrl + '/api/v1' : ''}`
```

- **Production and staging:** `staging.ts` sets `"production": true`, so both resolve to
  `wss://agent.deepscrape.dev/api/v1` → **crawlagent**, with the Firebase ID token in the **query
  string**.
- **Local dev:** resolves to `''` → a relative `/api/v1/ws/...` → proxied to the BFF → **which serves no
  WebSocket at all**. So the live channel is **broken in development and working in production**, the
  inverse of the useful direction.
- `connectToGeneralSocket()` is **commented out**; only `connectAndTrackTasks` runs.

### D. Gaps, ranked — re-measured after the 2026-10-10 implementation pass

Rows 1–5 are **closed**. Row 2 was **wrong** and is retracted: the BFF already served four guarded
stream routes (`/api/job/stream/status/:taskId`, `/api/job/stream/:taskId`, plus the
`/api/crawl/stream/job/*` aliases), and `CrawlAPIService.getTaskStatus` already consumed them. The
fix was therefore a **repoint, not a build** — no `/ws` route was ever needed.

| # | Gap | Where | Severity | State |
|---|---|---|---|---|
| 1 | Task-progress channel bypassed the BFF entirely — no guard, entitlement, metering or CSRF, against a **legacy** service. | `websocket.service.ts` | 🔴 | **closed** — now polls the BFF via `CrawlAPIService.getTaskStatus` |
| 2 | ~~The BFF serves **no `/ws`** — so #1 is a **build**, not a redirect~~ | `bff/` | — | **retracted — this was false** |
| 3 | Firebase ID token passed in a **query string** (proxy/access logs, Referer) | `websocket.service.ts` | 🟠 | **closed** — no token in any URL |
| 4 | Live channel broken in **local dev**, works in prod | same ternary | 🟠 | **closed** — same-origin `/api` in every environment |
| 5 | `WEBRAIN_MCP_TOKEN` ≠ `WEBRAIN_HTTP_TOKEN` — one value, two names | env | 🟠 | **closed** — `WEBRAIN_HTTP_TOKEN` preferred, `WEBRAIN_MCP_TOKEN` as fallback |

Rows 6–10 stand:

| # | Gap | Where | Severity |
|---|---|---|---|
| 6 | arachnefly deployment may **predate** the reaper (source-only) | Fly | 🟠 |
| 7 | Two Firestore indexes declared, **undeployed**; production answers `FAILED_PRECONDITION`, which the admin page renders as "no sessions" while customers are billed | `firestore.indexes.json` | 🟠 |
| 8 | arachnefly's **dev default is `localhost:8080`** — the same port the BFF binds, so the BFF calls itself | `config/upstreams.ts` | 🟡 |
| 9 | `ENV_CONFIG_MATRIX.md` §3.1 still documents `nekoUrl` (deleted) and says `wsUrl` "has no dev branch" — `wsUrl` is now read by **nothing** | doc | 🟡 |
| 10 | Two roadmap docs numbered **12** (`12-production-harmony.md` and this file) | docs | 🟡 |

**Do not re-audit rows 1–5.** A stale version of this table caused a near-miss: §5 item 4c was
recorded as "proxies — a caller-facing proxy surface does not exist", but
`src/app/pages/admin/admin-webrain.component.ts` already implements the full pool editor (masked
host label + host, add/remove draft rows, replace-all behind a confirm dialog) over
`WebrainConfigService.setProxies`, and `bff/api.ts` guards `POST /api/webrain/config/proxies` with
`perm('platform','write')`. **The gap list itself was the defect.** Re-measure a row before building it.

### E. What is NOT a gap

- The frontend↔BFF wiring is closed: 57 routes, 0 client calls with no route
  (`bunx tsx scripts/route-parity.ts`).
- webrain and arachnefly both reach the frontend, guarded, through the BFF — including the frame path
  end-to-end.
- `check_index_coverage` reports `no_recorded_issue` on every path checked; it correctly reported my
  **guessed** path `crawl-api.service.ts` as `missing` (the real file is `crawlapi.service.ts`), which
  is the tool behaving as documented — no recorded gap is not proof of completeness.



