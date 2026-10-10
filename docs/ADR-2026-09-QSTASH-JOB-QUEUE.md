# ADR-2026-09-QSTASH-JOB-QUEUE: the crawl job queue

- **Status:** proposed (one open decision: which host receives deliveries)
- **Date:** 2026-09-30
- **Scope:** `deepscrape/deepscrape` — Bun/Elysia BFF (`bff/`), Firebase
  Functions (`functions/`), Angular client (`src/app`)

## Context

### The consumer is already written. Only the producer is synchronous.

This is the whole argument for the queue, so it comes first.

`src/app/pages/user/operations/operations.component.ts:299` already reacts to
non-terminal job states:

```ts
if (!s.final && !this._seenTaskIds.has(s.task_id)) {
  this._seenTaskIds.add(s.task_id)
  shouldRefresh = true
}
```

`OperationStatusService` already maps nine statuses to snackbar output, including
`IN_PROGRESS` and `PENDING`. The dashboard already polls, already dedupes by
`task_id`, already refreshes on a non-final frame.

It has never received one. `multiCrawlEnqueue`
(`functions/src/handlers/webrain-jobs.ts`) runs the **entire batch inline**:

```
request → for (url of urls) await webrainTool(...) → write job doc → respond
```

so the job is **terminal the moment its id is handed out**. `In Progress` is
unreachable, not by policy but by construction. A 50-target batch blocks the HTTP
request for the full duration and then reports `Completed` in one frame.

So this ADR is not "add a queue for performance". It is: **the queue is the
missing half of a feature that is already built on the client.**

### Verified current state

| Item | State | Evidence |
|---|---|---|
| Queue env vars declared | **yes** | `config/env.ts:207-213`, `env.d.ts:17-20` |
| `@upstash/qstash` installed | **no** | absent from `functions/package.json` and `bff/package.json` |
| Publisher | **no** | no publish call site anywhere |
| Worker endpoint | **no** | — |
| Signature verification | **no** | no `Upstash-Signature` reference in the repo |
| Flow control | **no** | no `flow_control` reference in the repo |
| Job routes registered | **yes** | `bff/api.ts:174-202` (7), `syncaiapi.ts:925-928` (8) |
| Guard on those routes | **yes** | `paid` + `perm('crawl','execute')` on both hosts |
| Local dev server | **works** | see §Local development |

The four env vars are declared and typed but unread. That is deliberate
groundwork from the provider-abstraction phase, not an oversight.

### Why QStash, and what was rejected

The work is **one HTTP call per target** to a synchronous MCP worker. It needs
retries, a concurrency ceiling against a *shared* browser pool, and an at-least-
once delivery guarantee. QStash is HTTP-in/HTTP-out with those three properties
and no infrastructure to run.

Rejected:

- **Cloud Tasks** — already on the platform and a defensible choice, but it
  requires a queue definition and the payload/signature model is ours to build.
  QStash supplies signature verification and flow control as features.
- **Celery/Redis (the crawlagent model)** — that is the design this repo is
  moving *away* from; it requires workers to run.
- **Inline with a longer timeout** — does not make `In Progress` reachable, which
  is the actual goal.

## Decision

### 1. One message per target, not per job

This is the load-bearing decision.

A job of 50 targets publishes **50 messages**. Consequences:

- **Fairness.** One message occupying one concurrency slot for the whole batch is
  head-of-line blocking: a 50-target job stalls every other tenant behind it.
  50 smaller messages interleave.
- **Real progress.** Each message landing updates the job doc, so the dashboard
  can report `3 of 50` instead of a binary done/not-done.
- **Partial failure is normal**, not exceptional. 47 ok / 3 failed is a real
  outcome the current all-or-nothing loop cannot express.
- **Retry granularity.** A retry re-runs one target, not fifty.

Cost: 50 messages instead of 1. Acceptable — QStash bills per message, and the
alternative is a stalled request.

### 2. Enqueue becomes write → publish → respond

```
POST /api/crawl/stream/job
  1. validate + guard (unchanged, existing paid + perm('crawl','execute'))
  2. write job doc  { status: "In Progress", total: N, items: [] }
  3. publish N messages, one per target
  4. respond immediately: { task_id, status: "In Progress", total: N }
```

The response contract does not change shape — only the `status` value moves from
terminal to `In Progress`. Existing client code reads it unchanged.

**Publish before respond, and fail loudly if publishing fails.** If the response
returns a `task_id` for messages that were never queued, the client polls a job
that will never advance. A publish failure must mark the job `Failed` and return
5xx, so the user sees an error instead of a hang.

### 3. Flow control, keyed on the pool — not the tenant

```ts
flow_control: {
  key: "webrain-pool",
  parallelism: <shared pool ceiling>,
  rate: <ceiling>,
  period: "1s",
}
```

`parallelism` **must not exceed the shared worker pool's real ceiling.** Exceeding
it does not queue politely; the pool refuses and every excess call becomes a
transport error that then retries and amplifies. This value is a measurement, not
a guess — establish it against a live worker before setting it.

Keying on `webrain-pool` protects the pool, which is the scarce resource.
Per-tenant fairness comes from per-target messages plus the existing rate limiter,
not from the flow-control key. A per-tenant key was rejected: it protects tenants
from each other but lets the *total* concurrency run unbounded into a shared pool.

### 4. The worker endpoint authenticates by signature, not by JWT

```
POST /api/jobs/crawl/worker     ← internal, QStash only
```

QStash cannot present a Firebase JWT, so this route **cannot** sit behind the
existing `guard([...])` chain. Its authentication is `Upstash-Signature`,
verified against **both** signing keys (current and next — a single key drops
every in-flight delivery as a forgery during rotation).

The signature binds the request body, so a stolen body cannot be replayed with a
different payload. It must still be excluded from the browser-facing route table
so it does not appear in API documentation as a user-callable endpoint.

**Do not add rate limiting or a paywall in front of it.** Those belong on the
enqueue route, which is where a user acts. The worker route is machine-only.

### 5. Acks and retries: distinguish permanent from transient

The mapping is the important part:

| Outcome | Response | Effect |
|---|---|---|
| Target scraped (ok or refused) | **200** | delivered, no retry |
| Blocked URL / bad target (`url-guard` refused) | **200** | permanent — retrying cannot help |
| Worker refused the tool (`tier`/`noStateRefused`) | **200** | permanent — config, not weather |
| Worker unreachable (`transportError`) | **5xx** | transient — retry |
| Firestore write failed | **5xx** | transient — retry |

A 4xx must never be returned for a target-level failure, or QStash retries it
three times and the user is billed for the same failure. `Upstash-Retried`
(headers start at 0) identifies a retry when logging.

### 6. Idempotency: `Upstash-Message-Id` is the billing key

At-least-once delivery means a message can be processed twice. Two things must be
idempotent:

- **Billing.** Pass `Upstash-Message-Id` as the idempotency key to
  `applyBillingCreditMutation`, using the same discipline already established for
  that path. Without it, a retry double-charges.
- **The job doc.** Record processed message ids on the job doc and skip a
  duplicate. A blind `arrayUnion`/counter increment produces `51 of 50`.

### 7. Failure callback feeds the DLQ

Set `failureCallback` so exhausted retries land in the QStash DLQ rather than
disappearing. A poison message must be inspectable (`qstash_dlq_list`) and
replayable (`qstash_dlq_manage`), not silently lost.

## The one open decision: which host receives deliveries

**Both hosts register the same job routes** — `bff/api.ts` and
`syncaiapi.ts` each serve `/api/job/stream/...`. Today that is harmless: both are
read-only handlers reading the same Firestore.

For the queue it is not harmless. If the worker route is published on both, QStash
delivers to one URL, but **a deploy of the other host does nothing to protect
it**, and a misconfigured target could deliver to a host that is not the one
holding the publisher's state. Worse, if both are ever pointed at, every target
is scraped twice and billed twice.

**Recommendation: the queue runs on the BFF.**

- It is the production `/api` surface the Angular app reaches, so the publisher
  belongs beside the enqueue route it serves.
- `min-instances 1` means no cold start on delivery — a cold-started worker can
  exceed the QStash timeout and be retried for a slow start, not a failure.
- `bff/api.ts` already imports `functions/src/handlers/webrain-jobs` verbatim, so
  this needs no new pattern.

The Functions copy keeps its job routes for the Firebase-hosted path and **must
not** have a QStash delivery target. Record this in the deploy config, because
nothing in the code prevents it.

## Local development

**Verified working 2026-09-30** (qstash-cli 2.37.18):

```
npx @upstash/qstash-cli@latest dev -port=8090 -log-port=8091
```

### The trap that caused a real failure

`qstash-cli dev` with **no flags defaults to port 8080 — which is the BFF.**
Observed: `FTL address already in use: 127.0.0.1:8080`, exit code 1.

Always pass both ports, and check they are free first (the log server takes
`port + 1`):

```powershell
netstat -ano | findstr ":8090 :8091"    # must print nothing
```

A second observed failure was on the **log** port (8091), not the main port —
`FTL address already in use: 127.0.0.1:8091`. Both ports must be free; checking
only the main one is not enough.

### Local credentials are fixed constants

The dev server prints the *same* token and signing keys on every run
(`defaultUser`/`defaultPassword`, base64). They are published defaults, identical
for every developer, so they are safe in `.env.local`. They are **not** secrets —
unlike the real `QSTASH_*` values.

```env
QSTASH_URL=http://127.0.0.1:8090
QSTASH_TOKEN=<the dev server's printed token>
QSTASH_CURRENT_SIGNING_KEY=<printed>
QSTASH_NEXT_SIGNING_KEY=<printed>
```

Other properties to respect: it is **in-memory** (messages are lost on restart)
and licensed for **dev/test only**. Console: `console.upstash.com/qstash/local-
mode-user?port=8090`.

**Never point a local token at a deployed worker**, or a local test scrapes
production targets and bills real credits.

## Phases

Each phase is independently verifiable. Do not start a phase before its
predecessor's acceptance check passes.

### Phase 0 — dependency and local queue

- `bun add @upstash/qstash` in `functions/` (see note below).
- Run the dev server on 8090/8091, publish one message to a local echo endpoint,
  confirm `Upstash-Signature` arrives and verifies against both keys.

**Acceptance:** a message published locally is delivered locally and its signature
verifies. No production credentials involved.

> **Dependency placement.** `functions/package.json` is the correct home. The
> Dockerfile already copies it to `/functions/` and runs `bun install` there
> specifically so `functions/src/*` imports resolve at runtime, and it symlinks
> `/src/node_modules → /functions/node_modules`. Adding the dep there reaches the
> Cloud Run image with **no Dockerfile change**. Adding it only to `bff/` would
> leave `functions/src` imports unresolved at runtime — a failure invisible at
> build time.

### Phase 1 — publisher

- `functions/src/infrastructure/qstash.ts`: a thin publish wrapper reading
  `QSTASH_URL`/`QSTASH_TOKEN`, honouring `Authorization: Bearer`.
  **Never the `?qstash_token=` query form** — query strings land in access logs.
- Test-first, with the dev server as the transport.

**Acceptance:** enqueue writes `In Progress`, publishes N messages, returns in one
round trip. A publish failure marks the job `Failed` and returns 5xx.

### Phase 2 — worker endpoint

- `POST /api/jobs/crawl/worker` on the **BFF only**, signature-verified, both keys.
- Per-target work; job doc updated per landing message.
- Ack policy exactly as §5; `Upstash-Message-Id` as the billing idempotency key.

**Acceptance:** a 3-target job moves `In Progress` → `Completed` visibly;
`completed` never exceeds `total` when a message is deliberately redelivered;
a permanent failure is not retried.

### Phase 3 — concurrency ceiling

- Measure the pool's real ceiling, then set `parallelism` to it.
- Prove a tenant's 50-target job cannot exceed it.

**Acceptance:** measured concurrency stays at or under the ceiling under two
simultaneous large jobs.

### Phase 4 — client

The core win needs **no** client change. This phase is polish:

- Surface `completed / total` progress (the job doc already has it).
- Fix `WebSocketService` putting the Firebase ID token in the **query string**
  (`websocket.service.ts:44,75`) — live on `/operations`, lands in access logs.
  Any touch of the status path is the moment to fix it.
- Deep-link a notification to its job (the `/operations` link already exists).

**Acceptance:** `/operations` shows real progress for a multi-target job; no
credential appears in a URL.

### Phase 5 — scheduled platform work

QStash schedules for existing recurring concerns (IP-intel DB refresh, session
cleanup). Separate ADR — listed here only so the queue is not designed in a way
that forecloses it.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `parallelism` set above the pool ceiling | refusals → retries → amplification | measure first; treat as config, not a guess |
| Worker route published on both hosts | double scraping, double billing | BFF only; record in deploy config |
| A 4xx returned for a target failure | 3 pointless retries, billed | §5 mapping, tested |
| Billing not idempotent | double charge on retry | `Upstash-Message-Id` as the key |
| QStash timeout < worker worst case | delivered as failure, retried | size timeout above the worst observed call; mind Cloud Run's request timeout |
| Jobs exist only for webrain | a provider switch silently 501s jobs | keep `requireWebrain` in front of the worker; crawl4ai adopts via the adapter later |
| Local token pointed at a deployed worker | scrapes production targets | separate `.env.local` values; never reuse a real token |

## What this does NOT change

- The SSE contract. Both client streaming methods read progress from
  `partialText` on `DownloadProgress` and ignore the final body, so the worker's
  status/results handlers must keep streaming. `bff/bridge.ts` forwards writes for
  this reason.
- The status vocabulary — `In Progress` / `Completed` / `Failed` / `Canceled`,
  mirrored from `CrawlOperationStatus`.
- Both registered route spellings (client path and the transposed legacy path).
- The existing guard on the enqueue route: `paid` + `perm('crawl','execute')`.
- The provider abstraction. The queue sits behind the same provider resolution.
