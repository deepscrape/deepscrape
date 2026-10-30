# 23 — crawlagent as the second scrape provider

**Design only. Nothing in this file has been applied.**
Written 2026-10-22. Every claim below was read from source or from the code graph in this session, not
from an earlier audit. The crawlagent graph is stale to 2026-10-10 (`check_index_coverage` reports
`metadata_changed` on all eight files cited here), so file:line is the evidence there, not the graph.
Second pass added §11.1-11.2, §16 (capability contract, compared against the crawl4ai 0.9.x docs) and
§17-18 (credentials, the LLM mode), which correct the first pass's reading of `crawl-pack`. Third pass
added §19-21 (capability ownership, a deletion ledger measured from file outlines, and an explicit
account of what the index cannot see), and revised §9/§13 because P3 is a subsystem removal. Fourth
pass added §22 (the readiness gate: which phases may start, read from `scrape-providers.domain.ts`,
`fly.toml`, `supervisord.conf` and `docker-entrypoint.sh`).

**Non-goals, stated first because they are the parts that would be tempting:**

- **The browser-pool service is not touched.** `browser_pool_service.py` and everything it mounts
  (`/browser/*`, `/stream/*`, `/blob/*`, `/ws/blob/*`) stays exactly as it is, legacy and frozen.
- **No new inbound surface on webrain.** See §3.
- **The frontend needs no new HTTP route.** See §2 — it is already provider-agnostic.

---

## 1. The decision, in one page

Two providers, **one browser fleet**.

| | owns | never |
|---|---|---|
| **webrain** | the browser (CDP attach, launch, tabs), crawl *intelligence* (seeder, HTTP cache, rate limiter, hooks, adaptive dispatcher, fit-prune), gates, typed JSON | markdown generation, LLM extraction, job queues — its own docs say so (`docs/INTEGRATION_PLAN.md` §6 skip-list, `docs/FEATURE_GAPS.md` T2) |
| **crawlagent** | crawl *jobs*: enqueue, retry, progress, cancel; crawl4ai's markdown/LLM post-processing; the `reader` shape the BFF already reads | launching a browser fleet, owning artifacts, second-source task state |

**Dependency direction: crawlagent → webrain. Never the reverse.** That is not a preference, it
is what the code makes possible. webrain is a CDP **client** — `webrain-core/src/backends/cdp.rs`
(`CdpBackend.connect_with_url`, `send_cmd`, `eval_js`) — and the one place a remote browser can
enter is `webrain-mcp/src/lib.rs:992` `caller_cdp(arguments)`, which reads `cdp_url` out of the
**tool arguments**. There is no CDP listener in webrain: no `:9222`, no debug-port accept loop,
`launch.rs` opens `--remote-debugging-port` for its own outbound socket. So
`BrowserConfig(cdp_url=<webrain>)` is unavailable today, and "attach crawl4ai to a webrain
browser" is not a wiring task — it is a new inbound service that would need its own auth.

The second provider is therefore a **crawlagent that owns no browser**: it takes URLs, asks
webrain to fetch them, and spends its own CPU on what webrain deliberately does not do.

---

## 2. Where the pieces actually are today

Verified, not assumed.

**Frontend — already provider-agnostic, no new route needed.**

- `src/app/core/types/ai-provider.interface.ts:63` — `ScrapeProviderId = 'crawl4ai' | 'jina' | 'webrain'`.
- The selector exists: `CALLABLE.setMyScrapeProvider` (`ai-keys.service.ts:256`), with a reader-key
  form per provider (`ai-keys.component.ts:386` `readerControlFor`).
- `crawlapi.service.ts:47-49` — the client is **same-origin**: `crawl4AiEndpoint = API_BASE_URL + '/crawl'`,
  `jobEnqueuePath = '/api/crawl/stream/job'`. Nothing in the browser dials crawlagent, and the
  comment at `:20-30` records why that was fixed.
- `getTaskStatus` rewrites `/crawl` → `/job` (`:126`) and streams **BFF SSE**; `websocket.service.ts`
  is a 4 s poll over that same route (`TASK_POLL_INTERVAL_MS`).

What is provider-agnostic is the **route**; the pages are not. Three entry points exist and only one
resolves a provider — §11 lists them, the four gaps they leave, and why `/chatai` and `crawl-pack`
behave differently from what their names suggest.

**BFF / functions — the only place a provider is chosen.**

| Step | File | Today |
|---|---|---|
| pick | `functions/src/handlers/scrape.ts:188` | `if (provider === "webrain") webrainCrawl() else crawl4aiCore()` |
| default | `functions/src/domain/scrape-providers.domain.ts:158` | `FALLBACK_PROVIDER = "crawl4ai"` |
| call | `functions/src/handlers/ai_handler.ts:84` | `POST ${API_CRAWL4AI_URL}/api/v1/crawl/`, `Authorization: Bearer ${CRAWL4AI_API_KEY}`, `Accept` from the caller |
| echo | `scrape.ts:177-183` | `x-scrape-provider`, `x-scrape-provider-source`, `x-scrape-provider-rejected` |

**crawlagent — five routers on one FastAPI app.**

`server.py:393-397` mounts `/api/v1/ws`, `/api/v1/job`, `/api/v1/crawl`, `/api/v1/seeder`,
`/api/v1/diagnostics`; `:403` `GET /`; `:463` health (`/health`, no dependency); `:480` `/metrics`
(**also no dependency**). `POST /api/v1/crawl/` (`routers/crawl_router.py:39`) is
`crawl.reader` — a jina-reader-shaped endpoint that returns `{data:{title,url,usage,content}}`,
plain text, or an ndjson stream depending on `Accept`. **That shape is already what
`ai_handler` reads**, which is why the provider looked merely "unused" rather than wrong.

---

## 3. The five defects that make "second provider" impossible today

| # | Defect | Evidence | Consequence |
|---|---|---|---|
| **D1** | Auth is **off**. `jwt_enabled: false` → `get_token_dependency` returns `lambda: None`, so *every* route is open. | `config.yml:70`, `auth.py:46-52` | Anyone who finds the host has an open browser and an open `/metrics`. This is the blocker. |
| **D2** | The two sides speak different credentials. crawlagent verifies **only** a Firebase ID token (`auth.py:35` `auth.verify_id_token`); the BFF sends a **server-held key** (`ai_handler.ts:107`), deliberately, so no tenant token enters a shared process. | `auth.py:15-43` vs `ai_handler.ts:100-130` | A live worker still answers 401. The path was also wrong until this week (`/crawl` vs `/api/v1/crawl/`). |
| **D3** | Two incompatible browser stories in one service. `crawler_pool.get_crawler` launches its own Playwright Chrome with a Redis pool, container affinity and a RAM ceiling; `tasks._crawl_web_task_with_cdp` instead claims a **context from the frozen pool service**. | `crawler_pool.py:83-193`, `tasks.py:300-382` | Whichever you deploy is the one that works, and the second one is a cross-tenant hazard if it is ever the one. |
| **D4** | Three stores for one truth, plus a polling socket. Celery `AsyncResult`, a Redis hash `task:{id}` written through a pipeline, and Firestore. The WS re-reads `AsyncResult` every **0.7 s per connected client**. | `tasks.py:503-592`, `routers/websocket_router.py:126-175` | Cost scales with *watchers*, not jobs; and the frontend no longer watches (it polls BFF SSE). |
| **D5** | Its own storage identity: `storage.py` hardcodes `crawlagent.bucket.a`, and its blob routers are on the served surface. The platform contract is Tigris through `s3-blob-store.ts` / `/api/storage/*`. | `docs/roadmap/13-runbook-and-storage-contract.md` Part C/D | Two artifact stores, two prefixes, two retention stories. |

Already applied in the working trees this session, **not deployed** — the doc treats them as the
starting point, not as done: `auth.py` `is_platform_key()`, `config.yml` `jwt_enabled: true`,
`websocket_router.get_cookie_or_token` verifying the credential it actually collected,
`ai_handler.ts` `/api/v1/crawl/`.

---

## 4. Target architecture

Dev and production differ in **addresses only**; the shapes are identical. That is the point of
the platform's `PRODUCTION`-only switch (`functions/src/config/upstreams.ts:50`).

```
                        ┌───────────────────────────────┐
  Angular (3 sites)  →  │  BFF  (Cloud Run / localhost) │  ← the ONLY served HTTP table
  same-origin only      │  /api/*  · /event · /oauth    │
                        │  · /status                    │
                        └───────┬───────────────┬───────┘
                                │               │
                  provider=webrain        provider=crawl4ai
                                │               │
                                ▼               ▼
                     ┌──────────────────┐  ┌──────────────────────────────┐
                     │ webrain MCP      │  │ crawlagent (FastAPI)         │
                     │ browser + crawl  │◄─┤ jobs · retries · progress    │
                     │ intelligence     │  │ markdown · LLM extraction    │
                     └────────┬─────────┘  └──────────────┬───────────────┘
                              │                           │
                     Obscura / Chrome              Redis (task hash)
                     (Fly machine / local)         QStash or Celery (retry)
```

**Four rules that fall out of it.**

1. **crawlagent holds no browser.** A crawl step is an MCP `tools/call` to webrain; the browser,
   its lifecycle and its concurrency belong to the fleet that already has a reaper.
2. **One artifact store.** A crawl job that produces something writes through the platform's
   storage port, under the tenant prefix — never `crawlagent.bucket.a`.
3. **One progress truth.** The Redis `task:{id}` hash is the record; the BFF derives SSE from it.
   crawlagent does not push to the browser at all.
4. **The provider boundary is the BFF's.** `scrapeMiddleware` already echoes which provider served
   a request and why one was refused; that stays the only place routing is decided.

---

## 5. The provider contract (write this down before writing code)

Seven things both sides must agree on. C1 and C2 hold. C3 and C7 are config/serialisation fixes. C4
and C6 block billing. C5 blocks support.

| # | Contract | State |
|---|---|---|
| C1 | `POST /api/v1/crawl/` accepts `{urls}`, honours `Accept` (`application/json` \| `text/plain` \| `application/octet-stream` \| `text/event-stream`), and answers the jina shape for JSON | **holds** — `crawl.reader` |
| C2 | Credential is the platform key **or** a Firebase ID token; an unset key never matches | **holds in the working tree** (`is_platform_key`), not deployed |
| C3 | `API_CRAWL4AI_URL` is an **origin**, no path; the client appends `/api/v1/crawl/` | **new** — a previous env that included `/api/v1` now doubles the prefix |
| C4 | The response carries **usage** so the BFF can meter the provider honestly | **blocking** — billable per §10, so every branch of `reader` must return it, including text and ndjson |
| C5 | Failures are distinguishable: upstream timeout, target blocked, worker down, budget refused | **gap** — `ai_handler` collapses everything to `Failed to stream on crawl API`; the taxonomy is named in §14 |
| C6 | Idempotency: a retried enqueue does not start a second job | **blocking** — QStash retries the enqueue (§10); the pattern exists (`applyBillingCreditMutation` keys) |
| C7 | The two crawl4ai classes are carried separately: `{ "browser": …, "run": …, "extraction": … }`, split once server-side | **new** — the packager flattens both tabs into one object today (§16) |

C1-C3 make it *work*. C4 and C6 make it **sellable**: without them the platform bills a job it cannot
price and starts a second job on every QStash retry. C5 keeps support from guessing. C7 is what stops
every future form control from leaking into the wrong crawl4ai class.

---

## 6. Transports: three, and what each is for

The temptation is to unify these. Don't — they answer different questions.

| Transport | Use it for | Do not use it for |
|---|---|---|
| **BFF SSE** (`/api/job/stream/status/:taskId`) | progress for every provider, poll-derived today | long-running binary or 1 fps video |
| **crawlagent ndjson/SSE** (`/api/v1/job/stream/{task_id}`) | the shape to remember when webrain grows a progress channel — `14-remaining-gaps` §3 says port the shape, **do not bridge** it | a second progress channel beside the BFF's |
| **WebRTC / neko** | *interactive control* of one session: real input latency, one room per tenant session, STUN/TURN, `aiortc` in the media path | observation of many sessions, or any fan-out |

**On neko specifically.** `m1k1o/neko` is a WebRTC media server that streams a real browser's
display and accepts input over a data channel. The Angular client already speaks its handshake —
`WebRtcService.connect()` builds `/ws?password=…&username=…` (`webrtc.service.ts:111`), which is
neko's protocol, not crawlagent's. That makes an **interactive tier** cheap to add and a
**frames replacement** expensive: video is per-session bandwidth, needs TURN for NAT, and a neko
*room* is single-user, so the only tenancy-safe shape is one room per leased session — exactly the
model invariant I2 already forces. Use frames (`webrain_observe(what="screenshot")`) for
observation because they are stateless and cacheable; use WebRTC only where input latency is the
product. The opt-in setting that exposes it, and why the *server* must pick the transport, are in §15.

---

## 7. Phases

Each phase is independently deployable and independently revertible. **P0 blocks everything.**

### P0 — make it safe to expose (blocking)

- [ ] `jwt_enabled: true` (working tree) deployed; confirm `401` on an unauthenticated `POST /api/v1/crawl/`.
- [ ] Close `/metrics` — it has no dependency today (`server.py:480`) and leaks queue and memory gauges. Bind it to loopback or put the same token dependency on it.
- [ ] Delete `/api/v1/diagnostics/open-firewall-ports` (`diagnostics_router.py:120`). Token-gated, still a runtime host mutation; no SaaS feature needs it.
- [ ] Remove `GET /` (`server.py:403`), which is a debug landing page.
- **Gate:** an unauthenticated request gets `401` on every path except `/health`; `/health` answers `{"status":"ok"}`.
- **Rollback:** revert the config flag. Nothing else in P0 has state.

### P1 — make the contract true (two repos)

- [ ] C3: `API_CRAWL4AI_URL` = origin in all environments; document it in `docs/ENV_CONFIG_MATRIX.md`.
- [ ] C2: deploy the key on both sides and assert the *same* value; an empty BFF key already fails closed (`Bearer ""` → 401), which is correct but silent — log it once at boot instead of per request.
- [ ] C4: return a `usage` object on every branch of `reader`, including the text and ndjson ones.
- [ ] C5: give `ai_handler` a typed failure taxonomy and pass the upstream status through, so "worker down" and "target blocked" stop looking identical.
- **Gate:** functions build/lint/test green; a `crawl4ai`-selected user gets a real answer from a deployed worker and `x-scrape-provider: crawl4ai` says so.
- **Rollback:** `SCRAPE_PROVIDER=webrain` pins every route to the working provider, no deploy.

### P2 — crawlagent owns no browser (mapping decided, §14)

The open question this document previously carried — *does `CrawlerRunConfig` fold onto
`webrain_crawl`, or does it need `webrain_batch op=fetch`?* — is answered by measurement. It is
neither: **`webrain_crawl` is link discovery, not a fetch**, and the config fields that would have
needed mapping are commented out. §14 has the three tiers and the one-op change webrain needs.

- [ ] Add the engine at the single seam that matters: `handle_crawl_request` (`tasks.py:669-748`),
      the one place `arun` happens. `_crawl_task_impl` (`:503`) skips `get_crawler` entirely.
- [ ] Choose the tier from the **job's declared needs**, never from a per-request probe (§14).
- [ ] Delete the **caller** of the pool (`_crawl_web_task_with_cdp`, `tasks.py:300-382`). The pool
      service itself is untouched; it simply loses its last client.
- [ ] Keep `crawler_pool.get_crawler` only behind `CRAWLAGENT_LOCAL_BROWSER=1` for developer
      machines, so "run it locally without webrain" is still possible.
- **Gate:** with an engine configured, a crawl job completes with **zero** Chrome processes started
      by crawlagent — assert on `psutil`, not on logs.
- **Rollback:** unset `WEBRAIN_MCP_URL` → `crawler_pool` path, unchanged behaviour.
- **Risk:** the browser is now a network hop away. webrain being down must surface as a *typed*
      failure inside the BFF's timeout, not a hung job.

### P3 — one progress truth

- [ ] Delete `websocket_router.py:126` (`/task/status`) and `:97` (`/events`). Both are orphaned:
      the frontend polls BFF SSE. Leaving them is a second, unguarded progress channel.
- [ ] Keep the Redis `task:{id}` hash as the record. Celery is removed, not chosen against — see §10
      for why and §12 for the switch that replaces it.
- [ ] Delete `triggers.py`, the `celery` dependency and the worker entrypoint (§13).
- **Gate:** the operations page shows live rows with the WS routes deleted.
- **Rollback:** restore the router; nothing else reads it.

### P4 — merge the storage stories

Per `13-runbook-and-storage-contract.md` Part D, crawlagent's crawl path **never writes storage**
today — only diagnostics and backups do. So this is a deletion plus a pointer, not a migration:

- [ ] Remove `/blob/*` and `/ws/blob/*` from crawlagent's served surface. They belong to the
      frozen pool service, not the crawl path.
- [ ] `storage.py` keeps exactly two jobs: health probe and backup, and reads the platform's
      bucket from the same `TIGRIS_*`/`AWS_*` precedence it already implements.
- [ ] Delete the `crawlagent.bucket.a` default. A wrong default is a bucket — the platform's own
      choice is an empty default that fails closed (`13`, Part C).
- [ ] Artifacts a crawl job produces go through `s3-blob-store.ts` under the tenant prefix, so the
      frontend's `/api/storage/*` already serves them.
- **Gate:** a deleted account's artifacts are swept by the existing purge; no object lands outside
      the tenant prefix.

### P5 — frontend wiring (the part that is already 80 % done)

- [ ] Provider refusal is already echoed (`x-scrape-provider-rejected`) but not shown. Surface it
      in the crawl result panel: "your setting was refused because …".
- [ ] Operations rows carry no provider label. Add the provider to the row from the enqueue
      response, so a support ticket can say which engine ran it.
- [ ] The cost estimate must price the selected provider. `jobEnqueuePath` is already exported for
      exactly this reason (`crawlapi.service.ts:34-40`) — extend the same rule to the provider.
- [ ] `ai-keys` already stores a reader key per provider; make `crawl4ai` say **platform-managed**
      rather than showing an empty key field.
- **Gate:** `bun run build` 0 with the 14 prerendered routes; Karma green; a `crawl4ai` selection
      round-trips through settings and is visible on the next job row.

---

## 8. What not to do, with the reason

| Idea | Why not |
|---|---|
| Expose a CDP port from webrain so crawlagent can attach | New inbound, unauthenticated-by-design surface on the browser fleet — the same mistake `browser_pool_service` made, with a worse blast radius. |
| Revive the browser pool as the "session" backend | Its context model shares one browser process across tenants; I2 forbids it under any name. Keep it legacy. |
| Build a progress WebSocket on the BFF | SSE already exists and the poll is 4 s; a socket adds a connection lifecycle to the Cloud Run shape for no measured gain. |
| Port crawlagent's markdown/LLM pipeline into webrain | webrain's own skip-list refuses it (`INTEGRATION_PLAN.md` §6). The split is deliberate. |
| Let crawlagent write Firestore | Three stores is D4; adding the platform's DB makes four, from a service the platform does not own. |
| Keep `/task/status` "just in case" | An unguarded second progress channel is how the two drift and how a metering hole appears. |

---

## 9. Effort and risk

| Phase | Size | Risk if wrong |
|---|---|---|
| P0 | S — one config flag, three deletions | **High if skipped**: open browser + open gauges |
| P1 | S/M — two repos, one contract | Medium: a wrong path or key silently pins users to a 404/401 |
| P2 | **L** — the engine seam, one webrain op (§14), one deletion | High: the browser becomes a network dependency of every crawl |
| P3 | **L**, not M — removes a queue, an HTTP surface and a trigger path (§20) | Low if done with the gate below, because nothing reads them |
| P4 | S — deletion + a pointer | Medium: a wrong bucket is data in the wrong place |
| P5 | S — four UI touches | Low |

The only phase that can break paying traffic is **P2**, and only if `WEBRAIN_MCP_URL` is set in an
environment where webrain is not reachable. Guard it: health-check the engine once at boot and keep
the local-browser path as the fallback rather than failing the route.

---

## 10. Decisions, settled (2026-10-22)

The owner delegated all four. They are decided here, with the evidence that decides them.

| Decision | Verdict | Why — and what it deletes |
|---|---|---|
| **Celery or QStash** | **QStash. Celery is removed in P3.** | QStash already publishes through a verified signature to a worker route, with a DLQ and `flowControl.parallelism` *derived* from pool size (`functions/src/infrastructure/qstash.ts`). Celery would add a second broker, a second retry policy and a **second result store** — which is D4's third store under another name. Removing it deletes `triggers.py`, every `AsyncResult` read, the `celery` dependency and a worker process: the largest single deletion in this roadmap. |
| **Does crawlagent ever lease a browser?** | **No — never, in any phase, under any transport.** | It is the one invariant that survives frames, WebRTC and MCP alike. A lease is a fleet concern; arachnefly owns the reaper and the meter. |
| **Is `crawl4ai` billable?** | **Yes — so C4 blocks P1.** | Its cost is CPU (markdown) and tokens (`_llm_extraction_task_impl`, `tasks.py:595`): money per job with **no browser minute to key it to**. A free provider and a billable one behind one meter is how a margin goes negative silently. Bill on two lines, `crawlagent.markdown` and `crawlagent.extract`. |
| **Numbering** | **23 stands.** | `22-dev-prod-parity.md` exists. `README.md` still untouched by this document. |

Two consequences that stop being optional once the above is accepted:

- `usage` must appear on **every** branch of `reader`, including the text and ndjson ones (C4), or
  the meter is asked to price a job it cannot measure.
- A QStash-published enqueue **must be idempotent** (C6), because QStash retries the *enqueue call*,
  not the job. The platform already has the pattern: `applyBillingCreditMutation` idempotency keys.

---

## 11. Frontend: what the pack is, and the gaps that are measurable

**Correction to an earlier reading of this document.** `crawl-pack` is not a dead end: it is a config
editor whose output another page executes. Nothing in `src/app/pages/user/crawl-pack` imports
`HttpClient` or `CrawlAPIService` — the pack is written to Firestore, then `AppCrawlComponent`
(mounted by `/playground`) and `OperationsComponent` load it and enqueue it:

```
crawl-pack tabs ──► users/{uid}/crawlpack ──► loadPreviousPacks()
                                                   │
                    AppCrawlComponent.crawlEnqueue()   /   OperationsComponent
                                                   │
                         CrawlAPIService.multiCrawlEnqueue()
                                                   │
                             POST /api/crawl/stream/job   (BFF)
```

`multiCrawlEnqueue` spreads the pack into the request body (`crawlapi.service.ts:255-261`), so **the
pack is the wire contract**. That is exactly why the two defects in §11.2 are not cosmetic.

### 11.1 The five tabs and what each produces

| Tab | Route | Produces | Persisted to |
|---|---|---|---|
| Crawler Pack | `/crawlpack` | the assembled `CrawlPack` | `users/{uid}/crawlpack` (`crawlerpack.component.ts:164`) |
| Browser Configuration | `/crawlpack/browser` | `BrowserProfile` | `users/{uid}/browserprofiles` |
| Crawler Configuration | `/crawlpack/configuration` | `CrawlConfig` | `users/{uid}/crawlconfigs` |
| Crawler Results | `/crawlpack/results` | result shape | `users/{uid}/crawlresults` |
| Extraction Strategies | `/crawlpack/extraction` | `{ schema }` | cart only — **never reaches the pack** |

`Machines` is no longer a tab; it moved to `/machines` (`main.route.ts:105-118`). Writes are direct
client Firestore calls; reads of the saved lists go through server callables
(`getCrawlConfigsPaging`, `getBrowserProfilesPaging`). Nothing validates a config's **shape** on the
way in — the callable only pages it back out.

### 11.2 Two confirmed defects in the pack path

- **`extractionStrategy` never reaches the wire, and corrupts `config.value` on the way.**
  `switchPackKey` has arms for `crawlConfig`, `browserProfile`, `crawlResultConfig` and
  `default: return packKey` (`core/functions/cart.fun.ts:76-110`), so the key stays the *string*
  `'extractionStrategy'`. `setCartItems` then reads `items[k]?.config`, which is undefined for that
  item, and `saveCartItems`'s `Object.values(...).reduce({...acc, ...curr})` spreads the string into
  `config.value` as index keys `0,1,2,…`. A pack that contains an extraction strategy ships a
  corrupted config — a data bug, not a missing feature.
- **`CartService.listenToFirestoreChanges` logs the whole cart document** — which carries
  browser-profile cookies and headers — on every change (`cart.service.ts:139-170`). A credential in
  a console log, on the exact surface §17 is about.

### 11.3 Entry points into scraping

Three exist; only one is provider-aware. Measured by grepping `src/app` for `CrawlAPIService`,
`AiFetchService`, `WebrainToolsService` and `scrapeProvider`.

| Entry point | Route | Provider-aware? | Reached from |
|---|---|---|---|
| `CrawlAPIService` | `/api/crawl`, `/api/job/stream/status` | **yes** — the BFF resolves it | `<app-crawl>` (mounted by `playground`), `operations`, `dashboard` |
| `AiFetchService` | `/api/scrape` | **no** — webrain only, free, gated `crawl.execute` | `chatai`, `app-llm-scrape` |
| `WebrainToolsService` | `/api/webrain/*` | **no** — webrain tools directly | playground tools panel, `crawl-pack/extract-strategy`, `chatai` |

The gaps:

- **`/chatai` can never reach crawlagent.** It fetches through `AiFetchService`
  (`ai-fetch.service.ts:44`, `POST /api/scrape`), whose own docstring explains that this is
  deliberately *not* `CrawlAPIService` because `/api/crawl` is separately gated. True today; the
  moment crawlagent is a provider, chatai becomes the page where the setting silently does not
  apply. Decide once: chatai honours the setting, or settings says it does not.
- **`crawl-pack` assembles; it does not crawl — and that is by design, not a gap.** The tabs write
  configs into a cart (`CartService.addItemToCart`, called from all four config tabs) and
  `CrawlerPackComponent.saveCartItems` assembles them into `users/{uid}/crawlpack`. Execution lives
  one page away (§11). The real gap is not the wiring but the **content**: the forms promise fields
  the provider cannot honour and omit fields it can. That is §16.
- **`extract-strategy` previews with `WebrainToolsService` directly** (`CartService,
  WebrainToolsService`), so a pack is authored against webrain's tool surface and is webrain-shaped
  by construction. Either that is the product (packs are webrain-only) or it needs the provider seam.
- **The provider selection has no consumer.** `scrapeProvider` appears only in
  `ai-keys.component.ts`, `ai-keys.service.ts` and `ai-provider.interface.ts` — nowhere under
  `pages/`. `x-scrape-provider-rejected` is echoed by the BFF and read by nobody. That is P5, and it
  is the cheapest visible win in this document.
- **`/playground` is the only page where both providers already meet** — it mounts `<app-crawl>`
  (provider-aware) *and* the tools panel (webrain-direct). Finish the wiring there; do not add a page.

## 12. The queue switch (spec, not applied)

crawlagent — a `queue:` block beside `security:`, same file, same indentation style:

```yaml
queue:
  backend: "celery"                 # celery | qstash   (production: qstash)
  qstash:
    current_signing_key_env: "QSTASH_CURRENT_SIGNING_KEY"
    next_signing_key_env: "QSTASH_NEXT_SIGNING_KEY"
```

Three traps, each already paid for somewhere in this codebase:

1. **`configure.py` substitutes an unset `${VAR}` with the empty string.** Proven by the removed
   `rate_limiting.storage_uri`, whose comment is still in `config.yml`. So `backend: qstash` with an
   empty key must **raise at import**, the way `redisCache.py` already raises on a missing Upstash
   var. A silently empty key is a route that accepts unsigned requests.
2. **Verify the raw body.** `verifyQstashDelivery` in `functions/src/infrastructure/qstash.ts`
   records why: a re-serialised object is a different signature. Read `await request.body()` before
   any model validation.
3. **Direction is deepscrape → crawlagent.** crawlagent gains no worker route and no consumer:
   QStash publishes to the enqueue route that already exists (`POST /api/v1/crawl/`), crawlagent
   verifies, then enqueues. That is the whole change — and it is why C6 is blocking.

deepscrape reuses `publishCrawlTarget` **unchanged, including `FLOW_CONTROL_KEY = "webrain-pool"`**.
Not laziness: after P2 the scarce resource is the same browser fleet, so one global ceiling is the
correct ceiling, and a second key would let crawlagent jobs and webrain jobs each run to the pool
limit. `parallelism` stays derived from pool size in `functions/src/infrastructure/qstash.ts`,
never configured.

## 13. Minimising crawlagent (deletion ledger)

Target: three routers and one job engine. Everything here is a deletion, so it cannot regress.

| Remove | Why |
|---|---|
| `triggers.py` (Celery task defs), the `celery` dependency, the worker entrypoint | §10 — QStash wins. |
| `AsyncResult` reads and the Celery result backend | D4: a third store for one truth. |
| `routers/websocket_router.py` `/task/status` and `/events` | Orphaned; the frontend polls BFF SSE. |
| `GET /` (`server.py:403`), `/metrics` with no dependency (`:480`), `/api/v1/diagnostics/*` | P0 surface no SaaS feature reads. |
| `browser/blob_ws_router` from the crawl app | Belongs to the frozen pool; also a second artifact store (D5). |
| `crawler_pool.get_crawler` → behind `CRAWLAGENT_LOCAL_BROWSER=1` | P2. |
| the `crawlagent.bucket.a` default | A wrong default is a bucket; fail closed instead. |

**Verify before deleting**, on this document's word alone being insufficient: `api.py`
`handle_markdown_request` (looks like a second copy of `crawl.reader`), `dynamic_selectors.py`
(fan-in unclear), `monitoring.py` (keep only if the BFF or the operations page reads it — today
nothing does).

**Keep explicitly:** `routers/crawl_router.py`, `routers/job_router.py`, `routers/seeder_router.py`,
`crawl.reader`, the four `tasks.py` impls, `storage.py` reduced to health + backup, `auth.py`.
The graph reports 73 `Route` nodes across 99 files; crawling is a small part of that surface.

**This list undersells the job.** The larger deletions — a Lua/Redis queue, a second HTTP surface in
`api.py`, a Firestore-trigger path, and two extra crawl-config builders — are in §20. Read them
together: P3 is a subsystem removal, not a route cleanup.

## 14. P2's mapping, decided

The question was whether `CrawlerRunConfig`'s `js_code` / `wait_for` / `css_selector` fold onto
`webrain_crawl` or need `webrain_batch op=fetch`. Measured answer: **`webrain_crawl` is not a fetch
at all, and those three fields are not in use.**

`webrain_crawl` (`webrain-mcp/src/tools.rs:727`, `map_surface`) has four modes — `spider` →
`webrain_spider`, `sitemap` → `webrain_sitemap`, `scan` → `webrain_scan`, `validate` →
`webrain_validate_urls`. Their replies are links and counts, never page content.

The fetch surfaces that do exist:

| Need | Surface | Comes back | Cost |
|---|---|---|---|
| static text | `webrain_scrape` → `webrain_fetch_http` | HTTP body, no JS | cheapest |
| JS-rendered text | `webrain_batch` `op=fetch` → `batch_fetch` (`engines.rs:2048`) | `document.title` + `innerText`, **capped at 3000 chars**, no HTML | browser |
| markdown / fit-pruned | **not exposed** — see below | — | — |
| structured | `webrain_extract` modes (schema, regex, jsonld, table, autoschema, bm25) | typed JSON | browser |

And the field list, measured against `actions.basic_crawl` (`actions.py:249`): the live
`CrawlerRunConfig` sets `session_id`, `cache_mode`, `markdown_generator`, `extraction_strategy`,
`stream`, `exclude_external_links`, `exclude_social_media_links`. **`js_code`, `wait_for`,
`css_selector`, `magic`, `scan_full_page`, `process_iframes`, `simulate_user` are all commented
out.** The mapping problem this document feared does not exist in the code.

**The one gap that does exist.** `engines::batch_markdown` (`engines.rs:2109`) already does what
crawl4ai's markdown generator does — `outerHTML` → `htmd` markdown with `skip_tags`, then a
fence-aware chunk plus the existing `bm25_filter` for fit-pruning; its own comment calls it "the same
prune crawl4ai's fit_markdown does, zero LLM". It has **no caller**: `call_tool` dispatches
`batch_fetch` (`tools.rs:1846`) and `markdown` appears in `list_tools` only as prose. webrain can do
it and does not expose it.

**Recommendation — add `webrain_batch op=markdown`:** one arm in `map_surface`, one arm in
`call_tool` calling `engines::batch_markdown`, forwarding the `query` / `top_k` pair it already
accepts. Roughly ten lines, no new engine, no new dependency. It removes the 3000-char cap that makes
`op=fetch` useless for markdown. Without it, every job wanting markdown needs a local browser, so
**P2 cannot complete** — which makes this webrain op a P2 dependency, not an enhancement.

Robustness rules that follow:

- **Probe once at boot**, never per request: the `tools/list` reply says whether the batch tool
  advertises `markdown`. Cache the verdict. A per-request probe adds latency to the thing it protects.
- **The tier is a property of the job**, declared by the caller (`text` | `markdown` | `structured`)
  and refused with a typed error when unavailable — never silently downgraded. A silent downgrade is
  how a customer pays for markdown and receives 3000 characters.
- **Do not normalise the seed field in crawlagent.** `map_surface` already fills `url`, `seed_url`
  and `urls` from whichever the caller sent; a second normaliser is the exact bug that fix deleted.

## 15. WebRTC as an alternative to frames (opt-in)

What exists: `core/components/browser/*` (`BrowserComponent`, `control`, `clipboard`, `resolution`)
and `core/services/webrtc.service.ts`, which builds `/ws?password=…&username=…` — the **neko**
handshake, not crawlagent's. All of it is unreachable today (unmounted 2026-10-10 because it pinned
every visit to a host this repo does not control). The shipped live view is one `image/png` per poll
through `/api/browser/session/:id/frame`.

Decision: **frames stay the default; WebRTC is an opt-in tier, and the server picks the transport.**

- The setting stores **intent** (`browser.liveView: 'frames' | 'webrtc'`); the BFF/arachnefly answers
  whether a WebRTC endpoint exists for that session. A client-only toggle buys a black screen,
  because the endpoint is per session and the client cannot mint one.
- **One room per leased session.** A neko room is single-user; sharing one across tenants is the pool
  mistake (I2) with video attached.
- **Never revive `neko-rtc.fly.dev`.** The session's own machine hosts the room, reached through the
  same arachnefly machine route the frames already use — one ownership check, not two.
- Frames stay for observation of many sessions; WebRTC only where input latency *is* the product.
  Video is per-session bandwidth plus TURN; frames are stateless and cacheable.

## 16. The capability contract: what the tabs promise vs what exists

The two forms *are* the contract. `crawl-config.component.ts` `initForm` declares ~45 controls;
`browser-config.component.ts` `initForm` declares ~16. Both were written against an **older crawl4ai**
than the installed 0.9.x, and nothing validates a form value against the library. Compared field by
field against the current docs (BrowserConfig / CrawlerRunConfig / LLMConfig, plus the advanced
features index), the fields fall into three buckets.

**A — promised by the UI, gone from crawl4ai 0.9.** `onlyText`, `excludedSelector`,
`keepDataAttributes`, `removeForms`, `prettify`, `ignoreBodyVisibility`, `adjustViewportToContent`,
`waitForImages`, `imageDescriptionMinWordThreshold`, `imageScoreThreshold`, `excludeExternalImages`,
`excludeSocialMediaDomains`, `excludeDomains`, `screenshotHeightThreshold`, `screenshotWaitFor`,
`logConsole`. These are 0.2/0.3-era parameters (`only_text`, `excluded_tags`, `keep_data_attributes`,
`remove_forms`, `prettify`) that moved into content filters or were deleted. **Whether the installed
`CrawlerRunConfig` raises `TypeError` on them or ignores them depends on whether it accepts
`**kwargs` — one ten-line probe answers it, and it is the first thing to run before any phase.** If it
raises, every pack carrying one of these is a 500 today.

**B — crawl4ai 0.9 has it, no tab can reach it.** `storage_state`, `proxy_config` as an ordered list
plus `proxy_rotation_strategy`, `js_code_before_wait`, `c4a_script`, `flatten_shadow_dom`,
`locale` / `timezone_id` / `geolocation`, `max_retries` + `fallback_fetch_function`, `url_matcher` +
`match_mode`, `capture_mhtml`, `force_viewport_screenshot`, `fetch_ssl_certificate`,
`accept_downloads` / `downloads_path`, `browser_mode`, `enable_stealth`, `avoid_ads` / `avoid_css`,
`device_scale_factor`, `chunking_strategy`, `markdown_generator` + content filter.
`extraction_strategy` is nominally a tab but is broken (§11.2). Note the browser tab already carries a
commented block naming `cdp_url`, `storage_state` and `accept_downloads` — the previous author knew,
and stopped.

**C — whole subsystems in crawl4ai, absent from both the UI and the service.** Deep crawl
(BFS / DFS / BestFirst), URL seeding, domain mapping, adaptive crawling, virtual scroll, network and
console capture, file downloading, lifecycle hooks, PDF parsing.

### The decision: honour the UI, do not port the library

| Bucket | Action | Why |
|---|---|---|
| **A** | **delete the controls** | A control that cannot work is a support ticket. Deletion is the cheapest correct move, and it shrinks the pack schema. |
| **B** | **add the eight a customer would pay for**, in this order: `storage_state`, `proxy_config` list + rotation, `js_code_before_wait` / `c4a_script`, `fetch_ssl_certificate`, `capture_mhtml`, `locale`/`timezone`/`geolocation`, `max_retries` + fallback, `flatten_shadow_dom` | each is one form control plus a snake_case passthrough — no new crawlagent code |
| **C** | **do not port — map or refuse** | every item is already something webrain owns: deep crawl ≈ `webrain_crawl` spider, URL seeding ≈ sitemap/seeder, adaptive ≈ `webrain_batch` + `extract`, virtual scroll ≈ `webrain_interact scroll`, console ≈ `webrain_observe what="console"`. This is the same split as §14. |

**The structural finding that gates all of it.** The two tabs produce fields for two different
crawl4ai classes — `BrowserConfig` (browser tab) and `CrawlerRunConfig` (crawler tab) — and the
packager flattens them into **one** object, which `multiCrawlEnqueue` spreads into the request body.
Nothing on the server routes them to the right class. Today's working fields work by luck of naming,
and any new field inherits that luck. The contract needs one shape, decided once:

```json
{ "browser": { }, "run": { }, "extraction": { } }
```

with a single server-side splitter. That is the C-contract change in §5, and it is what makes every
row in the table above land instead of leak. Do this **before** adding bucket B, or every added
control inherits the ambiguity.

Also: the browser tab carries `// FIXME: proxyConfig its not ready yet` on its own control. Proxy is
the most-requested crawl feature; it is admitted-dead in the UI.

## 17. Credentials: two systems that overlap — and the merge

Measured. Two stores, two verifiers, one concept, and a false claim in the copy.

| | BYOK panel — `<app-ai-keys>` in General settings | "API Keys" tab — `/settings/keys` |
|---|---|---|
| stores | Firestore `users/{uid}/private/ai` + Secret Manager `ai-key-{uid}-{vendor}` | Firestore `users/{uid}/apikeys` + Secret `users_{uid}_apikey_{docId}` + index `apiKeyIndex/{sha256}` |
| holds | 10 AI vendor keys, the `custom` endpoint, **the scrape-engine choice**, and reader keys (jina) | a **bearer token for our own `/api`** |
| read by | `requirePaidOrByok` (`syncaiapi.ts:443`) — decides whether a metered route runs | `isJwtAuth` (`syncaiapi.ts:142`) — decides who the caller is |

The overlap is the defect. **Both surfaces offer a "Jina / OpenAI / Anthropic" key, and neither store
is visible to the other's consumer.** A Jina key pasted on `/settings/keys` lands in `apikeys`, which
`requirePaidOrByok` never reads; the same key saved in the BYOK panel lands in `private/ai`, which
`isJwtAuth` never reads. Same credential, two homes, inert in the other's context.

**Decision — two stores stay, because they answer two different questions; the overlap and the lies
go.**

1. **Vendor credentials live only in the BYOK panel.** It already holds the AI keys, the reader keys
   and the engine choice. Rename the card to **"Providers"** — it is not only AI — and give the
   engine selector its own block inside it. That mislabel is *why* the two surfaces drifted.
2. **Platform tokens live only in `/settings/keys`.** A platform key is *our* credential, so the
   dialog's four "types" (Jina / Anthropic / OpenAI / Custom) must be **deleted**. A token is a
   token; the types exist only because two concepts were confused.
3. **Delete the paste-a-key path.** `keyModalCompleted()` sends `this.newApiKey.value` as the
   credential (`api-keys.component.ts:213-260`), which makes `generateApiKey`'s `'dpsp-key-' + random`
   default dead code — and a pasted vendor key is stored under a name `isPlatformApiKey` will not
   classify (`api-key-index.domain.ts:61`), so **it can never authenticate `/api`**. Mint, do not
   paste.
4. **Delete `Disable API Key`** — its body is `throw new Error('Method not implemented.')`
   (`api-keys.component.ts:106-114`). A button that always throws is worse than no button.
5. **Delete `permissions`, `default` and `type`, or enforce them.** All three are written by client
   and server, and read by nothing: `isJwtAuth` builds `req.user = { uid }` only. The UI renders a
   "Permissions" section and an untranslated `default` checkbox that do nothing.
6. **Correct the false claim.** `SETTINGS_API_KEYS.OWNERSHIP_NOTE` promises keys owned by
   workspaces that outlive their creator; storage is `users/{uid}/apikeys` and `deleteMyApiKey` drops
   the index entry, so the key dies with that uid. Either implement workspace ownership or fix the
   sentence. Today it is a security claim the code does not keep.
7. **One dialog, two contents.** The popup's colours, spacing and box are a **design asset, not a
   feature** — extract them into the shared dialog shell the theme already defines, and let both
   surfaces use it. One visual component, two contents, no second copy of the markup.
8. `api-keys.component.ts` calls `ChangeDetectorRef.detectChanges()` at three sites in a **zoneless**
   app; the sibling BYOK panel is signals-only. Convert it — do not copy the pattern.

**Sequencing:** (3), (4) and (5) are deletions and ship alone. (1), (2) and (6) are copy and labels
and need the i18n gate. (7) is styling only — and before touching any class, grep the component's TS
for `querySelector` / `classList`: a class the TS reads is an API, not a style.

## 18. `app-llm-scrape`: yes, it is the over-built one — keep it as a tool, not a mode

Agreed in substance, with one correction: it is **not** unwired. `AppLLMScrapeComponent` is imported
at `playground.component.ts:6` and mounted at `playground.component.html:71`, so it is a live mode
today.

Why it should not be a peer mode:

- It cannot run without an AI vendor key (`AiKeysService` → `requirePaidOrByok`), so for a free or
  key-less account it is a tab whose only possible outcome is an error.
- It costs tokens **and** a page fetch, and it sits beside the two cheap engines as if it were one of
  them. The most expensive path is presented as a default-looking option.
- Everything it does is already reachable as `webrain_extract` plus an AI call, or as the extraction
  tab.

Smallest correct change: **keep the component, gate the entry.** Render the mode only when
`getMySettings` reports a usable vendor key — which is the same fact `requirePaidOrByok` already
decides server-side, so the client is rendering the server's answer rather than inventing a rule. One
conditional over an existing signal; no deletion, no rewrite. Delete it only if usage data says
nobody runs it — architecture alone is not evidence.

## 19. Orchestration: who owns which decision

The capability list exists **four times**, and the frontend owns one of them — which is the wrong
owner, and the code already says so.

1. **webrain MCP** — 17 tools, deliberately *intent-shaped*: `webrain_observe what=…`,
   `webrain_interact action=…`, `webrain_extract mode=…`. Branches, not a tool per feature.
2. **BFF** — 11 explicit routes: `/search`, `/extract`, `/pdf`, `/vision`, `/guide`, `/navigate`,
   `/observe`, `/batch`, `/spider`, `/watch`, `/extract/schema`.
3. **`WebrainToolsService`** — 11 hand-written methods, each docstring naming the tool it wraps.
4. **UI** — the tools panel's tabs, plus `crawl-pack`'s 45 + 16 form controls (crawl4ai's parameter
   surface, a fifth list).

**Verdict: "the frontend decides which capabilities exist" is the wrong path, and the code proves it
without needing an opinion.** `WebrainToolsService`'s own docstrings record that `extract`, `observe`,
`navigate` and `vision(op=ask)` answer `502 — Needs a private worker` on the shared pool. That is
**four of eleven tabs guaranteed to fail for most callers**, and nothing in the client knows it. A
client cannot evaluate an availability rule it does not hold, so it shows the tab and lets the user
discover the 502.

**The rule: the frontend renders availability; it never decides it.**

| Question | Owner | Today |
|---|---|---|
| which capabilities exist | BFF, one static typed table | nowhere — implied by 11 routes |
| which are available to *this* caller, and why not | BFF: `GET /api/capabilities` → `available` + `reason` | the client guesses |
| what each costs | BFF, same table, keyed by capability id | a separate pricing table |
| how it is laid out | frontend | hardcoded tabs |

Precedent already in the repo and worth copying exactly: the scrape-engine list is server-driven
(`getMySettings` returns `selectable`, and `ai-keys` renders *that*, deliberately, so plan rules are
not duplicated client-side). Extend that one pattern to the rest.

**Smallest step — do this before anything else in this section:** add `GET /api/capabilities`
returning the table, and gate the four 502 tabs on it. One route, one table, four conditional
renders. **No form generator, no schema-driven UI** — the hand-written forms stay. That is the whole
change, and it deletes a whole class of support ticket.

Do **not** collapse the 11 routes into a generic runner yet. Each route carries a guard reason (free,
paid, exclusive worker) that a generic route would have to re-derive from data anyway; the payoff is
internal tidiness and the risk is losing the per-route docstrings that explain the subtle ones.

### Development vs production — the parity rule

**Dev and prod differ in addresses and secrets only. Every other difference is a bug.**

| Thing | dev | prod | Switch |
|---|---|---|---|
| upstream hosts | localhost ports | Fly / Cloud Run | `functions/src/config/upstreams.ts` (`PRODUCTION`) — exists |
| queue backend | `qstash-cli dev` | QStash | `config.yml queue.backend` — §12 |
| crawlagent's browser | `CRAWLAGENT_LOCAL_BROWSER=1` | never | env flag — P2 |
| CORS | `cors_origins_dev` | `cors_origins` | `config.yml` — exists, and it is the model |
| auth | — | — | `jwt_enabled` — **delete this one** |

That last row is the trap the platform already fell into: `jwt_enabled: false` was a legitimate dev
value and it shipped, leaving every route open (D1). **A switch whose "off" position is catastrophic
in production is not a setting; it is a bug with a switch.** Delete it and always verify. Local work
that needs to skip auth should carry a local-only dev token, not a global off-switch.

## 20. Deletion ledger, second pass: crawlagent has four crawl stacks

Measured from the file outlines. Five files, roughly 3,000 lines, all answering "turn URLs into
results":

| File | Lines | What it is | Verdict |
|---|---|---|---|
| `crawl.py` | 575 | a **Redis + Lua queue** (`LUA_SCRIPT`, `scheduled_queue`, `schedule_task`, `process_scheduled_tasks`, `pop_batch`, `worker`, `main_process`) plus `reader`, `process_task_with_monitoring`, `processOperation`, `process_urls` | **keep `reader` only**. The Lua queue and the three `process*` functions are a *third* queue mechanism and go |
| `tasks.py` | 953 | Celery wrappers + `_impl` bodies + direct async handlers | keep the four `_impl` and the two `handle_*` functions; drop the Celery wrappers (§10) |
| `api.py` | 785 | a full second HTTP surface: `handle_crawl_job`, `handle_crawl_stream_job`, `handle_markdown_request`, `handle_llm_request`, `multi_domain_research_job`, `cancel_a_job`, `handle_task_status`, `handle_stream_task_status`, `create_new_task` | **delete the file** — `routers/*` supersede it and nothing mounts it |
| `triggers.py` | 328 | Firestore-trigger entry points that re-run the same crawl from a document | delete with Celery |
| `actions.py` | 403 | the crawl4ai config builder + `infinite_scroll` / `load_more` | keep one builder; delete the two scroll loops (`scan_full_page` / `webrain_interact scroll` replace them) |

Three more duplications fall out of the same outlines: `get_firebase_client` is defined **twice**
(`tasks.py:132`, `api.py:80`); the crawl4ai config is assembled in **three** places
(`actions.basic_crawl`, `crawl.processOperation`, `triggers`); and **three queue mechanisms** — Lua
over Redis, Celery, QStash — serve one job.

**Target: one route table (`routers/*`), one queue (QStash), one config builder, one task-state store
(the Redis hash).** This is much larger than the route deletions §13 lists, which means §13 undersold
P3: the queue decision (§10) is not a swap, it is the removal of a whole subsystem.

One thing worth crediting, measured before it was doubted: `webrain_` appears under `src/app` almost
only in **comments**. The client does not hardcode webrain tool names — the drift risk is in the
*lists* (§19), not in the calls. Leave that alone.

## 21. What this audit cannot see (coverage, honestly)

`check_index_coverage` this round:

- **deepscrape** — `functions/src` and `bff`: **0 gaps**. `src/app`: **75 gaps, every one
  `parse_partial` on a `.html` or `.scss`**. So every TypeScript claim in this document is
  graph-backed, and every **template** claim was read from source. A template claim I did not read is
  a guess, and `bun run build` is the only thing that validates one.
- **crawlagent** — all 16 cited files report `metadata_changed` against a graph from 2026-10-10, so
  file:line is the evidence. §20 rests on **outlines**, which are positional rather than semantic and
  therefore survive a stale index; the line ranges are still worth re-reading before deleting.
- **webrain** — all four cited files `metadata_changed` since 2026-10-20.
- **`WebrainToolsService` reports `callers: 0` while four components import it.** Do not trust caller
  counts through `inject()` — dependency injection is invisible to the graph. Read the import site.

## 22. Readiness gate: what may start now, and what must not

Measured this round, from source. Three readings settle the questions §21 left open — and the first
one changes the plan's framing.

### 22.1 The route is disabled, not the provider

`SCRAPE_PROVIDERS` gives `crawl4ai` `minAccess: "free"` and `routes: ["crawl"]`, so
`selectableProviders()` offers it to **every** caller, and `FALLBACK_PROVIDER` is `crawl4ai`. But its
own catalogue `notes` say: **"Its job pipeline is currently disabled at the route table (see the ADR
§10)."**

So the provider is selectable while its pipeline is off. That means **P1's gate cannot pass today**,
and re-enabling the route is a change to a paying path — so it becomes an explicit P1 item with its
own rollback, not an assumption. A user who selects crawlagent right now is exercising a preference
the platform cannot honour, which is exactly the case `ProviderResolution.rejected` was built for.

Also measured: `rejected.reason` is already typed `"unknown" | "route" | "entitlement"`. **P5 needs no
new contract** — it needs to render a value that already exists.

### 22.2 Three of crawlagent's five Fly processes are deletable, and one must stay

`fly.toml [processes]` runs four groups:

| Process | Command | Verdict |
|---|---|---|
| `app` | `supervisord -c supervisord.conf` → gunicorn | keep (P0 hardens it) |
| `worker` | `celery … --concurrency=4` | **delete in P3** |
| `worker_exporter` | `./celery-exporter … --port=9808` | **delete in P3** |
| `browser_pool` | `uvicorn browser_pool_service:app … --port=9000` | **keep — frozen** |

`supervisord.conf` runs **only gunicorn**, and carries the comment *"Do NOT use supervisord for Celery
or exporter on Fly.io. Define those as separate processes in fly.toml."* Therefore the Lua/Redis queue
in `crawl.py` (`worker`, `main_process`, `pop_batch`, `scheduled_queue`) **has no process anywhere** —
it is dead in production, and §20's largest deletion is confirmed rather than inferred.

Deleting `worker` and `worker_exporter` is a `fly.toml` edit plus a scale-down: two commands, fully
reversible. And `BROWSER_POOL_SERVICE_URL = http://pool.internal:9000` proves the pool is a **second
Fly app**, so the frozen service is not even inside this fly.toml's blast radius.

### 22.3 The API container boots a virtual display it does not need

`docker-entrypoint.sh` starts `Xvfb`, `x11vnc` and `websockify` for the `app` process, and skips
noVNC only when the process is celery. Once P2 lands, the API owns no browser, so the whole block is
dead weight in every web container — and its websockify line is already broken (`localost:5900`),
which is the tell that nothing reads it. **Delete the block; do not fix the typo.**

### 22.4 webrain's `op=markdown` is one match arm, confirmed not estimated

`call_tool`'s batch closure dispatches `extract`, `interact`, `screenshot`, `eval`, and
`_ => batch_fetch`. Adding `"markdown" => batch_markdown(b, urls, &query, top_k, concurrency, opts)`
plus the two argument reads is the entire change. P2's only external dependency is small and
mechanical.

### Verdict per phase

| Phase or item | Ready? | Blocked on |
|---|---|---|
| **P0** | **yes — start here** | nothing: three deletions and one config value |
| **P5 frontend wiring** | **yes — should go first** | nothing. `rejected.reason` already exists (§22.1) |
| §11.2 pack data bugs | **yes** | nothing; these corrupt packs today |
| **P1** | **yes, with one added item** | re-enable the crawl4ai job route (§22.1) before its gate can pass |
| **P3** | **yes, high confidence** | `fly.toml` process groups + `crawl.py` queue functions (§22.2) |
| **P2** | **yes** | the webrain `op=markdown` arm (§22.4) must ship in a published image first |
| **P4** | **yes** | storage only; nothing depends on it |
| §16 bucket A | **needs one probe** | does the installed `CrawlerRunConfig` raise on those 16 kwargs? |
| §16 bucket B | **no — do not start** | C7's `{browser, run, extraction}` split must land first |
| §17 credentials | **yes** | deletions first; the renames need the i18n gate |

**Recommended order:** P0 → the two §11.2 data bugs → P5 → P1 → P3 → P2 → P4. P2 is last of the
backend work because it is the only item that puts a network hop under every crawl.

**One thing not to start with:** bucket B of §16. Adding form controls before the wire is split just
adds fields to an object nothing routes to the right crawl4ai class.

## 23. The one-line summary

crawlagent's value to this platform is the **job**, not the browser — so unfreeze it as an
orchestrator that asks webrain for pages (through one new webrain op that already exists as dead
code), writes through the platform's storage port, keeps one Redis truth, retries through QStash, and
never opens a port or a browser of its own. On the frontend, the smallest honest change is to stop
guessing: **serve one capability table, gate the tabs that cannot work, split browser config from run
config on the wire, and stop letting two credential stores describe the same key.** On crawlagent,
the biggest win is not a phase — it is deleting three of its four crawl stacks and three of its five
Fly processes.

## 24. Applied 2026-10 — webrain-only mode, with no gap left open

This section records what was actually changed, because everything above is a plan and a plan that
is not marked applied gets re-litigated.

### 24.1 The gap that was closed

Two separate holes, in the same file, both reachable in production:

1. `selectableProviders` offered `crawl4ai` on the `crawl` route. Its job pipeline is disabled at
   the route table (`scrape-providers.domain.ts`, ADR §10), so choosing it produced a request with
   no handler.
2. `resolveProvider` returned a stored `crawl4ai` unconditionally: the route check passed, the
   entitlement check passed, and it fell through to `{ provider: stored, source: "user" }`. A
   preference stored *yesterday* kept routing to a pipeline removed *today*, with no signal.

### 24.2 What changed — `functions/src/domain/scrape-providers.domain.ts`

- `ScrapeProviderDescriptor` gained `retired: boolean`. A retired row stays in the catalogue
  because stored documents and historical records name it; deleting it would turn a real value into
  an unknown id. It is instead never offered and never resolvable.
- `crawl4ai` is `retired: true` and its notes now say retired, not "frozen".
- `webrain` moved from `minAccess: "paid"` to `"free"`. This is a product change, not a
  technicality: it is the only engine left on the route, so a paid gate would have left a free
  caller with an **empty** engine list while their traffic already went to webrain as the platform
  default.
- `FALLBACK_PROVIDER` is `webrain`. A retired fallback is a fallback that fails.
- `platformDefaultProvider` ignores a retired name in `SCRAPE_PROVIDER`. That value is set by hand,
  so a stale `SCRAPE_PROVIDER=crawl4ai` left over from before today would otherwise keep sending
  every defaulted request to the dead pipeline — the same class of silent misconfiguration the
  function's existing validation was written to stop.
- `resolveProvider` refuses a retired provider **before** the route and entitlement checks and
  reports `rejected.reason: "retired"`. The order matters: `entitlement` sends support to the
  pricing page, and upgrading would change nothing.

`setMyScrapeProvider` needed no edit — it validates against `selectableProviders`, so storing
`crawl4ai` is now refused by construction.

### 24.3 What changed — frontend (the freeze)

- `/crawlpack` redirects to `playground` (`routes/user/main.route.ts`). The editor writes
  `CrawlerRunConfig` / `BrowserConfig` fields that webrain accepts neither of, so it collected
  settings that were discarded at run time. Redirected rather than deleted so the URL keeps working.
- The `Crawl Pack` nav entry was removed (`_nav.ts`) rather than left pointing at a redirect.

### 24.4 Still open — the packs that already exist

Closing the editor does not close the *use* of a pack. Two surfaces remain and they are coupled, so
they are one change, not two:

- `core/services/crawlapi.service.ts` — `multiCrawlEnqueue` still spreads `...crawlPack.config.value`
  into the job body.
- `core/components/app-crawl/app-crawl.component.ts` — `loadPreviousPacks` still populates the
  playground's pack dropdown, and `app-crawl.component.html` still renders
  `crawlpack.config.value | json`.

Until those are removed together, a returning user picks a saved pack, sees its JSON on screen, and
a webrain crawl runs with none of it. That is the same silent-discard defect this section just
closed on the server, one layer up.

### 24.5 Effect on the phases above

- **P5** is partially applied: §24.2 is the server half, §24.3 the first frontend half.
- **P0 and P1 are unchanged and still valid.** Restoring `crawl4ai` means flipping `retired` back to
  `false` and nothing else — which is exactly why the flag exists as data.

