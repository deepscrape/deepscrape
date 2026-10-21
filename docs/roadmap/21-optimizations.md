# 21 — Optimizations: latency, cost, duplicate work, and shrink

Status: living document. Created 2026-10-20. Branch `next`.

This is the optimization counterpart to `20-must-fix.md`. That file is a **saved transcript** of the
2026-10-20 review session (it contains the tool calls, not a curated plan), and it lists
correctness and security defects. This one asks a different question: **what does one request
cost us, in milliseconds and in euros, and what is unnecessary in it?**

Everything here is read from source. **Status corrected 2026-10-21:** the 2026-10-20 session below
ran in a sandbox where `grep`, `glob` and PowerShell all failed, so it could not build, test or
profile anything. That is no longer true — in a working terminal on 2026-10-21 the **functions** and
**Angular** gates ran clean (results in §11 and §12) and the applied edits were committed on `next`
in ten focused commits. The **BFF** was not run, nothing was profiled, no bundle was measured, and
no preview deploy happened. Read every number below as still labelled:

| Label | Meaning |
|---|---|
| **read** | an exact value quoted from a file in this repo |
| **reasoned** | arithmetic from values that were read, with the arithmetic shown |
| **estimate** | a judgement with no measurement behind it — treat as a hypothesis to test |

**Already applied in this session** (Phase A + B of §9, all surgical):

| # | Change | File |
|---|---|---|
| O1 | `serviceAccount.json`, `*.spec.ts`, `docs/`, `dist/server`, `functions/databases` excluded from the image context | `.dockerignore` |
| O23 | a `functions/**`-only merge now builds Angular, so `COPY dist/…` cannot fail | `firebase-hosting-merge.yml` |
| O24 | Hosting deploy switched from `action-hosting-deploy` (no `target`) to the CLI | `firebase-hosting-merge.yml` |
| O26 | rules + indexes + storage now have a deploy step | `firebase-hosting-merge.yml` |
| O6 | traffic counter no longer awaited | `bff/traffic-counter.ts` |
| O9 | `--max-instances=10 --concurrency=40 --cpu-boost` | `firebase-hosting-merge.yml`, `bff/package.json` |
| O28 | status poll no longer restarts itself on every result (+ 1 spec) | `websocket.service.ts`, `websocket.service.spec.ts` |
| O14 | session lookups bounded to live states instead of reading every session ever | `browser-session.store.ts` |
| O19 | service worker no longer prefetches all 110+ lazy chunks | `ngsw-config.json` |
| O25 | `no-cache` for HTML / `ngsw.json` / `ngsw-worker.js` on all three sites | `firebase.json` |
| O35 | every event was logged to GA4 twice; the duplicate pass is deleted | `analytics.service.ts` |
| O31 | the analytics `onSnapshot` is detached on page exit and re-armed on return | `firestore-analytics.service.ts`, `admin-analytics.component.ts` |
| O34 | boot no longer issues `GET /status` (no route, so it paid the page rate limiter for an 86 KB shell) | `app.component.ts`, `analytics.service.ts`, `analytics.service.spec.ts` |
| O32 | `listMyOrganizations` collapses concurrent calls and caches the list for 30 s, keyed on the uid | `organization.service.ts`, `organization.service.spec.ts` |
| O20 | the layout barrel is no longer imported, from the routes or from inside the layout | `user.route.ts`, `service.route.ts`, `app.routes.ts`, `app-sidebar-nav-link.component.ts` |
| O22 | the 404 no longer pulls in the 44-service barrel; dead `firestore-cache` re-export removed | `app-not-found.component.ts`, `core/services/index.ts` |
| O18 | `listOrganizations` reads every org in one `getAll` instead of one round trip each | `functions/src/infrastructure/syncaiapi.ts` |

**Nothing in the table above has been typechecked or tested** — see §12 for what proves each one.

---

## §1 Service inventory

Measured from `.codebase-memory/artifact.json` (23,482 nodes / 44,350 edges, built
`2026-10-20T11:27:34Z` against commit `b8ed99d7`) plus `12-service-orchestration-and-layer-inventory.md`.

`codebase-memory`'s query tools (`query_graph`, `search_graph`, `trace_path`) were **not
available** in this session, so the artifact served as the service inventory and freshness
gate only. It is also **stale against the working tree**, which now carries uncommitted fixes
from `20-must-fix.md`.

| Service | Runtime | Where | Surface | Optimization relevance |
|---|---|---|---|---|
| Angular client | Angular 20, zoneless | CDN via Hosting | 110+ hashed chunks, 3 Hosting targets | §6 — every page load |
| **BFF** | Bun + Elysia | Cloud Run `us-central1`, 1 vCPU / 512 MiB, min 1 | 57 routes; `/api`, `/event`, `/oauth`, page shell | §4, §5 — the hot path |
| Functions | Node 22 | Firebase Functions | 101 exports (callables, triggers, sweeps) | §5 — billing, meters |
| arachnefly | Go / Fiber | Fly | 14 routes (machine lifecycle, `/machine/mcp/:id`) | §4 — frame path |
| webrain | Rust | Fly `iad`, `min_machines_running = 1` | MCP-over-HTTP tools | §4 — +20–30 ms hop |
| Meilisearch | — | Fly `fra` | **no client in this repo** | §4 — dead infra until a client exists |
| crawlagent | Python / FastAPI | Fly (legacy) | 20 routes | **do not build on** |
| Upstash Redis | managed | region unverified | limiter, authz, leases, counters | §5 — round-trip count |
| Firestore | managed | databases `easyscrape`, location unverified | billing, sessions, machines, jobs | §5 — read amplification |
| QStash | managed | — | one message per crawl target | §4 — enqueue latency |
| Stripe | SaaS | — | checkout, webhooks, refunds | §3 of `19` |

**The structural fact that decides most of §4:** `bff/api.ts` is the only served `/api`
surface, and **the BFF contains no Angular render engine**. `bff/server.ts:18-21` says it
outright — *"No Angular engine — pages are served as the client-rendered shell"*. It serves
`index.csr.html` for anything without a static file behind it.

---

## §2 What one page view does today

`firebase.json` rewrites `**` → Cloud Run for all three Hosting targets. `app.routes.server.ts`
declares ten route families as `RenderMode.Server` (`admin/**`, `settings/**`, `dashboard/**`,
`operations/**`, `user/**`, `billing/**`, `crawlpack/**`, `playground/**`, `chatai/**`,
`:orgId/**`). Hosting has no static file for those paths, so they hit the container.

Per page view (**read**, from the code path):

| Step | Work | Cost |
|---|---|---|
| 1 | Cloud Run instance invocation | 1 billed request + instance-second |
| 2 | `security` plugin: parse cookies, HMAC, set two `Set-Cookie` | 0 I/O |
| 3 | `guestTracker` `onBeforeHandle` | 0 I/O if `aid` cookie present |
| 4 | `trafficCounter` `onAfterHandle` | **1 awaited Redis round trip** |
| 5 | `limitFunction` | **1 Redis round trip** |
| 6 | Serve `index.csr.html` (~40–90 kB, **estimate**) | 0 |

So: **two sequential Redis round trips and a container start, to return a file that never
changes between deploys.** At a ~20–30 ms Upstash RTT from `us-central1` (**estimate**), that
is ~40–60 ms of avoidable latency plus the container's own TTFB, on every navigation to a
protected route — and it is the traffic that trips the per-IP `100 / 15 min` page limiter,
which is why users intermittently see a 429 on navigation.

**Finding O4 below is the single largest win in this document.**

---

## §3 Critical security

### O1. A Firebase service-account key is baked into every locally-built image — 🔴 CRITICAL

- **What this is:** `functions/src/serviceAccount.json` sits on disk (confirmed by directory
  listing), is explicitly gitignored (`.gitignore`, last line of the Firebase block), and is
  copied into the image because `Dockerfile:20` is `COPY functions/src /functions/src`.
- **Problem (read):** `.dockerignore` excludes `**/.deploy-secrets.json` but **not**
  `serviceAccount.json`. The documented deploy path in `.github/copilot-instructions.md` is
  `docker build -t deepscrape-bff:local .` then `docker push`. A single local build therefore
  publishes a private key to Artifact Registry as a layer, where anyone holding
  `artifactregistry.reader` can pull it. CI checkouts do not have the file, so **CI is clean and
  will never show this**.
- **Fix:** add to `.dockerignore`:
  ```
  **/serviceAccount.json
  functions/src/serviceAccount.json
  ```
  One line each. Nothing else changes.
- **If we skip it:** a full-privilege GCP key in a registry. The only remediation after a push
  is rotating the key and purging every digest that carried it.

### O2. The only abuse brake can be both absent and bypassed — 🔴 CRITICAL

- **What this is:** three independent weaknesses that compose.
- **Problem (read):**
  1. `firebase-hosting-merge.yml:188-194` passes `--allow-unauthenticated` with
     `--min-instances 1` and **no `--max-instances`** → platform default ceiling of 100
     instances × 1 vCPU.
  2. `bff/limiter.ts` derives the bucket from `clientIp`, which trusts `x-forwarded-for` when
     `cf-ray` is absent — the file says so: *"a direct-to-origin caller can still lie about its
     IP"*. The `.run.app` origin is reachable directly, so a caller can mint a fresh
     `100 / 15 min` bucket per request.
  3. Every Upstash error path returns `undefined` (fail-open, deliberate and correct for a rate
     limit). If `FUNCTIONS_ENV_JSON` fails to bind, `createNoopRedis()` **answers every command
     successfully**, so the limiter believes it is working and permits everything.
- **Fix (two of three are one line):**
  - `--max-instances=10` in **both** deploy paths (`firebase-hosting-merge.yml` and
    `bff/package.json:deploy:cloud`). Overflow answers 429 instead of billing. **Applied.**
  - Reject a direct origin in `bff/server.ts`: if `Host` ends in `.run.app` and the path is not
    `/health`, answer 404. ~6 lines. This makes XFF spoofing irrelevant rather than fixing it.
    **NOT applied** — see the note below.
  - Keep fail-open — the bound is what makes fail-open survivable.
- **Why the Host check was deferred:** Firebase Hosting's Cloud Run rewrite may present the
  service with a `*.run.app` `Host` header rather than the original domain. If it does, a blanket
  `.run.app` rejection rejects **every legitimate request** — a total outage. Verify against one
  real request (log `Host` for a page served through `deepscrape.dev`) before adding the check.
- **If we skip it:** one Upstash incident, one credential rotation, or one scripted flood is an
  unbounded-cost event, not a degraded one.

### O3. Remaining holes carried over from `20-must-fix.md` — 🟠 HIGH

Not repeated in full; these are the ones that interact with cost or latency:

| # | Hole | File | Interaction |
|---|---|---|---|
| 38 | Anonymous callable bucket takes XFF `[0]`, and loopback skips metering | `infrastructure/callable-limiter.ts:100-116` | Same spoofing class as O2 |
| 42 | `/oauth/provider/email/:email` is an unmetered existence oracle | `bff/oauth.ts:137-140` | Unlimited enumeration on a public route |
| 47 | SSRF guard misses `2130706433`, `0x7f000001`, `0177.0.0.1`, `0` | `domain/url-guard.domain.ts:42-44` | Reachable via caller-supplied BYOK/CDP endpoints |
| 5 | BYOK AI secrets survive account erasure | `gfunctions/admin-users.ts:1374-1384` | GDPR, not cost |
| 17 | Tier limiter unreachable → paid users on the free bucket by IP | `bff/api.ts:176-185` | The 429s in §2 |

---

## §4 Latency

### O4. Every app page view is a billed container request serving a static file — 🟠 HIGH, largest win

- **What this is:** §2. The BFF has no render engine; `RenderMode.Server` collapses to "serve
  the CSR shell", but the request still costs a container invocation and two Redis round trips.
- **Problem (read):** ten route families are `RenderMode.Server`; `firebase.json` rewrites `**`
  to Cloud Run. Nothing about those paths is per-user. A CDN can serve them.
- **Fix:** add **static rewrites before** the `run` rewrite in all three Hosting targets:
  ```json
  { "source": "/admin{,/**}",       "destination": "/index.csr.html" },
  { "source": "/dashboard{,/**}",   "destination": "/index.csr.html" },
  { "source": "/operations{,/**}",  "destination": "/index.csr.html" },
  { "source": "/settings{,/**}",    "destination": "/index.csr.html" },
  { "source": "/billing{,/**}",     "destination": "/index.csr.html" },
  { "source": "/crawlpack{,/**}",   "destination": "/index.csr.html" },
  { "source": "/playground{,/**}",  "destination": "/index.csr.html" },
  { "source": "/chatai{,/**}",      "destination": "/index.csr.html" },
  { "source": "/user{,/**}",        "destination": "/index.csr.html" },
  { "source": "/:orgId{,/**}",      "destination": "/index.csr.html" }
  ```
  Rewrites are first-match-wins, so these must precede the `**` → `run` entry. Optionally also
  set those families to `RenderMode.Client` so the prerenderer stops emitting them.
- **Impact:** removes the container invocation, both Redis round trips and the page limiter from
  the path every navigation takes. TTFB becomes a CDN hit. **The 429-on-navigation class
  disappears with it**, because the page no longer passes a rate limiter at all.
- **Risk to manage:** if `index.csr.html` is ever missing from the upload, all app routes 404.
  Verify the file exists in `dist/deepscrape/browser` after a build **before** shipping, and keep
  the run rewrite as the fallback for everything not listed.

### O5. `verifyIdToken` runs with `checkRevoked` on every authenticated request — 🟠 HIGH

- **What this is (read, verified):** `functions/src/infrastructure/syncaiapi.ts:161` —
  `await auth.verifyIdToken(token, true)`. The `true` makes the Admin SDK fetch the user record
  from Identity Toolkit after the local signature check.
- **Problem:** every request pays a googleapis HTTPS round trip (~25–60 ms, **estimate**).
  `/event/heartbeat` pays it on a browser timer, and the job-status poll pays it every ~2 s per
  open job. It also puts Identity Toolkit availability inside the request deadline.
- **Fix:** drop the flag **only if** every route that skips `requirePermission` also consults the
  tombstone. `authz.middleware.ts` already reads it from Redis; `account-tombstone.ts` exists for
  exactly this. Where a paid route runs no permission check, keep `checkRevoked` or add the
  tombstone read. Do not flip this blindly — it is a security trade, and the condition above is
  the whole decision.
- **If we skip it:** +25–60 ms on every authenticated request, permanently.

### O6. An awaited Redis round trip is added to every response — 🟠 HIGH, one line

- **What this is (read, verified):** `bff/traffic-counter.ts:63` — `await count()` inside a
  global `onAfterHandle`, and `countServedRequest` awaits `redis.incr`. Elysia does not flush the
  response until `onAfterHandle` resolves.
- **Problem:** every served request pays a sequential Upstash round trip for a counter with a
  **one-day resolution**, read once a day by `computeActiveUsersNow`. It is the second serialised
  Redis hop in §2.
- **Fix:** `void count().catch(() => undefined)`. One line.
- **If we skip it:** ~20–30 ms added to every page view and every QStash delivery (**estimate**).

### O7. Two read-modify-write transactions per paid request — 🟠 HIGH

- **What this is (read):** `functions/src/app/billing-credits.ts` — `applyBillingCreditMutation`
  opens a transaction, reads `billing/current` **and** the ledger doc, validates, writes both.
  `requirePaidAccess` reserves, then `bridge.ts` `finalize` consumes and **awaits it before the
  Response is handed back**.
- **Problem:** 2 transactions = 4 reads + 4 writes on the hottest document in the system, and the
  second one is inside time-to-last-byte. `consume` validates nothing new — the credits were
  already reserved.
- **Fix:** make `consume`/`release` a single `update()` with `FieldValue.increment(-amount)` on
  `balance`/`reserved`. Only `reserve` needs the read, because it enforces `reserved ≤ balance`.
- **If we skip it:** ~10–20 ms of TTFB per paid request (**estimate**) plus 2 billed reads, plus
  contention that makes reservations retry under load.

### O8. The live-view route reads Firestore once per frame — 🟠 HIGH

- **What this is (read):** `handlers/browser-sessions.ts` — `browserSessionFrame` calls
  `readBrowserSessionRecord(uid, id)` before asking the machine for a screenshot.
- **Problem (reasoned):** the route is polled at the tier fps. `SESSION_CAPS` gives paid `1 fps`
  and admin `4 fps`. A single session at 1 fps for a day = **86,400 Firestore reads** for a
  record that changes only on keepalive and close. The file already keeps per-instance state for
  this route (`lastFrameAtMs`), so per-instance caching is an accepted pattern here.
- **Fix:** cache the parsed record per `${uid}:${id}` for the route's own frame interval, using
  the map and eviction that already exist; invalidate on `close` and `attachMachine`.
- **If we skip it:** the largest single read source on the session surface, and it scales
  linearly with sessions × fps.

### O9. Cloud Run is missing the flags that make it fast — 🟠 HIGH

- **What this is (read):** `firebase-hosting-merge.yml:190-194` passes
  `--memory 512Mi --cpu 1 --min-instances 1`. Not passed: `--max-instances`, `--concurrency`,
  `--timeout`, `--cpu-boost`.
- **Problem (reasoned):**
  - Default `--concurrency=80` against 1 vCPU with `maxRequestBodySize: 8 MiB`
    (`bff/server.ts`) means a worst case of **80 × 8 MiB = 640 MiB** of bodies against a
    512 MiB limit that also holds the Bun heap, the `dist` mount and firebase/Stripe/gRPC.
    ~50 concurrent maximal bodies already exceeds the budget.
  - No `--cpu-boost` means a cold start pays full boot CPU, on a service with `min-instances 1`
    that still scales out on load.
  - No `--timeout` leaves the 300 s default, and the QStash crawl worker runs the whole crawl
    **inside the request** — so a slow target is killed at the platform before the handler can
    answer `502 {retry:true}`, and QStash re-runs and re-bills the same target.
- **Fix:** `--max-instances=10 --concurrency=40 --cpu-boost --timeout=3600` on the crawl-worker
  path. `--timeout` applies per revision, so if page and crawl traffic share one revision, raise
  it and rely on the per-route `Bun.serve` `idleTimeout` for the streaming routes.
- **If we skip it:** one burst of large POSTs OOM-kills the instance and every in-flight stream
  on it, including crawls mid-flight.

### O10. Cross-region hops — 🟡 MEDIUM

- **What this is (read):** BFF `us-central1`; webrain and browser-session machines `iad`; arachnefly
  on Fly (region unverified); Meilisearch `fra`.
- **Problem (estimate):** `us-central1` ↔ `iad` ≈ 20–30 ms RTT, paid on every `/api/scrape`,
  `/api/serp`, `/api/search` and every frame. `fra` ≈ 100–120 ms — but **no code in this repo
  calls Meilisearch** (no client under `functions/src/infrastructure/`, no handler), so `fra` is a
  future hop, not a current one. It also contradicts `webrain-engine/fly.toml`'s stated rationale
  for co-location.
- **Fix:** none now for `iad` — 20–30 ms against a multi-second scrape is noise. When the
  Meilisearch client is written, put the query path beside webrain, not in `fra`.
- **If we skip it:** an unplanned 100+ ms the day the search client lands.

### O11. Outbound calls use `node-fetch` with no timeout and no pooling — 🟡 MEDIUM

- **What this is (read):** `infrastructure/webrain-mcp.ts`, `browser-session.provisioner.ts` and
  `handlers/machines.ts` import `fetch` from `node-fetch` rather than using Bun's global `fetch`.
- **Problem (reasoned):** each call pays a fresh TCP + TLS handshake (~40–100 ms, **estimate**),
  and a hung worker holds the route to the platform timeout while the worker lease and the credit
  reservation stay held. The provisioner's "no timeout on deploy" argument is deliberate and
  should stay; it does not apply to `tools/call` or `check-image`.
- **Fix:** Bun's global `fetch` (pooled) with `signal: AbortSignal.timeout(25_000)` on the tool and
  read paths. `storage.ts` already uses `AbortSignal.timeout`, so the pattern exists.

### O12. One QStash client per crawl target — 🟡 MEDIUM

- **What this is (read):** `infrastructure/qstash.ts` constructs `new Client(...)` inside
  `publishCrawlTarget`, which `multiCrawlEnqueue` calls once per target.
- **Problem (reasoned):** a 50-target job = 50 client constructions, 50 TLS handshakes, 50
  sequential publishes **inside one HTTP request**. Enqueue latency is O(targets) with a handshake
  constant, and it races the platform timeout before the job id is even returned.
- **Fix:** module-scope singleton `Client`, and publish the batch with `Promise.all` (each message
  keeps its own retries and failure callback).

---

## §5 Duplicate and redundant work

### O13. The billing document is read up to four times in one paid AI request — 🟠 HIGH

- **What this is (read):** `requirePaidOrByok` reads `users/{uid}/billing/current`, then delegates
  to `requirePaidAccess`, which reads it again; `reserve` and `consume` each read it inside their
  transactions.
- **Problem:** 4 reads of one document on `POST /api/anthropic/messages`, 3 on `/api/crawl`. There
  is no entitlement cache, unlike memberships which already has a 60 s Redis TTL. The `ponytail:`
  note at `requirePaidOrByok` defers this "if AI-call volume ever makes that one read matter" —
  AI routes are now 10 of the 11 registered chat surfaces, so it is crossed.
- **Fix:** stash the snapshot on `req` in `requirePaidOrByok` and reuse it in `requirePaidAccess`;
  mirror `membershipsKey` with a 15–30 s `entitlement:{uid}` Redis key for the **gate** read only,
  never for the transactional one.
- **Why the first half is not applied (2026-10-20):** it saves one Firestore read — roughly one
  5–15 ms round trip, and about **$0.0000003 per call** at list read pricing. It sits directly
  upstream of `reserveBillingCredits`, which is the code that decides what a caller is charged, and
  there is no runnable test suite in this session to prove the stash does not change that decision.
  A saving that small does not buy that risk. The `ponytail:` note in the code sets the right bar —
  *"if AI-call volume ever makes that one read matter"* — and nothing here shows it does. The
  **Redis entitlement cache** half is a separate, larger change and stays open.

### O14. Session lookups read every session the account ever created — 🟠 HIGH

- **What this is (read):** `infrastructure/browser-session.store.ts` — `ownBrowserMachine` and
  `listSessionMachineIds` both do `sessionsRef(uid).get()` with no `where` and no `limit`.
- **Problem:** closed records are never pruned (the file says so), so the read is O(all sessions
  ever) and grows with account age. `ownBrowserMachine` runs inside `webrainTool` on **every**
  `/api/scrape`, `/api/search`, `/api/extract`; `listSessionMachineIds` runs on `/api/machines/mine`.
- **Fix:** the same `.where("state","in",METERABLE_STATES)` + `.limit()` that
  `listBrowserSessions` already uses. One line each.

### O15. `createBrowserSession` runs a query inside a transaction — 🟠 HIGH

- **What this is (read):** `transaction.get(sessionsRef(uid).where("state","in",METERABLE_STATES))`.
- **Problem:** the result set is small (caps are 3 BYO + 1 dedicated), so size is fine — but the
  transaction's **read range covers the caller's whole `browserSessions` subcollection**, and
  `keepaliveBrowserSession` writes inside it. A UI polling keepalive aborts the transaction and
  replays the body.
- **Fix:** keep `liveByo` / `liveDedicated` counters in one `users/{uid}/counters/sessions` doc,
  read that single doc in the transaction and increment it in the same commit.

### O16. Job status transfers the whole results document for two fields — 🟡 MEDIUM

- **What this is (read):** `handlers/webrain-jobs.ts` — `getTaskStatus` does
  `jobRef(uid, taskId).get()` on a document holding every item's `data`; `streamTaskResults`
  re-`JSON.stringify`s each item on every poll.
- **Problem:** a 50-target job's document is tens to hundreds of kB and the dashboard polls it
  every few seconds, including after the job is terminal.
- **Fix — NOT via `.select()`.** An earlier draft of this document said to project
  `status/message/total/failed/urls`. That is wrong and would break the route: `deriveStatus`
  needs `items[]` (each entry's `url` and `status`) to count DISTINCT urls, and Firestore cannot
  project fields inside an array element — selecting `items` pulls the payloads anyway. The
  available fixes are a schema change, in cost order:
  1. store each item's `data` as a **pre-serialised string** at write time (still inside
     `items`, but the read no longer has to re-`JSON.stringify` it on every poll), and
  2. denormalise a `liveStatus` field onto the job document when an item write lands, so the
     status route can `.select("liveStatus","message","total")` and never touch `items`.
  Option 1 is the cheap half and is a prerequisite for the results route regardless.

### O17. Egress settings are read per tool call — 🟡 MEDIUM

- **What this is (read):** `webrain-mcp.ts` awaits `resolveEgress(callerUid)` — an uncached
  Firestore read — before starting the worker.
- **Problem:** one `/api/scrape` costs 1 egress read + 1 full session scan (O14) + 1 Redis EVAL +
  1 billing read + 2 authz GETs + 1 counter INCR + 1 limiter. Nine dependencies before the
  outbound call.
- **Fix:** cache egress per uid for 30 s using the `inFlight`/TTL pattern
  `webrain-config.store.ts` already implements.

### O18. Three smaller ones

- **`listOrganizations` was an N+1** (`syncaiapi.ts`) — **fixed 2026-10-20.** One memberships
  query, then one `organizations/{orgId}` read per membership, issued through
  `Promise.all`. Now the org refs are de-duplicated and read with a single `db.getAll(...)`,
  and non-existent orgs are still dropped. Two details the old loop got wrong for free: `getAll`
  **rejects a repeated reference**, so two membership documents naming the same org would have
  thrown, and the old shape returned that org twice.
- **The worker-pool walk is one Redis EVAL per candidate** (`webrain-worker-acquire.ts`): a serial
  `EVAL` per worker tried. Fix: one pipeline of `SET … NX EX`, take the first success.
- **Frontend duplicates** (carried from `20-must-fix.md`): machine pagination costs `n+1` callable
  invocations to reach page `n` (`machine-store.service.ts`); `CrawlStoreService`'s constructor
  fetches a page its only consumer never reads; `metrics_daily` is read whole and `.slice()`d
  client-side; a custom analytics range reads one document per day with no clamp.

### §5b Frontend request amplification

A dedicated pass over what the logged-in client issues **per load, per navigation, per click and
per running job**. Totals: **~45 avoidable requests on a typical `/operations` load** (30+ of them
from O28 alone, in the first ten seconds) and **~60/minute per open live view**.

### O28. The status poll restarts itself on every result — 🔴 CRITICAL, a request storm. **FIXED**

- **What this is (read):** `operations.component.ts` builds
  `operations$ = combineLatest([operationsSubject, ws.taskStatus$])` with a `tap` that calls
  `connectAndTrackTasks(ids)`. That method disconnects the live poll and starts
  `timer(0, TASK_POLL_INTERVAL_MS)` — whose **first tick is immediate**.
- **Problem:** poll result → `taskStatusSubject` → `combineLatest` re-emits → `tap` → restart at
  tick 0 → immediate read → … `TASK_POLL_INTERVAL_MS` (4 s) never paces anything; the loop runs at
  round-trip speed, 5–15 requests/second for 1–3 non-final operations. It is worse than that: the
  template subscribes `operations$` **three times** and the observable has no `shareReplay`, so
  three independent `tap`s race to restart one shared poll.
- **Fix applied:** a re-entrancy guard in `connectAndTrackTasks` — an unchanged id set while the
  poll is live returns immediately. One new spec pins it
  (`websocket.service.spec.ts`, "should not restart the poll when the same ids are reported
  again"). A full fix also adds `shareReplay({bufferSize:1, refCount:true})` and moves the connect
  out of `tap`; the guard alone stops the storm.
- **If we skipped it:** every running crawl hammers a JWT-guarded, metered BFF route continuously,
  and the tab degrades as you watch more jobs.

### O29–O38. The rest of the client amplification, ranked

| # | Finding | Evidence | Fix |
|---|---|---|---|
| **O29** 🟠 | `isAuthenticated()` was a cold chain re-run per guard: **4 duplicate requests per extra subscription** (callable + user doc + forced `getIdTokenResult(true)` + heartbeat POST), and `authGuard` re-ran it on **every** in-app navigation. The "already resolved" short-circuit existed but was commented out. | `auth.service.ts` (`isAuthenticated`) | ✅ **Fixed 2026-10-21.** One chain behind `shareReplay({bufferSize:1, refCount:false})`, and `isAuthenticated()` now just returns it. A signed-in user with **no profile document** stays a sign-out; a **transient** failure now propagates instead of clearing the token, so one failed read can no longer log out a valid session. Two specs pin both halves. Gates: app TSC 0, `bun run build` 0 (14 routes prerendered), Karma **902**. No freshness stamp was added: the chain mirrors `authState()`, so a claim change still re-runs it. |
| **O30** 🟠 | Every model picker fans out **one live vendor API call per vendor** — 1 callable + up to 10 HTTPS requests, each an outbound vendor call, gated on the slowest (`forkJoin`). Three hot pages call it. | `ai-models.service.ts:83-127` | **Recommendation withdrawn.** `load()` already runs once per page life behind a `started` guard, and building the list across *all* allowed vendors is the feature — a picker that only knew the selected vendor's catalogue could not offer the others. `forkJoin`'s gating is also deliberate: `apply()` feeds the partial `live` map to `buildModelOptions`, which would briefly report every not-yet-arrived vendor as `unlisted` ("your key works but the catalogue is empty") if vendors were applied as they landed. The only honest improvement is progressive emission with a pending-count so `missing` is computed once, which is a layer, not a fix. |
| **O31** 🟠 | `/admin/analytics` reads `metrics_summary/dashboard` twice per load (a `getDoc` then an `onSnapshot` that always delivers an initial snapshot), and **never detached the listener** — `ngOnDestroy` only unsubscribed RxJS, so every write to that document billed a read for ever, from any page. | `admin-analytics.component.ts:830-846`, `firestore-analytics.service.ts:120-127`, `:567` | ✅ `stopRealtime()` added and called from `ngOnDestroy` (2026-10-20). `destroy()` was **not** callable directly: `watchDashboard()` arms the listener only while `dashboardSubject` is `null`, so a bare teardown froze live data for the rest of the session. The seed-then-listen double read remains. |
| **O32** 🟠 | `listMyOrganizations()` was a bare `http.get` with four cold callers and no cache → **2–3 `GET /api/orgs` per load**. | `organization.service.ts:64-80` | ✅ 30 s cache + in-flight collapse, keyed on the auth uid, invalidated by `createOrganization`/`acceptInvitation`/`renameOrganization`/`removeMember` (2026-10-20) |
| **O33** 🟡 | Operations paging discards 3 page reads per jump (a cursor walk that keeps one row), and runs `getCountFromServer` on **every** status-driven refresh. | `operations.component.ts:903-1010`, `:462-472` | persist cursors; count only on explicit refresh |
| **O34** 🟡 | Boot issued **3 guest-tracking requests** for one purpose, one of them pure duplication: `GET /status` had **no route**, so it hit the page catch-all — a Redis `limitFunction` round trip and the 86 KB CSR shell — while `guestTracker` (a global `onBeforeHandle`) and `/csrf-token` already covered the stated purpose. | `app.component.ts:217`, `:221` | ✅ `/status` warm-up deleted (2026-10-20), and `sendStatus()` with it. `heartbeatService.start()` still runs for the signed-in/consented case |
| **O35** 🟡 | **Every tracked event is sent to GA4 twice** — `trackEvent` logs it immediately and `batchTrackEvents` logged the whole queue again on flush. GA-derived numbers are ~2×; the server-side counters are correct, so the two sources disagree. | `analytics.service.ts:90-137` | ✅ duplicate `forEach(logEvent)` deleted (2026-10-20) |
| **O36** 🟡 | The degraded analytics path is a **sequential N+1 over every user** (1 collection read + 1 `getDocs` per user, unbounded), reached whenever the summary document is missing. | `firestore.service.ts:1747-1775` | `collectionGroup(...).count()` |
| **O37** 🟡 | The live view is **60 requests/minute/viewer**, each a Firestore read plus a real screenshot, with `Cache-Control: no-store`. It pauses only when the tab is hidden — not when the panel is scrolled away or the user is idle. | `browser-frame.component.ts:27-30` | poll only while input is recent; answer `304` on an unchanged hash |
| **O38** 🟡 | `billing$` uses `refCount: true`, so a route change that drops the last subscriber re-runs the pipeline. | `billing.service.ts:84-107` | **Downgraded.** The re-run is not the two Stripe calls: `billing$` checks `cacheService.get(billingCacheNamespace, uid)` **before** `getMyEntitlements`, so a warm cache answers `of(cached)` with no callable. The cost of `refCount: true` is one cache lookup per re-subscribe; `refCount: false` would trade that for a subscription held for the app's life. Leave it. |

---

## §6 Shrink

### O19. The service worker prefetches every lazy chunk — 🟠 HIGH, code splitting is undone

- **What this is (read):** `ngsw-config.json` asset group `app` is `installMode: "prefetch"` and
  its file list contains `/*.js` and `/*.css` — every hashed file in the output.
- **Problem:** the build emits **110+ `chunk-*.js`** files, one per lazy route. The service worker
  downloads **all of them** on first install, so `loadComponent` on every route buys nothing for a
  returning visitor. It also prefetches `/index.html` and `/*.html` while
  `navigationRequestStrategy` is `"freshness"` — so those prefetched HTML documents are never
  used for navigation. And `dataGroups[0]` matches `/anthropic/messages` etc. (the client calls
  `/api/anthropic/...`), with `maxSize: 0` and `timeout: "0s"`, so it could not serve anything
  even if it matched.
- **Fix:** replace `"/*.js"` with `"/main-*.js"`, `"/polyfills-*.js"`, `"/scripts-*.js"`; drop
  `/*.html`; delete the `dataGroups` block entirely.
- **If we skip it:** first load pulls the whole app instead of ~4 files (**estimate**: well over
  1 MB extra, on the devices least able to afford it).

### O20. The 40-component barrel is imported by the app shell — 🟠 HIGH

- **What this is (read):** `layout/full/app-user-layout.component.ts` imports from
  `src/app/core/components`, whose `index.ts` re-exports **40 standalone components**. There is no
  `sideEffects: false`, so the barrel retains all 40 modules in the layout chunk.
- **Problem:** two of those 40 statically import `MarkdownModule`, so **ngx-markdown + marked +
  Prism land in the shared layout chunk** — loaded on dashboard, billing and settings, where
  `provideMarkdown()` is never even declared. The repo already documents this exact mechanism for
  services in `app.component.ts`'s header comment.
- **Fix:** import the three components the layout actually uses by direct path, and delete barrel
  re-exports with no other consumer. **Note:** `get_errors`/`tsc` do not parse templates, so gate
  this with `bun run build`.
- **If we skip it:** **estimate** 120–180 kB before gzip on every authenticated page.

### O21. Budgets that cannot fail — 🟠 HIGH (it is the gate for O19/O20)

- **What this is (read):** `angular.json` production and staging both declare `initial`
  `2400kB` warn / `2700kB` error, and `anyComponentStyle` `12/20 kB`. Nothing else.
- **Problem:** with 110+ chunks, a 2.4 MB initial budget is roughly twice a healthy Angular 20
  initial bundle, so no realistic regression trips it. There is no per-bundle budget (growing one
  lazy route is invisible) and no global-style budget (`styles.scss` is unbudgeted). The gate
  does run on PRs — it just has no teeth.
- **Fix:** measure first (`bun run build`, read the report), then set `initial` to ~1.3× the
  measured value and add one `{ "type": "bundle", "name": "main" }` entry plus an `anyScript`
  entry. **Do not set a number nobody measured** — a too-tight budget blocks every PR.

### O22. Dead code and dead dependencies

| Item | Evidence | Action |
|---|---|---|
| `PerformanceService` | 0 references outside its own file | delete (or wire it — it is claimed in `app.config.ts`) |
| `FirestoreCacheService` | 0 references, still re-exported by the services barrel | delete + barrel line |
| `layout/full/index.ts` | barrel puts 3 layouts + 404 in one chunk | import by path, delete barrel |
| `vite.config.ts` | no builder declares `viteConfig`; `vite` is not a dependency | delete |
| `src/environments/prod.ts`, `staging.ts` | `fileReplacements: []`; `prod_gen.ts` writes `environment.ts` | delete both |
| `clipboard`, `emoji-toolkit` | ngx-markdown optional peers; `provideMarkdown()` is called with **no options** | delete |
| `http-proxy-middleware` | `proxy.conf.json` is consumed natively by the dev-server | delete |
| `express-rate-limit`, `rate-limit-redis`, `stream-buffers`, `node-fetch` (root) | the root Express server was deleted with the move to `bff/` | delete from root only |
| `@angular/platform-browser-dynamic`, `@angular/pwa` | `bootstrapApplication` comes from `platform-browser`; `pwa` is a schematic | delete |
| `@angular/common`, `@angular/compiler`, `@angular/ssr` in `functions/package.json` | only `cp-angular.js` (a build script) needs them | move to `devDependencies` |
| `functions/tsconfig.json` exclude | omits `**/*.spec.ts`, so ~38 specs compile into `lib/` and deploy | add to `exclude` |

**Three `firebase-admin` majors coexist** (`^13` root, `^12` functions, `^14` bff), and the image
installs two of them (`Dockerfile:9` and `:28`) — two copies of the gRPC/Firestore/Storage stack
in one container. Align on 14.x.

**Estimate:** ~1,900 lines and ~9 dependencies removable, most of it outside this file's scope —
the earlier review's lean totals per surface still stand.

---

## §7 Deploy and CI correctness

### O23. A `functions/**`-only change breaks the image build — 🔴 CRITICAL

- **What this is (read):** `firebase-hosting-merge.yml` builds Angular on
  `angular || hosting || bff`, but builds and pushes the BFF image on
  `bff || functions || angular || hosting`. `Dockerfile:36` is
  `COPY dist/deepscrape/browser ./dist/deepscrape/browser`.
- **Problem:** a `functions/**`-only merge rebuilds the image **without** `dist/`, so the `COPY`
  layer fails. The deploy is red for exactly the change class that has no frontend diff — and the
  BFF *must* be rebuilt then, because it imports those handlers.
- **Fix:** add `|| needs.detect_changes.outputs.functions == 'true'` to the **Build Angular App**
  condition. One line.

### O24. The live Hosting deploy is still configured the way its own comment says cannot work — 🔴 CRITICAL

- **What this is (read, verified):** the step uses `FirebaseExtended/action-hosting-deploy@v0`
  with `channelId: live` and **no `target`**, immediately below a comment explaining that a
  channel deploy can only address one site and the CLI must fan out. Cloud Run deploys 20 lines
  earlier.
- **Problem:** new BFF against old bundles and an old `index.html`.
- **Fix:** `firebase deploy --only hosting --project "$FIREBASE_PROJECT_ID"`.

### O25. No cache policy: HTML is revalidated hourly, hashed assets are not immutable — 🟠 HIGH

- **What this is (read):** all three Hosting `headers` blocks set only HSTS, CSP,
  `X-Content-Type-Options`, `X-Frame-Options` (and `X-Robots-Tag` on two targets). No
  `Cache-Control` anywhere.
- **Problem (two directions):**
  - Hosting's default `max-age=3600` applies to `index.html`, `index.csr.html`, every prerendered
    `*/index.html`, `ngsw.json` and `ngsw-worker.js`. A visitor in the hour after a deploy gets
    old HTML referencing a bundle hash that no longer exists → blank page, script 404s.
  - Angular's hashed bundles are content-addressed and safe to cache for a year, but are treated
    like everything else — so repeat visitors revalidate all 110+ chunks hourly, which is Hosting
    egress and request count.
- **Fix applied:** `no-cache` on `/index.csr.html`, `**/*.html`, `/ngsw.json` and `/ngsw-worker.js`, on
  all three targets. The `immutable` half is **deliberately not applied**: Firebase Hosting applies
  *every* `headers` block that matches, so a `**/*.@(js|css|woff2)` rule would also give
  `ngsw-worker.js` a one-year cache and the service worker could never update itself. Doing it
  correctly needs per-extension blocks that exclude the worker, verified against a live deploy by
  reading the actual response headers — that is a preview-channel job, not a blind edit.

### O26. Rules and indexes still have no deploy path — 🟠 HIGH

- **What this is (read):** no workflow runs `--only firestore:rules`, `--only storage` or
  `--only firestore:indexes`; only manual `package.json` scripts do.
- **Problem:** a merged rule or index change is green in CI and never reaches the database. An
  **undeployed index answers `FAILED_PRECONDITION`**, which the admin sessions page would render
  as "no sessions" — telling an operator the platform is idle while customers are billed.
- **Fix:** one step after the Hosting deploy:
  `firebase deploy --only firestore:rules,firestore:indexes,storage`.

### O27. Build context and registry hygiene — 🟡 MEDIUM

- **`.dockerignore` is thin** (read): it excludes `.git`, `.github`, `.claude`,
  `.codebase-memory`, `graphify-out`, `screenshots`, `node_modules`, `functions/lib`,
  `dist/test-out` — and stops. The context is the **repo root**, and the image copies four paths,
  so `docs/`, `dist/deepscrape/server`, `output/`, `functions/databases/*.BIN` and every `*.spec.ts`
  are hashed and sent on every merge build.
  **Fix:** add `docs`, `dist/deepscrape/server`, `output`, `functions/databases`, `bff/*.spec.ts`,
  `functions/src/**/*.spec.ts`.
- **Artifact Registry grows an untagged digest per merge** — the tag is `:latest` and the previous
  digest remains. **Fix:** an AR cleanup policy (keep 5, delete untagged after 7 days).

---

## §8 Zero-to-scale plan

Every row is flag-level except where marked.

| Stage | Binding constraint | Change |
|---|---|---|
| **0–10 customers** | none; correctness only | O1 (secret), O23/O24 (CI), O6 (one line), `--max-instances=10 --concurrency=40 --cpu-boost` |
| **10–100** | the per-IP page limiter (§2) becomes the first support ticket; `iad` hop becomes visible | O4 (static shell) — this is the stage where it stops being optional. O5, O7, O15, O19 |
| **100–1,000** | the crawl worker living **inside an HTTP request** (300 s ceiling + 255 s `idleTimeout`), and `min_machines_running = 1` on webrain | O9 `--timeout`; split revisions (page/API vs crawl worker); raise the webrain floor; O13, O14, O17 |
| **1,000+** | Cloud Run region and Firestore location, both unverified | multi-region Cloud Run behind Hosting; confirm the Firestore location matches the BFF before anything else; the crawl worker becomes a queue consumer, not a request |

**The one thing that cannot be fixed with a flag** is O9's last point: a crawl target is executed
inside the QStash delivery request. Until it is a background consumer, a slow site costs a killed
request, a durable retry, and a second full crawl on the same pool.

---

## §9 Execution order — one at a time

Each item is independently shippable. Gates for every row are in §10.

**Phase A — secrets and CI (half a day, no user-visible change)** — **DONE 2026-10-20**
1. ✅ O1 `.dockerignore` secret exclusion (+ specs, `docs`, `dist/server`, `functions/databases`).
2. ✅ O23 Angular build condition for `functions` changes.
3. ✅ O24 Hosting live deploy via CLI (was `action-hosting-deploy` with no `target`).
4. ✅ O26 rules + indexes + storage deploy step.

**Phase B — free latency (half a day, three lines)** — **DONE 2026-10-20**
5. ✅ O6 un-await the traffic counter (`void count().catch(...)`; the spec still passes because its
   stub increments synchronously).
6. ✅ O9 `--max-instances=10 --concurrency=40 --cpu-boost` on both deploy paths. `--timeout` is
   **deferred** until the crawl-worker revision is split — raising it for page traffic too changes
   how long a stuck page holds an instance.
7. ⏸ O2 `.run.app` host rejection — **deferred**, see the caveat in §3. Wrong here is an outage.

**Phase C — the big structural win (1–2 days, needs a build to verify)** — **partly done 2026-10-20**
8. O4 static shell rewrites, verified against a real `dist` upload — **still open**, needs a preview deploy.
9. ✅ O25 `no-cache` for `**/*.html`, `/index.csr.html`, `/ngsw.json`, `/ngsw-worker.js` on all three
   targets. The `immutable` rule for hashed bundles is **not** applied: a glob that also matches
   `ngsw-worker.js` would give the worker a one-year cache, so it needs explicit per-extension
   blocks and a header check against a live deploy.
   ✅ O19 service worker: prefetch narrowed to `main-*`/`scripts-*`/`polyfills-*` + `*.css` +
   `/index.html`; `/*.js` and `/*.html` dropped; the inert `dataGroups` block deleted.
   `/index.html` deliberately stays — it is the SW's navigation index, and dropping it removes the
   only offline shell.

**Phase D — duplicate work (2–3 days)**
10. ✅ O28 status-poll re-entrancy guard (applied — a request storm, so it did not wait for the phase).
11. ✅ O14 session lookups bounded to `METERABLE_STATES` (same single-field index
    `createBrowserSession` already uses, so no new index).
12. ✅ O29 one shared auth chain (`shareReplay`, `refCount: false`); a transient failure no longer signs the user out.
13. O15 (transaction read range), O13, O7 (billing reads and the consume path).
14. ✅ O35 duplicate GA4 log removed. ✅ O31 analytics listener detached on page exit. ✅ O34 `/status` warm-up removed. ✅ O32 org-list cache. Then O30, then O16–O18.
15. O5 — **only after** confirming the tombstone covers every `paid`-only route.

**Phase E — shrink (2 days, gated by `bun run build`)**
16. O21 budgets — measure first, then set.
17. ✅ O20 layout barrel de-referenced (routes + the nav link inside the layout, which is what
    actually re-entered it), and the 404's 44-service barrel import replaced. O22 file deletions
    remain blocked — no delete tool — and the `package.json`/`tsconfig` halves were rejected or
    blocked, see §12.
18. O27 build context (partly done with O1) and the registry cleanup policy.

**Phase F — scale work (see §8)**
19. Split the crawl worker out of the request path.

---

## §10 Gates

Run for every repo touched. None of these ran in this session (§11).

```bash
# functions
cd functions && bun x tsc --noEmit && bun run lint && bun run test

# bff
cd bff && bun x tsc --noEmit && bun test

# angular — `bun run build` is the ONLY template validator
bun x tsc --noEmit -p tsconfig.app.json
bun run build
bun x ng test --watch=false
```

Two traps that cost real time here, both already recorded in `README.md`:

- **`get_errors` is not evidence.** It has reported "No errors found" on files that could not
  compile. `tsc --noEmit` for structure, `bun run build` for templates.
- **Do not read `$LASTEXITCODE` after a pipe or `;` chain.** Print it on its own line immediately
  after the command.

For O4 specifically, the verification is not a test — it is: `bun run build`, confirm
`dist/deepscrape/browser/index.csr.html` exists, deploy to a preview channel, and confirm
`/dashboard` answers with that file **without** a Cloud Run request in the log.

---

## §11 Not checked

- **Superseded 2026-10-21 for the app and functions.** Those gates ran, and passed:

  | Gate | Result |
  |---|---|
  | `functions`: build / lint / test | 0 / 0 errors (8 pre-existing warnings) / 974 tests, 965 pass, 0 fail, 9 skipped |
  | `app` `tsc --noEmit -p tsconfig.app.json` | 0 |
  | `app` `bun run build` | 0, 14 routes prerendered — the only template and SSR gate |
  | `app` Karma | 900 / 900 |

  Still not checked: **`bff` `tsc` / `bun test`**, any profile, any measured bundle size, and
  `gcloud run services describe`.
- **Cloud Run revision settings are read from the deploy commands, not from the live service.** If
  the console was edited, the commands are not authoritative.
- **No bundle was measured.** The 110+ chunk count comes from the existing `dist/` listing; the
  kB figures in O19/O20 are estimates.
- **Unverified environment facts:** Firestore location, Upstash region, arachnefly's region,
  container image size, actual cold-start duration, and live `Cache-Control` response headers.
- **`codebase-memory` query tools were unavailable**, so the inventory is the artifact's node/edge
  counts plus `12-service-orchestration-and-layer-inventory.md`, not a fresh graph query.
- **Meilisearch has no client in this repo**, so O10's `fra` finding is latent, not live.
- **O29–O38 come from one automated pass over the client.** Callers were established with the LSP
  `usages` tool rather than a text search (which is unavailable), and each cited line was read. The
  pages not inspected on that pass: `chatai`, `playground`, `crawl-pack` (only their
  `aiModels.load()` caller was checked).

---

## §12 Gate register — run 2026-10-21

This register used to say every edit below was uncommitted and had never been typechecked, built or
run. It was committed on `next` in ten focused commits, and the gates it asked for were run:
functions build/lint/974 tests, app `tsc`, app `bun run build` (14 routes prerendered), Karma
900/900. **A row under a gate that passed is closed, not a live risk** — the per-file tables are
kept only as a bisect map for the next regression.

The tables that are **still open**: the `bff` one (`bun x tsc --noEmit` / `bun test` never ran) and
"no gate available" (workflow YAML and `.dockerignore` have no local gate; they fail loudly on
deploy or not at all).

### Gate: `cd functions && bun x tsc --noEmit && bun run lint && bun run test`

| File | Change | Why it could fail |
|---|---|---|
| `functions/src/app/auth.ts` | `deleteMyApiKey` / `getApiKeyDoVisible` derive the secret path with `secretPathFor` instead of trusting the stored `secretPath` field | the helper's contract was assumed, not called in a test |
| `functions/src/app/stripe.ts` | `billingDefaultsForMerge()` at 10 merge writes; expiry sweep bounded and clears `expiresAt`; pack quantity pinned to 1; refund idempotency key; `async_payment_succeeded` case | the largest surface here — 10 call sites, one shape. A missing `await` or a renamed field shows up only at runtime |
| `functions/src/gfunctions/sessions.ts` | skip now requires the signed second-factor claim instead of the request body's `mfaVerified` | depends on the claim name `firebase.sign_in_second_factor` being what the platform actually issues |
| `functions/src/handlers/machines.ts` | `checkImageDeployability` buffers through `gunzipSync` instead of `pipeline` | shape of the relayed response changed from stream to buffer |
| `functions/src/infrastructure/browser-session.store.ts` | two queries bounded to `METERABLE_STATES` | if `state` is ever missing or spelled differently on old documents, they silently drop out of the result |
| `functions/src/infrastructure/syncaiapi.ts` | `listOrganizations` now de-duplicates org ids and reads them with one `db.getAll(...)` | `getAll` takes refs positionally and **throws on a duplicate**, which is exactly what the de-duplication is for. Verify a user with 2+ orgs still gets every org, and that a membership pointing at a deleted org is still dropped |

### Gate: `cd bff && bun x tsc --noEmit && bun test`

| File | Change | Why it could fail |
|---|---|---|
| `bff/bridge.ts` | added `set()`; `toResponse` returns raw bytes for `Uint8Array` | `set()` is a duck-type facade — the caller must actually pass `Uint8Array` |
| `bff/security.ts` | `/api/jobs/` added to the CSRF ignore list | if the dashboard sends the header there, it is now unenforced |
| `bff/api.ts` | `:tempTaskId` → `:taskId` | only a param rename, but a mismatched reader would throw |
| `bff/traffic-counter.ts` | `onAfterHandle` no longer awaits `count()` | **the counter can now be lost** on instance shutdown. Accepted deliberately; it is a metric, not a bill |
| `bff/package.json` | three Cloud Run flags on `deploy:cloud` | flags, not code |

### Gate: `bun x tsc --noEmit -p tsconfig.app.json` + `bun run build` + `bun x ng test --watch=false`

| File | Change | Why it could fail |
|---|---|---|
| `src/app/core/services/websocket.service.ts` | re-entrancy guard in `connectAndTrackTasks` | if the id set genuinely changes on every poll, the guard is a no-op and the storm survives — untested beyond the one unit spec |
| `src/app/core/services/websocket.service.spec.ts` | new spec pinning the guard | — |
| `src/app/core/services/firestore-analytics.service.ts` | new `stopRealtime()`; `destroy()` delegates to it; `watchDashboard()` re-arms on a `dashboardListening` flag instead of `dashboardSubject.value` | the flag is the whole mechanism — if a second `startDashboardListener()` ever runs, two `onSnapshot`s bill twice. Driven by a real page visit, not a unit test, because the component is what calls it |
| `src/app/pages/admin-analytics/admin-analytics.component.ts` | calls `stopRealtime()` on destroy | as above |
| `src/app/core/services/analytics.service.ts` | deleted the duplicate `forEach(logEvent)` | GA4 event volume halves; the client and server counters should now agree |
| `src/app/core/services/auth.service.ts` | `phoneVerified` is three-state (`boolean \| null`), `??` instead of `\|\|` | fails to compile if any consumer narrows it to `boolean` |
| `src/app/app.component.ts` | the `GET /status` warm-up is gone; `forkJoin` dropped from the rxjs import | a leftover `forkJoin` use would be a compile error, so `tsc` catches this one |
| `src/app/core/services/analytics.service.ts` + `.spec.ts` | `sendStatus()` deleted, and its one test with it | nothing else references it — `grep` for `sendStatus` if the build complains |
| `src/app/core/services/organization.service.ts` + `.spec.ts` | 30 s list cache + in-flight collapse, keyed on the uid; four mutations invalidate; the spec's `AuthService` mock now supplies `user$`; **three new specs** pin the in-flight collapse, the cache hit, and mutation invalidation | the constructor subscribes to `user$`, so any other spec that mocks `AuthService` without that property throws on construction. Only this spec mocks it, but check callers of `listMyOrganizations` for a stale-read expectation |
| `src/app/routes/user.route.ts`, `service.route.ts`, `app.routes.ts`, `layout/components/app-sidebar-nav-link/*.ts` | the three `layout/full` barrel imports replaced with direct component paths | a wrong relative path is an unresolved-module error, so `tsc` catches it |
| `src/app/layout/full/app-not-found/app-not-found.component.ts` | `WindowToken`/`LocalStorage` imported from their own modules instead of the 44-service barrel | same — unresolved module or unused symbol, caught at compile |
| `src/app/core/services/index.ts` | dead `firestore-cache.service` re-export removed | nothing imported the symbol, but confirm with `bun run build` that no dynamic reference existed |
| `ngsw-config.json` | prefetch narrowed; `dataGroups` deleted | a pattern that matches nothing means no offline shell. Verify the built `ngsw.json` still lists `main-*`, `scripts-*`, `polyfills-*` |
| `firebase.json` | four `Cache-Control` sources × three targets | a malformed block fails the whole Hosting deploy |

### No gate available this session

| File | Change |
|---|---|
| `.dockerignore` | seven exclusions |
| `.github/workflows/firebase-hosting-merge.yml` | Angular build condition, CLI Hosting deploy, rules/indexes/storage step, three Cloud Run flags |
| `.github/workflows/firebase-hosting-pull-request.yml` | functions deploy gated to `push` |
| `docs/roadmap/README.md` | index row |

**Highest risk in the set, in order:** `stripe.ts` (money, 10 call sites), `firestore-analytics`
(the re-arm behaviour), `auth.service.ts` (a type change across consumers), `websocket.service.ts`
(a guard that cannot be proven without a running page).

**Lowest risk:** the JSON, `package.json`, workflow and doc edits — they either parse or fail loudly.

### What could not be done, and why

| Item | Blocked by |
|---|---|
| O22 deletions (`PerformanceService`, `FirestoreCacheService`, `vite.config.ts`, `prod.ts`, `staging.ts`, barrels) | no shell and no delete-file tool in this session. A `create` that empties a file still leaves it in the build graph |
| O4 static-shell rewrites | needs a preview deploy to prove `/dashboard` still answers when `index.csr.html` is absent. A wrong rewrite 404s the whole app |
| O21 budgets | needs `bun run build` output. A budget nobody measured blocks every future PR |
| O2 `.run.app` host rejection | needs the real `Host` header Firebase Hosting presents to Cloud Run |
| O29, O13, O7, O15, O30 | each touches auth, money or the transactional path. Without a green suite the change cannot be told apart from a regression |

### Implemented after all, once the evidence was checked

| Item | What changed the picture |
|---|---|
| **O34** the `/status` boot warm-up — **removed 2026-10-20** | The earlier "do not delete" note assumed the call might be the only thing that mints the `gid` cookie. It is not: `guestTracker` is registered as a global `onBeforeHandle` (`bff/guest-tracker.ts`), and `app.component.ts` already requests `/csrf-token` — a real BFF route — on every browser boot, before anything else. `GET /status` has **no route at all**, so it fell through to the `*` catch-all: `limitFunction` (a Redis round trip), then reading and serving the 86 KB `index.csr.html`, whose body was logged and discarded — while `trafficCounter` counted it as a served request and inflated `requestsToday`. Removing it is a pure win. The spec's `sendStatus` case was deleted with it. |
| **O32** org-list cache — **implemented 2026-10-20** | The "not worth it blind" note was about invalidation cost. The service has a public `user$`, so the cache can be scoped to the identity and dropped on a uid change, which removes the cross-account leak that made this feel unsafe. Four mutations invalidate (`createOrganization`, `acceptInvitation`, `renameOrganization`, `removeMember`); an in-flight handle collapses the concurrent calls that `HttpTestingController` cannot otherwise distinguish. |
| **O22** the `functions/tsconfig.json` spec exclusion — **rejected on reflection** | Excluding `**/*.spec.ts` would shrink the deploy, but `bun x tsc --noEmit` is the **only** typecheck those 38 specs ever get (`tsx --test` does not typecheck). Trading the only static check on the test suite for ≈200 KB of upload is the wrong direction. Left as is. |
| **O22** dependency removals and the `@angular/*` devDependency move — **blocked** | Editing `package.json` without regenerating `bun.lock` breaks `bun install --frozen-lockfile` in the image build. No shell here, so the lockfile cannot be regenerated. |
