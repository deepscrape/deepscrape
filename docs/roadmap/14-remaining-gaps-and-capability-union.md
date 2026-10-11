# 14 — Remaining gaps across all four projects, and the capability union

Measured 2026-10-10, after the websocket repoint and the i18n claim fix. Every row is a command
result, not a plan. `obscura.md` is read as reference only; where it conflicts with
`06-browser-sourcing-options.md`, **`06` wins**.

Reproduce:

```
bunx tsx scripts/route-parity.ts
rg -o '\.(Get|Post|Put|Delete|Patch)\("[^"]*"' <arachnefly>          # Go/Fiber, router.go
rg -o '@(app|router)\.(get|post|put|delete|patch)\("[^"]*"' <crawlagent>
rg -o 'webrain_[a-z0-9_]{2,}' <webrain>                              # MCP tool registry
rg -o "'/api/[a-z0-9/:_-]+'" deepscrape/bff/api.ts
```

---

## 1. The headline: there is no unserved frontend feature

`route-parity`: **62 BFF routes · 19 client bases · 0 client calls with no route** (re-measured
2026-10-11; this line read 57/18 when first written, and the frame route was added since).

So the question "which frontend features have no backend?" answers **none**. The real hole is the
inverse, and it is large: **the services expose far more than the frontend reaches.**

Its "8 routes with no client" list is a **partial false positive**. `websocket.service.ts` consumes
`/api/job/stream/status/:taskId`, which the tool cannot see because the URL is built by
concatenation — the same reason `/api/search`, `/api/extract` and `/api/pdf` are listed despite the
playground using them. Treat those as unverified; the stream route is proof the detector misses
dynamically-built URLs.

---

## 2. Capability union — what each service offers vs what the frontend can reach

| Service | Transport | Route/tool count | Reached by frontend | Verdict |
|---|---|---|---|---|
| **arachnefly** (Go/Fiber) | REST | **14 routes** | ~10 via `/api/machines*`, `/api/admin/*`, `/api/browser/session*`, `/api/monitor/*` | mostly wired |
| **webrain** (Rust) | **MCP/JSON-RPC only — zero REST routes** | **~43 tools** | ~8 via `/api/{scrape,serp,search,extract,pdf,crawl}` | **~35 tools unreachable** |
| **crawlagent** (Python/FastAPI) | REST + SSE + WS | **17 routes** | **0 — the frontend no longer dials it** | legacy; capability orphaned |
| **BFF** (Bun/Elysia) | REST + SSE | 57 | is the frontend's only surface | the contract |

### 2.1 webrain — the largest single gap

`rg '\.route\("' webrain/**/*.rs` returns **nothing**. webrain is not an HTTP service; it is an MCP
tool registry. Its tools, from `webrain-mcp/src/lib.rs`:

```
a11y  batch  click  close_launch  close_session  console  core  dismiss_overlays
download  eval  extract_json  extract_regex  fetch_http  get_html  get_images  guide
interact  launch  list_sessions  login  media  nav  navigate  observe  open_session
pdf  pdf_extract  pdf_images  pdf_render  pixel  press  profiles  restore_state
save_state  scrape  screenshot  search  semantic_tree  serp  session  snapshot  spider  tab
```

The BFF exposes seven families. That reaches roughly `scrape`, `serp`, `search`, `extract_json`,
`extract_regex`, `pdf*` and `spider`/`crawl`. **Unreached groups, all already built and paid for:**

| Group | Tools | What a surface would unlock |
|---|---|---|
| Session control | `open_session`, `close_session`, `list_sessions`, `session`, `tab`, `launch` | a real browser-session UI driven by webrain rather than arachnefly |
| Interaction | `interact`, `click`, `press`, `eval`, `console`, `observe`, `snapshot`, `semantic_tree`, `a11y`, `dismiss_overlays` | agentic step-through in the playground |
| Vision | `vision`, `pixel`, `screenshot`, `get_images`, `media` | the visual/DOM panel the landing page already advertises |
| State | `save_state`, `restore_state`, `profiles`, `login` | the profile story — see §4 |
| Crawl | `fetch_http`, `get_html`, `batch`, `download`, `guide` | batch jobs, raw fetch, downloads |

This is the honest reading of "frontend features not served": the frontend is not missing callers,
it is **missing surfaces for capabilities that already exist.**

### 2.2 arachnefly — corrected. Two routes at most, and one should stay unbridged

> **This table was WRONG in the first draft and the cause is recorded below.** It was written from a
> BFF route list produced with `'/api/[a-z0-9/:_-]+'` — a **case-sensitive** character class that
> silently excluded uppercase, so every route with a camelCase param (`:machineId`, `:taskId`,
> `:orgId`, `:invitationId`, `:tempTaskId`, `:userId`) was missing. The list showed 39 of the real
> **57**. Four routes were then "found" unbridged that were already bridged.
>
> **Correct extraction:** `rg -N --no-heading -i -o "'/api/[^']+'" bff/api.ts`. Match everything
> between the quotes; never hand-write a character class for a path.

| arachnefly route | BFF bridge | First draft said | Truth |
|---|---|---|---|
| `GET /machine/waitforstate/:id` | `/api/machines/machine/waitforstate/:machineId` | "no" | **bridged — the claim was false** |
| `POST /execute-task/:machine_id` | `/api/machines/execute-task/:machineId` | — | bridged |
| `PUT /machine/:id/{start,suspend,stop}` | `/api/machines/machine/:machineId/{start,suspend,stop}` | — | bridged |
| `DELETE /machine/:id` | `/api/machines/machine/:machineId` | — | bridged |
| `GET /machine/proxy/:id` | *(none)* | "no" | **genuinely unbridged** |
| `POST /machine/mcp/:id` | *(none in the BFF)* | "no" | unbridged, but see below |
| `GET /metricsgraph` | *(none)* | "no" | **do not bridge — bad recommendation, retracted** |
| `GET /success`, `/failure` | *(none)* | "no" | server-side callbacks by design |

**`/metricsgraph` is retracted as a gap.** It is `monitor.New(...)` — Fiber's unauthenticated
**HTML** ops dashboard, registered on `app`, outside the `authedApp` group that carries Fire Auth. It
returns a rendered page, not JSON. Bridging it would expose an unauthenticated ops surface through
the BFF for no product value. It is correct that the frontend cannot reach it.

**`POST /machine/mcp/:id`** returns the machine's reply verbatim, including screenshot bytes —
`router.go` documents that it deliberately bypasses `MakeAPICallback` because that wrapper discards
the body and Content-Type. The platform's intended path for that traffic is
`/api/browser/session/:id/frame`, so this is **probably not a gap either**; not verified.

**So the corrected net hole in §2.2 is one route: `GET /machine/proxy/:id`.** And per YAGNI it needs
no bridge until something consumes it — there is no caller-facing proxy-assignment UI, and the
existing proxy surface is the platform-admin pool. **Recommendation: build nothing here.**

### 2.3 Storage — its scope in this orchestration is already settled

BFF owns four routes: `/api/storage/{list,presign,save,settings}`; `StorageTabComponent` is the only
UI; the platform module is the contract and crawlagent conforms (`13-runbook-and-storage-contract.md`
Part C). crawlagent's `storage.py` additionally does **streaming downloads** (`StreamingResponse`),
which the platform's module does not — that is the one capability worth porting, and it is a
*download* concern, not a storage-architecture one.

**Do not build a fifth storage system.** Nothing in this audit changes that decision.

---

## 3. Streaming and websocket gaps

Measured by `rg -i '(websocket|StreamingResponse|text/event-stream|sse)'`:

| Project | Streaming surface |
|---|---|
| **webrain** | **none. Zero hits.** |
| **crawlagent** | rich — SSE in `api.py`, `crawl.py`, `routers/{crawl_router,job_v1,seeder_router}.py`, `storage.py`, plus a `routers/websocket_router.py` and `GET /api/v1/webrtc/sessions` |
| BFF | SSE via `/api/job/stream/*`, `/api/seeder/stream/job/multi-research` |

**The gap, precisely:** the frontend's live channel is now BFF SSE, and webrain — the service that
actually does the long work — **has no progress channel to back it.** `spider`, `crawl` and `batch`
report completion, not progress. So the BFF stream is poll-derived, which is what the repointed
`websocket.service.ts` does. That is correct and cheap; it is also the ceiling.

- A real progress channel means **adding a streaming transport to `webrain-mcp` first**, and that
  is the whole cost. Re-verified by reading the matches under a strict pattern: the `sse` hits in
  `webrain-mcp/src/lib.rs` are substrings of **pa`sse`d** and **a`sse`rt** — not a transport. The
  server is hand-rolled over `std::net` with JSON-RPC request/response only. `notifications/progress`
  is a server→client message, so it needs an SSE (or equivalent) channel to carry it; the
  notification itself is the cheap part. `cargo` is available on this machine.
  **Scope this as a webrain feature, not a line item.**
- **Do not build it yet.** The BFF already serves SSE from polled state and it works. This earns its
  cost only when poll latency measurably hurts. Measure first — `obscura.md`'s benchmark matrix is
  the right instrument, and its inputs are invented, so it is a template rather than a plan.
- crawlagent's SSE and its `websocket_router.py` are now **unreachable from the frontend**. Decide:
  port the SSE shapes to webrain, or let them die with the legacy service. Do not bridge them.

**This is the one place `obscura.md` is directly relevant and its author never says so:** a
worker-fleet model needs a job/progress event stream to be operable. That stream does not exist yet.

---

## 4. The profiles claim — now consistent, but the capability is still absent

The false i18n claim is fixed in all five locales. The *capability* is still not delivered, and
webrain is where it would land: `save_state`, `restore_state`, `profiles` and `login` are **already
implemented tools**. The platform simply exposes none of them.

So "we cannot deliver persistent profiles" is only true of the *platform path*. It is false of
webrain. Correcting the copy was right for what the frontend can do today; the honest next step is a
surface over those four tools — not new browser infrastructure.

---

## 5. Where `obscura.md` slots

Reference only, and its own header already states what to distrust. Two corrections that matter:

- **webrain already uses obscura** — it installs from `h4ckf0r0day/obscura` (`webrain-core/src/install.rs`),
  and drives it over CDP (`webrain-core/src/backends/cdp.rs`). This is not a future migration; it is
  the current backend.
- **The glibc ≥ 2.35 constraint is the operative fact.** Upstream builds
  `x86_64-unknown-linux-gnu` on Ubuntu 22.04 and runs on `distroless/cc-debian12`. Any Alpine worker
  breaks silently. That constraint governs the fleet image long before any capacity number does.

Therefore: **browser pooling belongs in webrain, as the obscura worker fleet.** No fourth service.
Section 8's benchmark matrix is the only part of that document to act on, and it is an assumption
generator — the inputs (2 jobs/user/month, 15 s, 10× peak) are invented, so run the matrix before
believing any node count in it.

---

## 6. Remaining unwired and rebuild/refactor regions

### Unwired (buildable now, no decision needed)

Two rows from the first draft are **deleted**, not fixed: `/metricsgraph` (retracted — it is an
unauthenticated ops HTML page) and `waitforstate` (already bridged, §2.2). Deletion over addition.

| # | Region | Layer | Size |
|---|---|---|---|
| 1 | webrain session/interaction tools have no surface (§2.1) | BFF + Angular | **large** — the biggest remaining block |
| 2 | webrain vision/pdf/state tool groups have no surface (§2.1) | BFF + Angular | medium, separate surfaces |
| 3 | webrain has no progress channel (§3) | **webrain** | medium — MCP `notifications/progress` |
| 4 | Two Firestore collection-group indexes declared, undeployed (§10.D #7) | deploy | trivial, production-visible |
| 5 | arachnefly dev default `localhost:8080` collides with the BFF (§10.D #8) | arachnefly config | trivial |
| 6 | ~~`GET /api/pricing/estimate` absent (`12-production-harmony.md` §4.4)~~ built 2026-10-11; the contract was already written in `domain/billing-pricing.domain.ts` | BFF | done |
| 7 | crawlagent streaming-download capability not ported (§2.3) | BFF | small |

**`GET /machine/proxy/:id` is deliberately not on this list.** It is the one genuinely unbridged
arachnefly route and it has no consumer — YAGNI until a proxy-assignment UI exists (§2.2).

### Decision-gated (do not build)

| Region | Why it waits |
|---|---|
| Fleet lifecycle actions, admin session reclaim | arachnefly's `MachineOwnershipMiddleware` has **no admin bypass**; moving an idle deadline suspends a customer's billing machine. Needs owner sign-off. |
| ~~`TransactionsComponent`~~ | **CORRECTED 2026-10-11 — the claim was stale and false.** It is routed (`billing.route.ts:40`), linked from the nav (`_nav.ts:206`), and calls `billingService.getUsageReport()` with four ranges, rendering invoices, payments and a summary. It needs no endpoint and no deletion. The only open question is whether `/billing/transactions` belongs in the nav. |
| crawlagent's fate | LEGACY / do-not-push, yet still a live default and until this week was the websocket host. Its SSE + WS surface is now orphaned (§3). |

### Rebuild vs refactor

**Nothing here needs a rebuild.** Three targeted refactors, all small:

1. `docs/roadmap/12-*` — **two docs share the number 12.** Rename one. Housekeeping, and it has
   already cost one near-miss.
2. `ENV_CONFIG_MATRIX.md` §3.1 — documents deleted `nekoUrl`; says `wsUrl` "has no dev branch" when
   `wsUrl` is now read by **nothing**. §10.D #9.
3. `ADR-2026-10-BROWSER-SESSIONS.md:64` — cites a zero-result grep as evidence that no WebSocket
   server exists. The decision may stand; the evidence is false.

### Deletion candidates (ponytail: deletion before addition)

| Candidate | Evidence | Risk |
|---|---|---|
| crawlagent's `routers/websocket_router.py`, WS/SSE handlers | frontend no longer dials crawlagent at all | it is the legacy reference; confirm before deleting |
| `BrowserComponent` + neko cluster | already unmounted; kept as the prototype for roadmap `09` | owner said keep as reference |
| ~~`TransactionsComponent`~~ | **NOT a deletion candidate — removed 2026-10-11.** It is routed, nav-linked and calls a live callable; the "unrouted, unreferenced" evidence above was false. | — |

---

## 7. Chat tool-calling and the model catalogue (2026-10-11, in progress)

Measured against source, not planned. Four findings, and one of them changes the order of work.

### 7.1 Do NOT build a platform MCP for this

The question was asked directly, so it is answered rather than assumed. The answer is no, and
the reason is enforcement rather than effort. MCP exposes tools to a THIRD-PARTY client; our
chat is our own client, already holding the caller's Firebase token and already able to reach
every BFF route. An MCP server adds a hop, a second auth model and a second tool registry to
reach routes the browser can call directly — and it would MOVE enforcement. Paywalls, metering
and org scoping live in `bff/api.ts` guards and `decideWebrainTool`; a platform MCP would
duplicate or bypass them on tools that SPEND MONEY (browser sessions, jobs, storage). Chat
tools are therefore a curated list of routes the caller is ALREADY entitled to call, so every
existing 402/403/cap applies unchanged. MCP stays a distribution play for third-party clients.

### 7.2 The AI transport was a 401 for every call, and is fixed

`CLAUDE_API_KEY`, `OPENAI_API_KEY` and `GROQ_API_KEY` were declared in `AiAPIService` and read
in every request header but **assigned nowhere**, so the browser sent `x-api-key: undefined`
and `Authorization: Bearer undefined`. `isJwtAuth` authenticates off the `authorization`
header (`syncaiapi.ts:102`), while the client put the caller's token in `api-key`, which
nothing reads. Claude sent no `Authorization` at all; OpenAI and Groq sent one containing the
string "undefined". Fixed by deletion: the fields are gone and the caller's token moved to the
header the server reads. A provider key must never come from the browser — `ai_handler.ts`
resolves it with `keyFor(req, vendor, env.KEY)`.

### 7.3 Every model id in the client list is a generation old

`setAIModel` offers `claude-3-5-sonnet-20241022`, `gpt-4o-mini`, `gpt-3.5-turbo`,
`llama-3.1-*`. The vendors' own documentation on 2026-10-11 lists `claude-fable-5-1`,
`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `gpt-6-astra`, `gpt-6.1-sol`,
`gpt-6-luna`. Claude 3.5 is absent from Anthropic's legacy list entirely, so **the chat's
default `claude-3-5-haiku-20241022` is plausibly retired** — a second reason the surface failed
beyond 8.2. Two consequences:

- **`user-ai-settings.domain.ts` was right to refuse a model list in code, and this is the
  proof.** Do not re-type the constant. Both vendors publish a **Models API** (Anthropic's
  returns `max_input_tokens`, `max_tokens`, `capabilities`, and a `line` field it explicitly
  documents for a model picker), so "fetch the models" is the intended fix rather than a
  convenience.
- **OpenAI's current models are served by the Responses API**, not `/chat/completions`, which
  is the endpoint `AiAPIService` posts to. Unverified against a live key; if that is literal,
  the OpenAI path cannot reach `gpt-6-astra` as written.

Ordering that works, and step 3 is a DELETION:

1. A vendor row in `AI_VENDORS` + a BFF route + a key. DeepSeek and Qwen are OpenAI-compatible
   (`https://api.deepseek.com`, and DeepSeek also exposes an `/anthropic` base URL), so one
   parameterised route covers them — no new transport.
2. `GET /api/models/:vendor` — the server calls that vendor's Models API with the PLATFORM key
   and caches in Redis. Never the browser; that is what 8.2 just cost.
3. `setAIModel`'s constant is deleted and the dropdown renders the server's reply.

Adding Qwen or DeepSeek to the CLIENT list first would ship broken dropdown items: the client
routes by vendor (`isGroqModel`, else the OpenAI endpoint), so a `deepseek-chat` name would be
posted to OpenAI and 400.

### 7.4 Where chat tool-calling stands, and the exact blocker

**Built and committed:** the tool specs with a JSON Schema per dialect; the gate on model output
(`resolveToolCall`, refusing an unknown name, a real-but-unoffered tool, and unusable
arguments); the streaming accumulators (`accumulateAnthropic` / `accumulateOpenAi` /
`finishToolCalls`); `decodeArguments` as the single definition of "unreadable"; and both stream
parsers now CARRY tool calls instead of discarding them. `ai-tools.fun.spec.ts` is 21 specs.

**Not built, and the blocker is specific: `sendToClaudeAI` and `sendToOpenAI` do not accept a
`tools` parameter.** The stream can carry a tool call, but the request cannot OFFER a tool, so
the model will never call one. Those two signatures and their request bodies are the next edit;
only then does the loop in `chatai` have anything to receive.

**Scope rule for the dispatcher when it lands:** added ONE AT A TIME, each behind the guard its
route already carries. `search` / `scrape` / `serp` are free. A browser session or a job is a
money path, gets its own `available` flag, and gets reviewed on its own — never switched on in
bulk.

### 7.5 One consequence worth not rediscovering

Both streaming methods must emit the SAME shape. `chatai` chooses between them with `? :`, and
the moment Claude emitted `event` while OpenAI emitted `toolCalls`, the resulting union was
**non-callable** and the typecheck failed at the `.subscribe`. Adding a field to one dialect
only is a type error, not a silent no-op.

---

## 8. What this audit did NOT verify

- No external repo was **built**. arachnefly, webrain and crawlagent were scanned, not compiled.
- The arachnefly graph is **stale** (13 routes indexed vs 14 in source after `POST /machine/mcp/:id`).
- webrain's tool list came from `webrain-mcp/src/lib.rs` and may be **truncated** — the scan capped
  at 60 matches and returned 43 usable names. Re-run uncapped before sizing §2.1.
- `/user/:id` was not traced to its BFF caller; the `/api/admin/*` mapping is **inferred**.
- route-parity's no-client list is a **partial false positive** (§1) — do not act on it alone.
- No deployment, Fly machine, or Firestore write was exercised.
