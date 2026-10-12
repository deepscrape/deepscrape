# ADR-2026-09 — Crawl provider abstraction and the webrain gateway

Status: **proposed** (no code beyond the correction in §0 is implemented)
Date: 2026-09-30 · Branch: `next` · Touches: deepscrape, arachnefly, webrain

Supersedes the "webrain absent" state recorded in
`Rust/webrain/docs/DEEPSCRAPE_FRONTEND_HANDOFF.md` §0.

---

## 0. Correction to a change already on this branch — read first

An earlier session on this branch changed **`functions/src/handlers/crawler.ts`**
to authenticate with the server-held `env.CRAWL4AI_API_KEY` instead of relaying
the caller's token. The justification was a note in `ai_handler.ts` claiming a
relayed user token is a 401 against the crawl worker.

Reading `github.com/deepscrape/crawlagent` shows that note was applied to the
wrong service. `crawlagent` is a **FastAPI job service** and every job route is
token-verified:

```py
@job_router.post("/crawl/stream/job", status_code=202)
async def crawl_stream_job_enqueue(request: Request, payload: CrawlRequest,
                                   decoded_token: Dict = Depends(verify_token)):
    uid = decoded_token.get("uid")          # job.py:549
    ...
    doc_ref = db.collection(f"users/{uid}/operations").document()
```

`crawler.ts` talks to exactly those routes (`/crawl/job/temp-task-id`,
`/crawl/job/{tempTaskId}`, `/crawl/stream/job/status/{taskId}`,
`/crawl/stream/job/{taskId}`, `/crawl/job/{tempTaskId}/cancel`,
`/crawl/stream/job`), so **the caller's Firebase ID token is the correct
credential** — a server secret would break the `users/{uid}/operations`
ownership path.

**Done:** `crawler.ts` relays the caller's token again, read per-request from
`req.authToken` (not the process-wide `req.app.locals` it used before — that
cross-tenant fix stays).

**Still open, and not guessed:** `ai_handler.crawl4aiCore` (`POST /crawl`) also
now sends `env.CRAWL4AI_API_KEY`. `crawlagent`'s `POST /crawl` is
`Depends(verify_token)` too, so the same argument applies — but the note claims a
live probe showed the opposite. Two contradictory evidences means this is a
**configuration decision with a test**, not a coin flip (§4), and it is the first
thing to settle:

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API_CRAWL4AI_URL/crawl" \
  -H "Authorization: Bearer <a real Firebase ID token>" \
  -H 'Content-Type: application/json' -d '{"urls":"https://example.com","priority":10}'
```

200 → relay the caller token; 401 → the server secret is right; connection
refused → `API_CRAWL4AI_URL` points at nothing (see §3, likely).

---

## 1. The problem stated as flows

Today there are **five** places that decide where a scrape goes, which is why the
same request can be billed twice and why a Fly hostname can appear as a default:

| Caller | Decides the target in | Target |
|---|---|---|
| `CrawlAPIService.sendToCrawl4AI` (browser) | `variables/aiservice.var.ts` | `/api` → BFF |
| `crawl4aiCore` (BFF) | `functions/src/config/env.ts` | `API_CRAWL4AI_URL` |
| `CrawlerHandler` (BFF, job pipeline) | `config/upstreams.ts` | `crawlAgentBaseUrl()` |
| `jinaAICrawl` (BFF) | hard-coded `r.jina.ai` | JinaAI |
| `deployment.service.ts` (browser) | `variables/deployment.var.ts` | `/api/machines` → arachnefly |

The BFF is therefore an **egress fan-out**: one user action can produce a direct
call to a Cloud Run container *and* a call to a Fly container, with different
pricing, for the same work. Your constraint is exactly right — this must collapse
to **one egress, one price, one place that knows the plan**.

---

## 2. Target architecture

```
                     HTTPS + Firebase ID token (same origin)
Angular ────────────────────────────────────────► deepscrape BFF  (Cloud Run)
   │  /api/crawl, /api/operations, /api/chat
   │
   │   ONE egress. The BFF names a PROVIDER, never a host.
   ▼
                                            SCRAPE_GATEWAY_URL
                                   ┌──────────────────────────────┐
                                   │ arachnefly (Go, Fly.io)      │
                                   │ auth · entitlement · quota   │
                                   │ tenant → worker routing      │
                                   └───────┬───────────┬──────────┘
                                           │ 6PN       │ 6PN
                        ┌──────────────────┴──┐   ┌────┴───────────────────┐
                        ▼                     ▼   ▼                        ▼
                 free pool (shared)      leased instance            jina / crawl4ai
                 WEBRAIN_NO_STATE=1      vault+profiles ON          (existing providers,
                 stateless tenants       sticky routing             their own keys)
```

Rules this architecture makes non-negotiable:

1. **The BFF never holds a provider hostname in a `catch`-adjacent ternary.** One
   env var, `SCRAPE_GATEWAY_URL`; in dev it is `http://127.0.0.1:8080`
   (arachnefly) or `http://127.0.0.1:9223` (webrain direct, for local probing).
2. **webrain never has public ingress.** Auth lives in arachnefly. `WEBRAIN_HTTP_TOKEN`
   is defence in depth only — the plan is explicit that one secret in front of a
   shared, stateful process is not a tenancy boundary (§6 of the platform plan).
3. **The unit of tenancy is the container, not the MCP session.** webrain's vault
   and profiles are process-global; that is why free tenants get
   `WEBRAIN_NO_STATE=1` and paid tenants get their own container.
4. **A paying customer's container is addressed by its own URL** through
   arachnefly — this is the `/api/machine/proxy/:id` surface that is deployed but
   unwired (see `docs/RESIDUAL-RISK-CRAWL-TRUST-BOUNDARY.md` §11).
5. **`crawl4ai`, `jina` and `webrain` stay separate providers with separate
   credentials.** Only the request *pattern* is shared.

---

## 3. What the providers actually are (verified, not assumed)

| Provider | Nature | Auth | Job model | Verified from |
|---|---|---|---|---|
| **crawl4ai / crawlagent** | Python FastAPI + Celery + Redis + Playwright, Fly.io app `crawlagent` (`fly.toml: app = 'crawlagent'`) | Firebase ID token, `Depends(verify_token)`; derives `uid` | **Async jobs**: temp-task-id → Celery task-id → Redis stream + SSE | `crawlagent/job.py` (`/crawl/job/*`, `/crawl/stream/job/*`), `schemas.py` (`CrawlJobType = PLAYGROUND \| OPERATION`) |
| **JinaAI** | Hosted reader, `r.jina.ai` | Our `JINA‌AI_API_KEY`, header-based (no user token) | **Synchronous**, one URL | `functions/src/handlers/ai_handler.ts::jinaAICrawl` |
| **webrain** | Rust MCP server, 17 intent tools, zero-LLM extraction | `WEBRAIN_HTTP_TOKEN` (server secret); auth in front = arachnefly | **MCP tool calls**; `webrain_batch` with `concurrency` | `Rust/webrain/docs/PLATFORM_EXPOSURE_PLAN.md` §1-4, §7 |

**The sharpest finding for planning:** `crawlagent` already models the two
consumers as a type — `CrawlJobType.PLAYGROUND` / `CrawlJobType.OPERATION`. That
means the *product* concepts already exist; the integration is a re-plumbing, not
a redesign. deepscrape's `CrawlOperation` type in `src/app/core/types/` is the
client half of the same model.

**Open question that decides Phase 1's size:** whether `API_CRAWL4AI_URL` in
production still points at `crawlagent.fly.dev` (the env default) or at a webrain
worker. Until that curl in §0 returns, treat the crawl path as "crawlagent,
possibly mis-pointed".

---

## 4. The provider abstraction (deepscrape side)

One interface, three adapters, one registry. This is what makes "the user wires
integrations based on their paying plan" possible without touching call sites.

```
src/app/core/providers/
  crawl-provider.ts            # interface + ScrapeProviderId union + registry
  crawl4ai.provider.ts         # CrawlerHandler job API (temp-task-id → SSE)
  jina.provider.ts             # synchronous, one-shot
  webrain.provider.ts          # MCP tools via the gateway
```

Interface shape (sketch — the union is the contract, not the HTTP shape):

- `enqueue(targets, config): Observable<ScrapeTask>` — `crawl4ai` and `webrain`
  are async; `jina` resolves immediately.
- `stream(taskId): Observable<ScrapeChunk>` — SSE for `crawl4ai`; MCP
  notification/stream for `webrain`; a single emission for `jina`.
- `cancel(taskId)`.
- `capabilities(): { stateful, profiles, batch, challenge, extraction }` — the UI
  renders from this, so a provider that cannot do profile login does not offer it.
- `authStrategy: 'caller-token' | 'server-secret'` — **this is the §0 fix made
  structural.** The gateway adapter knows which; no handler guesses.

Server-side, the same split in `functions/src/config/upstreams.ts`: replace the
two base-URL resolvers with a provider record that carries
`{ baseUrl, auth, jobModel }`, selected by a stored per-org/per-plan setting
(not a compile-time constant). The BFF picks the provider from the request's
entitlement; the client never names a host.

**Acceptance for Phase 1:** `grep -r "fly\.dev" functions/ bff/ src/` returns
zero hits outside docs, and a request for a scrape produces exactly **one**
upstream connection.

---

## 5. Workstreams per project

### deepscrape (write)

| # | Item | Why |
|---|---|---|
| D1 | Provider interface + registry + three adapters (§4) | the whole point |
| D2 | `CrawlResult` gains `challenge: 'cloudflare_challenge' \| 'blocked' \| 'captcha' \| null`; UI state with a real next action (retry with a session / attach a profile) | the product win; webrain returns it on every navigation. **Still not started** |
| D3 | BFF: one scrape route that takes `provider?` and delegates; deletes the fan-out | §1 |
| D4 | Wire `/api/machine/proxy/:id` into `deployment.service.ts` + both route tables | custom-deployment URL is deployed but unreachable |
| D5 | Chat AI: MCP client so `/chat` can call tools, with per-plan `@plugins` / `@skills` | your ask; webrain is the first tool |
| D6 | Operations + Playground: bind to the provider registry; keep `CrawlOperation` as the domain type | playground/operations were crawlagent's two `CrawlJobType`s |

### arachnefly (write, needs your go-ahead — I have been read-only there)

| # | Item | Why |
|---|---|---|
| A1 | Webrain worker routes: create/route/lease, behind the existing `FireAuthMiddleware` | the platform plan's P0 |
| A2 | Entitlement gate + per-tier quota, reusing the existing `machines.*` action/credit model | quota already exists as a pattern `{action, credits}` |
| A3 | MCP session → worker routing with sticky affinity for paid tenants | a leased container must receive its own sessions |
| A4 | Health/readiness + graceful drain wired into `fly.toml`/autoscaler | needs webrain's `/health` |

### webrain (read-only — **escalate, do not fork**)

Already shipped per the platform plan §4: `WEBRAIN_NO_STATE`, `WEBRAIN_HTTP_TOKEN`,
`/health`, graceful shutdown, per-session concurrency cap. **No changes proposed.**
The one thing to confirm is that `challenge` is on the response for every
navigation (handoff §2 cites `docs/concepts/challenges.mdx`).

### Retired

`crawlagent` is **not** retired — it becomes the `crawl4ai` provider. Nothing in
this plan deletes it. Its `CrawlJobType` enum stays the naming source for
playground/operation.

---

## 6. Phasing (each phase independently shippable)

| Phase | Deliverable | Gate |
|---|---|---|
| **0** | §0 curl settles `POST /crawl`'s credential; `API_CRAWL4AI_URL`'s real value confirmed | one command, needs a live service |
| **1** | D1 + D3 + §4 acceptance. Behaviour identical for the existing crawl4ai path | `bun test` + `tsc` + prod build green |
| **2** | D2 (`challenge`) with a test proving blocked ≠ empty | new spec, both states asserted |
| **3** | A1-A4 then D5's webrain adapter behind a flag; free tier = `NO_STATE=1` shared pool | a free-tier scrape returns typed JSON; `webrain_profiles` is refused |
| **4** | D4 (custom-deployment URL) + A2 quota surfaces in the UI | a paid container reachable by its own URL |
| **5** | D6 playground/operations rebind; D5 `@plugins`/`@skills` per plan | — |

Phase 2 is deliberately before Phase 3: the `challenge` state is provider-agnostic
and is the change users notice, so it must not wait on the gateway.

---

## 7. Delegation

Three research agents, one per project, run in parallel — each returns facts with
file:line citations, writes no code:

- **arachnefly** — does its domain layer already model tenancy/entitlement/quota
  (`billing-pricing.domain.ts` pattern `{method, pattern, policy:{action, credits}}`)?
  What is the minimum route set for A1-A3? Where is the machine→tenant mapping?
- **webrain** — exact MCP tool surface and which tools are stateful (`no_state`
  targets); the `challenge` field's response shape and `docs/concepts/challenges.mdx`;
  `validate_urls` / `webrain_batch` parameter shapes; whether `/health` reports
  `no_state`.
- **deepscrape** — inventory of every crawl/operations/chat call site and which
  are dead after D3; the chat page's current AI plumbing and what an MCP client
  needs; `CrawlPack`/`CrawlConfig`/`BrowserProfiles` field shapes to bind to
  webrain's `vault`/`profiles`.

Their reports feed Phase 1's interface freeze; no phase-1 code is written before
they land.

---

## 8. Anti-patterns (unchanged from the platform plan, restated as acceptance)

- Do not add per-site handling to webrain or to a shared crawl path.
- Do not return raw HTML to the client; typed JSON only.
- Do not copy the `BLOCKED_HOST` regex into a second place.
- Do not treat a browser as disposable — profile/session/challenge are runtime state.
- Do not put a provider hostname in a default, a fallback, or a ternary.
- Do not claim a fix without a runnable check.
- Do not deploy anything from this plan without an explicit instruction.

---

## 9. Delegated research — results, and four corrections that change the plan

Three read-only agents audited the three repos (`codebase-memory` graph first,
file:line citations throughout). Their findings supersede parts of §2-§6 above and
of the webrain platform plan. **Read this section before starting Phase 3.**

### 9a. BLOCKER — the free tier is not actually tenant-safe as designed

`docs/PLATFORM_EXPOSURE_PLAN.md` §4a claims one guard closes the leak, and §7
claims it was empirically proven. The audit found the guard covers exactly three
executor names:

```rust
const STATEFUL_TOOLS: &[&str] = &["webrain_profiles", "webrain_launch", "webrain_login"];
// webrain-mcp/src/lib.rs:72 ; checked at lib.rs:147-153, after map_surface()
```

**Reachable with `WEBRAIN_NO_STATE=1` and NOT in that list:**

| Tool | Why it matters | Cite |
|---|---|---|
| `webrain_save_state` / `webrain_restore_state` | read/write `profiles/<service>/<profile>/state.json` with **caller-chosen** keys — the same process-global store the plan set out to protect | `lib.rs:766-830` |
| `webrain_session(op=cookies\|setcookies)` | cookie access on the shared store | `tools.rs:1080`, `tools.rs:1084` |
| `webrain_session(op=open, cdp_url=…)` | accepts an **arbitrary CDP URL** | `lib.rs:1291-1296` |
| any session tool with a guessed `session_id` | `map.entry(route_key).or_insert_with(...)` — **no ownership check**; `webrain_list_sessions` enumerates every session and its `cdp_url` | `lib.rs:1263-1275`, `lib.rs:1317-1330` |

**Consequence for the architecture:** the gateway-side allowlist is **load-bearing,
not defence in depth**. Phase 3 must ship an explicit tool allowlist enforced in
arachnefly, and the free pool must be a *separate container* from any paid tenant's,
because a shared process's profile store is reachable through tools the flag does
not cover. Do not start Phase 3 on the plan's current claim.

Two smaller doc/source mismatches to carry: the plan's quoted error string
(`"stateful ops disabled on a shared instance"`) does not exist in the code — the
real text is `<tool> is disabled on this instance: WEBRAIN_NO_STATE is set`
(`lib.rs:151`); and `WEBRAIN_HTTP_TOKEN`'s constant-time comparison returns early
on a length mismatch (`lib.rs:82-85`), so it leaks the expected token's length.

### 9b. CORRECTION — `challenge` is not on batch, so D2 shrinks and Phase 3 changes

§4 of this ADR and the handoff both assumed `challenge` arrives on every
navigation *and* in batch. The field is real but narrow:

```
webrain-core/src/browser.rs:23   pub challenge: Option<String>,
```
Produced by `detect_antibot` (`browser.rs:38-79`) from **title + visible text
only**; exactly three values are ever produced — `cloudflare_challenge`,
`blocked`, `captcha`. Emitted by exactly three tools: **`webrain_navigate`**
(`tools.rs:948`), **`webrain_observe(what=state)`** (`tools.rs:1244`),
**`webrain_search`** (`tools.rs:1926`).

**Not emitted by `webrain_batch`** (`BatchResult` has no such field —
`engines.rs:1746-1763`; `batch_fetch` returns `(title, text, None)` —
`engines.rs:1921-1935`). So a batched URL that lands on a challenge is reported as
a plain success row with no error and no signal. **Planning consequence:** the
"blocked ≠ empty" UI state (§6 D2) works for single-URL navigate flows only; for
batch/operations the discriminator must be derived from `crippled`
(`challenge.is_none() && element_count < 5`, `browser.rs:134-136`) or added
upstream. Since detection is text-only, a challenge whose markers live in
HTML/scripts is missed entirely — the code concedes this (`browser.rs:36-37`).
Use the exact three strings as the TypeScript union; there is no Rust enum to copy.

**Good news that shortens D2:** deepscrape already has the concept on the client —
`CrawlChallenge` / `CrawlOutcome` / `crawlOutcome()` at
`src/app/core/functions/crawl.fun.ts:145-206`, with spec coverage at
`crawl.fun.spec.ts:7`. What is missing is not the logic but the **field on a domain
type** (see 9d) and the UI state. D2 is a plumbing job, not a new concept.

### 9c. CORRECTION — `validate_urls` is not redirect-safe, and webrain has no SSRF policy

The handoff's S3 row lists `validate_urls` as the redirect-safe target validator.
It is not:

- No private-address/link-local/metadata blocklist exists anywhere in
  `webrain-core/src`, `webrain-mcp/src`, `webrain-cli/src` — a recursive grep for
  `is_private|169\.254|192\.168|link_local|ssrf|BLOCKED_HOST` returns only
  `127.0.0.1` constants for local CDP ports and test fixtures. It will probe
  `http://169.254.169.254/…` if handed it.
- No redirect policy is set anywhere; redirect following is the `ureq` dependency's
  default, not a webrain decision.
- The result row is `{"url", "alive"}` only (`tools.rs:1553`; row built at
  `engines.rs:2580`) — **no status code, no final URL**. A 302 to an internal host
  is reported as `alive: true`, and a transient error is indistinguishable from a
  404.

**Consequence:** the SSRF-after-redirect hole documented in
`RESIDUAL-RISK-CRAWL-TRUST-BOUNDARY.md` §6 is **not** closed by adopting webrain.
It is closed by an egress policy or by no-follow + per-hop revalidation in the
worker. Assume it is open until that ships.

### 9d. deepscrape inventory — the dead-code list, and one type that is declared three times

Confirmed **no production caller** (evidence in the audit; a spec reference does
not count):

| Symbol | Definition |
|---|---|
| `CrawlStreamService` — **the whole class** | `src/app/core/services/crawl-stream.service.ts:10` |
| `CrawlerHandler` + its `crawlagent` instance — **all 6 methods, entirely unreachable** | `functions/src/handlers/crawler.ts:14`, `:453` — no importer; every `crawlagent.*` call site in `syncaiapi.ts` (`:906,909,912,915,941,979`) and `events.ts:129` is commented out |
| `CrawlAPIService.getTaskId` | `src/app/core/services/crawlapi.service.ts:87` |
| `AiAPIService.sendToJinaAI` | `src/app/core/services/aiapi.service.ts:52` |
| `SeedingService.cancelTask` | `src/app/core/services/seeding.service.ts:20` |
| `DeploymentService.getMachine` | `src/app/core/services/deployment.service.ts:53` |
| `enqueueCrawlOperation` | `functions/src/app/auth.ts:892` — export commented out at `functions/src/index.ts:124` |

**This reshapes §5 workstreams:** D1 (the provider registry) is partly a
*deletion* job — `CrawlStreamService` and `CrawlerHandler` are two of the four
implementations of "call a crawl backend" and neither is used. Delete before
abstracting; there is no point writing adapters for dead call sites.

**`CrawlResult` is declared three times** — `crawl.interface.ts:364` (the one the
barrel resolves), `crawl-result.type.ts:1` (reached only by direct path from
`app-crawl.component.ts:28`), and `crawl-result.interface.ts:1` exported as
`CrawlResults`. `crawl-result.type.ts` is not exported from `types/index.ts`. This
is exactly where `challenge` must be added, so **collapse the three to one first**
or the field lands in the wrong copy. Also duplicated: `CartPack`
(`crawl.interface.ts:518`) mirrors `CrawlPackConfigs` (`:513`).

Two live client bugs the audit turned up, both in the crawl path:

- `AiAPIService.sendToJinaAI` sends `Authorization: Bearer 'JINAAI_API_KEY'` —
  **the literal string, not the value** (`aiapi.service.ts:59`). Dead code today;
  a trap the moment JinaAI is wired as a provider.
- `CrawlStreamService.streamCrawlResults` builds an `Authorization` header
  (`:28-32`) for a **native `EventSource`, which cannot send headers** — the
  credential is silently never transmitted. Dead code today, and the reason not to
  revive this class for the webrain SSE path.
- `WebSocketService` puts the Firebase ID token **in the query string**
  (`?token=`, `websocket.service.ts:44`, `:75`) → it lands in access/proxy logs.
  It is live for `/operations` (`operations.component.ts:381`). Treat as a leak to
  fix independently of this plan.

### 9e. arachnefly is not the gateway the plan assumes — two P0 findings

The platform plan assigns arachnefly "auth · paywall · quota". The audit found:

1. **No entitlement, plan, quota, credit or per-user rate limit exists.** `domain/`
   holds only `machines`, `machines_history`, `deploy_metrics` collections
   (`domain/firestore.go:8-10`) and ten Firestore methods, none of which reads a
   plan (`:19-31`). The only limiter is global and IP-keyed — 20 requests / 20 s
   keyed on `x-forwarded-for` (`interfaces/handlers/crucial.go:15-18`). A per-user
   limiter line is commented out (`interfaces/controller/router.go:44`) and its
   config does not exist. **So "arachnefly owns quota" is a build, not a wire-up**,
   and it moves A2 from "reuse the existing model" to "there is no model".
2. **No machine-ownership check anywhere.** The uid is used only as a Firestore
   path prefix; no handler compares the path `:id` against the authenticated uid,
   and all Fly calls use one app-wide `FLY_API_TOKEN`. So `GET /api/machine/:id`,
   `PUT|DELETE /api/machine/:id`, `POST /api/execute-task/:machine_id` and
   `GET /api/machine/proxy/:id` are authorised by "holds any valid Firebase token"
   — **any authenticated user can control any machine.** Separately,
   `GET /api/user/:id` reads the uid **from the path** (`fireAuth.go:123`) and
   returns the raw `users/{id}` document; the route's own comment calls it
   test-only (`router.go:85`).

   This is a pre-existing production vulnerability, independent of webrain. It is
   the reason A2 ("entitlement gate") must be preceded by an **ownership** fix:
   entitlement is meaningless while the id in the path is unbound.

Three more corrections to §5's arachnefly row:

- The proxy (`HandleContainerProxyFiber`, `fireAuth.go:961-1104`) is **broken, not
  merely unwired**: it forwards to `http://<machine>.vm.<app>.internal:<11235>`
  with **no authentication**, deletes `Authorization`, injects the *literal string*
  `"userID"` as `X-Authenticated-User-Id` (`:1043`), is **GET-only**, is buffered
  (no `StreamBody`), and its result is **overwritten** by the `MakeAPICallback`
  wrapper's `c.JSON` (`http_callback.go:36`) so the container's payload never
  reaches the client. D4 is a repair, not a wire-up — and an MCP (POST) worker
  cannot use it as-is.
- There is **no `/health`**; `app.Use(healthcheck.New())` (`router.go:63`) serves
  Fiber's defaults **`/livez` and `/readyz`**. The new worker's Fly health check
  must target `/health` on webrain, and arachnefly's own check must target
  `/livez`. The existing per-machine check hardcodes `path: "/"` and the port from
  `env PORT` (`infrastructure/routines/global.go:263-271`).
- The autoscaler scales on **request latency**, not queue depth:
  `FAS_PROMETHEUS_METRIC_NAME = "avg_duration"` in `fly-autoscaler.toml`. The
  repo's `SCALER.md` discusses `queue_depth`, which is used nowhere; there is **no
  job queue in arachnefly** and `robfig/cron` only drives the state reconciler.

`/api/execute-task/:machine_id` also hands the request to
`https://<app>.fly.dev/crawl` with `fly-replay: instance=<id>` while attaching
`Authorization: Bearer <FLY_API_TOKEN>` to that public-URL call
(`fireAuth.go:930-937`; `global.go:105`) — a hardcoded crawl4ai path and the app's
Fly credential on an app-public endpoint.

### 9f. What this does to the phases

| Phase | Change |
|---|---|
| 0 | Unchanged, still first: the `POST /crawl` credential curl. |
| 1 | **Absorb the deletions** (9d) into D1. Collapse the three `CrawlResult` declarations before adding `challenge`. Behaviour stays identical. |
| 2 | Unchanged in goal; scope is smaller (the `crawlOutcome` logic exists). Note the batch limitation from 9b. |
| 3 | **Blocked on 9a and an arachnefly ownership fix (9e).** Add: gateway-side tool allowlist, and a *separate* container per free pool vs paid tenant. Do not share a process. |
| 4 | D4 is a repair of a broken handler, not a wire-up; add the ownership check first. |
| 5 | Unchanged. |

### 9g. Still not determined

- Whether `API_CRAWL4AI_URL` in production resolves to `crawlagent` or a webrain
  worker (§0's curl settles it).
- How arachnefly is deployed — there is no CI in the repository (`.github/workflows/`
  is empty; the `Makefile` holds only three secret-setting targets).
- The `ureq` 3 default redirect limit.
- The platform plan's empirical probe results were **not** re-run by the audit
  (read-only scope), so treat §7 of that plan as documented-but-unreproduced.

---

## 10. P0 PRODUCT FINDING — the crawl job pipeline is disabled on BOTH hosts

Found while verifying the dead-code list. This is not a plan item; it is a
statement about what the product does today, and it outranks most of §5.

**The routes the Playground and Operations depend on are not served anywhere.**
Both route tables were read side by side. They agree, so this is not a cutover
divergence — the pipeline was deliberately commented out:

```
functions/src/infrastructure/syncaiapi.ts
:906  // this.router.get("/crawl/job/temp-task-id",            crawlagent.getTempTaskId)
:909  // this.router.get("/crawl/job/:tempTaskId",             crawlagent.getTaskId)
:912  // this.router.get("/crawl/stream/job/status/:taskId",   crawlagent.getTaskStatus)
:915  // this.router.get("/crawl/stream/job/:taskId",          crawlagent.streamTaskResults)
:941  // this.router.post("/crawl/stream/job",                crawlagent.multiCrawlEnqueue)
:979  // this.router.put("/crawl/job/:tempTaskId/cancel",      crawlagent.cancelTask)
```

`bff/api.ts` registers the platform's routes, and none of them is a crawl job
route. The crawl/Jina/AI routes are:

```
POST /api/crawl                    → crawl4aiCore
GET  /api/jina/:url                → jinaAICrawl
POST /api/anthropic/messages       → anthropicAICore
POST /api/{openai,groq,deepseek,fireworks,qwen,kimi,openrouter,gemini}
     /chat/completions             → chatCompletionsCore(<vendor>)
POST /api/custom/chat/completions  → customChatCompletionsCore
GET  /api/models/:vendor           → modelsCore
```

*(Inventory refreshed 2026-10-12. `openaiAICore` and `groqAICore` were two
ninety-line copies of one streaming body; they are now the single
`chatCompletionsCore` factory keyed by a wire table. The count that used to sit
in the sentence above is gone rather than updated — it drifted every time a
route was added, and the route list is the fact worth keeping.)*

So these **live, routed** client calls currently reach nothing:

| Client call | Target | Reachable? |
|---|---|---|
| `CrawlAPIService.multiCrawlEnqueue` (`/playground?mode=crawl`) | `POST /api/crawl/stream/job` | no |
| `CrawlAPIService.getTaskStatus` (`OperationStatusService`, operations) | `GET /api/job/stream/status/:id` | no |
| `CrawlAPIService.streamTaskResults` (`app-crawl`, `SeedingService`) | `GET /api/job/stream/:id` | no |
| `CrawlAPIService.cancelTask` (`domain-seeder`) | `PUT /api/job/:id/cancel` | no |
| `SeedingService.multiSeedEnqueue` (`/playground?mode=seeder`) | `POST /api/seeder/stream/job/multi-research` | no |
| `WebSocketService.connectAndTrackTasks` (`/operations`) | `wss://agent.deepscrape.dev/api/v1/ws/task/status` | separate host, token in query string |

**Consequence.** `/playground?mode=crawl`, `/playground?mode=seeder` and the
`/operations` task tracker are non-functional against the current architecture. A
POST to an unrouted `/api` path does not return JSON — the page-serving catch-all
handles it (pinned by `bff/public.spec.ts`).

**Why this changes the plan, not just the backlog.** §6 Phase 3 assumed we would
*add* a webrain adapter beside a working crawl4ai path. There is no working crawl
job path to sit beside: the async job model (`temp_task_id` → Celery `task_id` →
SSE stream) was crawlagent's, and it is the part that was switched off. So the
provider abstraction is not an optimisation of a working flow — it is **how the
flow comes back**. Phase 1's `enqueue`/`stream`/`cancel` interface is the repair,
and the two remaining routes to build against are the ones that do work
(`POST /api/crawl`, `GET /api/jina/:url`).

**Do not "just re-enable" the six lines.** They route to `CrawlerHandler`, whose
credential behaviour was changed and reverted twice this session (§0) precisely
because the target's auth contract is unresolved. Re-enabling them against an
unverified target is how the 401s start. Fix the target first (§0's curl), then
decide whether `crawler.ts` is revived as the `crawl4ai` adapter or deleted.

### What was deleted instead, and what was deliberately kept

Removed this session (independently verified as having no production caller
before removal):

- `src/app/core/services/crawl-stream.service.ts` — whole class, dead, and
  structurally incapable of working: it builds an `Authorization` header for a
  native `EventSource`, which cannot send headers, so the credential was silently
  never transmitted.
- `src/app/core/services/crawl-stream.service.spec.ts`.
- The `./crawl-stream.service` barrel export in `src/app/core/services/index.ts`.
- `CrawlAPIService.getTaskId` — no caller anywhere, not even the disabled
  pipeline, and its only reference was its own spec case (also removed).

Fixed, not deleted:

- `AiAPIService.sendToJinaAI` sent `Authorization: Bearer 'JINAAI_API_KEY'` — the
  literal quoted string, from the browser. Since `/api/jina/:url` sits behind
  `isJwtAuth`, **every Jina call was a 401**. It now sends the caller's token, and
  the comment records that the provider key is held server-side by `jinaAICrawl`.

**Deliberately kept: `functions/src/handlers/crawler.ts`.** It has no importer, so
it is dead by the audit's standard — but it is the only implementation of the
crawlagent job protocol (`temp-task-id` → `task_id` → SSE → cancel), and that
protocol is exactly what the `crawl4ai` adapter must speak. Deleting it now and
re-deriving it in Phase 1 is churn. **Decision needed:** revive it as the
`crawl4ai` adapter (after §0's curl), or delete it and rebuild from the
`crawlagent` source. Until that is answered it stays, marked as unreachable.

### Verified after these changes

```
bunx tsc --noEmit -p tsconfig.app.json      exit 0
bunx tsc --noEmit -p tsconfig.spec.json     exit 0
bunx ng build --configuration=development   exit 0, 14 routes prerendered, 0 errors
residual references to crawl-stream        0
```

---

## 11. Webrain verified against a RUNNING worker (not read — called)

Everything in §9b/§9c about webrain was derived from source by an agent that could
not run it. It has now been run. Recipe and evidence:

```
$env:WEBRAIN_HTTP_TOKEN='local-dev-probe-secret'; $env:WEBRAIN_NO_STATE='1'
webrain.exe mcp --http 9333
  -> INFO webrain: Starting webrain MCP server over HTTP on 127.0.0.1:9333...
  -> INFO webrain_mcp: webrain-mcp HTTP listening on 127.0.0.1:9333
```

Two harnesses were added to this repo, both re-runnable:

| Harness | Checks | Purpose |
|---|---|---|
| `scripts/probe-webrain-mcp.ps1` | **11 pass / 0 fail** | transport guards + stateless work + the three stateful refusals + the known gap |
| `functions/scripts/webrain-smoke.ts` | **6 pass / 0 fail** | the deepscrape client (`infrastructure/webrain-mcp.ts`) against the live worker, plus the shared URL guard |

### Confirmed

- `GET /health` → **200 `{"status":"ok"}`**, unauthenticated. Matches source.
- `tools/list` with no `Authorization` → **401**; with `Bearer <token>` → **200**.
- The surface is **exactly 17 tools**, and the names are the ones in §9b:
  `webrain_guide, webrain_eval, webrain_eval_in_frame, webrain_navigate,
  webrain_observe, webrain_interact, webrain_extract, webrain_scrape,
  webrain_batch, webrain_crawl, webrain_search, webrain_serp, webrain_pdf,
  webrain_download, webrain_watch, webrain_session, webrain_vision`.
- **No `initialize` handshake is needed** — `tools/list` and `tools/call` are
  dispatched directly. The client does not send one.
- **The transport answers `content-type: application/json`** when `Accept` permits
  JSON; SSE is only one of the shapes. So the client reads the body as text, tries
  the last `data:` line (SSE) and otherwise parses the body directly. Handling only
  SSE would have been a guess that happened to work.
- `webrain_scrape` on `https://example.com` **succeeds with no browser and no CDP**
  — so the stateless half of the free tier needs no browser at all.
- `webrain_profiles`, `webrain_launch`, `webrain_login` are **refused**, and the
  refusal text contains the literal flag name `WEBRAIN_NO_STATE`. Asserting on that
  rather than on the plan's prose (which is not in the code) is what makes the
  check meaningful.

### Corrected by observation — the token stamp is not what the source reading implied

```json
{ "content": [...], "isError": false, "ms": 19, "tokens": { "chars": 884, "est_tokens": 234 } }
```

`tokens` is an **object**, not a number, and the field is `est_tokens` — an
*estimate*. §9's summary that every response pays a tiktoken `cl100k_base` encode
is therefore not what the wire shows: it is a char/estimate pair. Per-tenant
accounting should treat it as a billing proxy, and any figure the platform
reconciles against must not be presented as exact. The client types it as
`{chars?, est_tokens?}` and the smoke test asserts on `est_tokens`.

### §9a CONFIRMED EMPIRICALLY — and it is worse than "a gap in a list"

With `WEBRAIN_NO_STATE=1` set, a shared worker **serves**
`webrain_session(op=list)`:

```
GAP OPEN    webrain_session(op=list) is served on a shared instance
            => gateway allowlist is load-bearing (ADR 9a)
```

So the shared free-tier container, as webrain ships today, does not refuse the
session surface — only three names are refused. This is no longer a reading of
`STATEFUL_TOOLS`; it is an observed response from a running process. **A gateway
allowlist is required, not optional**, and the free pool must stay a separate
container from any paid tenant's.

### New code in this repo

| File | What it is |
|---|---|
| `functions/src/domain/url-guard.domain.ts` | the ONE target-URL guard. `ai_handler.ts` now calls `safeTargetUrls()` instead of carrying the regex inline, so the webrain path cannot grow a second, drifting copy — the plan's Phase 1 acceptance item. |
| `functions/src/infrastructure/webrain-mcp.ts` | MCP-over-HTTP client: `webrainTool(name, args)`, `webrainHealth()`. Never throws — a worker outage surfaces as a typed failure (`transportError` / `noStateRefused`) so the UI can explain it instead of the request hanging to its timeout. |
| `config/env.ts` + `env.d.ts` | `WEBRAIN_MCP_URL` (**no default host, deliberately** — a new provider must not inherit "some host is assumed") and `WEBRAIN_MCP_TOKEN` (sent only when set). |

Still to come for the Angular wiring: the provider registry (§4), the BFF route on
**both** hosts, and the `challenge`-driven UI additions. The `challenge` field and
its state now exist end-to-end on the client (component + i18n + spec); batch and
operations still cannot see a gate (see §9b).



