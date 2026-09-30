# Residual risk — crawl trust boundary (2026-09-30, branch `next`)

This records what was **fixed** in the crawl/deployment path, what was
**deliberately not changed**, and the evidence for each. Every claim below was
produced by running something; the command is named next to it. Nothing in this
document was deployed.

Scope: `functions/src/handlers/{ai_handler,crawler,machines}.ts`,
`functions/src/infrastructure/{syncaiapi,events}.ts`,
`functions/src/config/upstreams.ts`, `bff/`, `firebase.json`,
`firebase.dev.json`.

---

## 1. FIXED — caller credential published to every request (cross-tenant)

**Defect.** `isJwtAuth` (the `/api` middleware chain) wrote the caller's raw
Firebase ID token to `req.app.locals["user"]`:

```ts
req.user = decodedToken
req.app.locals["user"] = token   // ← the bug
```

`req.app.locals` is the **Express application's** locals object. It is created
once per process and shared by every concurrent request, so the value written by
tenant A was readable by tenant B's in-flight request. Sixteen call sites read
it: nine in `machines.ts` (which relay the token to Arachnefly), six in
`crawler.ts`, one in `heartbeat`, one in `guestTracker`.

**Why it mattered.** `machines.ts` forwards that value as
`Authorization: Bearer …` to Arachnefly, which **re-verifies** it
(`FireAuthMiddleware`, `arachnefly/interfaces/controller/middleware.go:12-44`,
`firebaseAuth.VerifyIDToken` → `c.Locals("userID", …)`). So the relay is correct
in kind — and that is exactly what made cross-request confusion dangerous: the
wrong tenant's *valid* token authenticates as the wrong tenant.

**Fix.** The raw token now lives on the request: `req.authToken`
(`functions/src/express-augment.d.ts`). The two writers are `isJwtAuth`
(`infrastructure/syncaiapi.ts`) and `optionalJwtAuth` (`infrastructure/events.ts`).
`guestTracker` now reads `req.user` — it only ever needed a truthiness check, and
`optionalJwtAuth` is what populates it.

**Evidence.** `functions/src/handlers/machines.spec.ts` asserts the upstream sees
`Bearer server-held-token` supplied through the per-request slot;

```
cd functions && bunx tsx --test "src/**/*.spec.ts"   → 196 tests, 0 fail
```

Note the BFF was never affected: `bff/bridge.ts:217` builds a fresh
`app: { locals: {} }` per request. Both hosts run the same handlers, which is why
the fix had to land in the handlers rather than in one host.

---

## 2. FIXED — five handlers echoed the upstream error body

**Defect.** `getMachine`, `waitForState`, `startMachine`, `suspendMachine` and
`stopMachine` answered failures with
`res.status(500).json({ error: …, message: String(error) })`, and `String(error)`
embeds the upstream's entire JSON body — internal service names, validation
rules, request ids. `startMachine` additionally answered with
`suspendMachine`/`stopMachine`'s copy-pasted *"Failed to destroy machine"* text,
so the caller could not tell which operation failed.

**Fix.** `message` is gone (logged server-side only), each handler names its own
operation, and every `catch` is guarded by `if (!res.headersSent)` so a pipe
failure after the headers are on the wire cannot throw a second write.

**Evidence.** Eight table-driven cases in `machines.spec.ts` assert none of
`INTERNAL-LEAK-CANARY-9f3a`, the internal hostname, or the request id appear in
the response. Before the fix this run reported 9 failures; it now reports
`fail 0` (command above).

---

## 3. FIXED — a missing id was reported as a malformed one

`stopMachine` tested `validIdPattern` **before** checking for absence, so an
absent id (`""`) failed the pattern's `{1,64}` range and answered
`"Invalid machineId format"`. The other handlers check absence first. Order
corrected; `machines.spec.ts` pins it (*"reports a missing id as missing, not as
malformed"*).

---

## 4. FIXED — an arbitrary Fly host was presented as the operational default

`machines.ts` (9×) and `crawler.ts` (6×) each repeated:

```ts
env.PRODUCTION === "true"
  ? env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev"
  : "http://localhost:8080"
```

The `|| "https://…fly.dev"` branch is **dead**: `config/env.ts` already supplies
that exact value as the default of `getConfigValue("API_ARACHNEFLY_URL", …)`, so
`env.API_ARACHNEFLY_URL` is never empty and the fallback can never run. It is the
same class of bug as the `CRAWL4AI_API_KEY !== '' ? url : url` no-op that was
removed from the client — it reads as a considered fallback and is not one, and
it made a third-party host look sanctioned.

**Fix.** `functions/src/config/upstreams.ts` — one resolver per upstream, no
restated default, no third-party fallback. A missing value now fails loudly at
the fetch instead of silently reaching a host nobody chose.

**Decision record.** There is exactly one place a default host may be written:
the `getConfigValue(...)` default in `config/env.ts`. If the Fly host is to be
removed as the production default, that is a **config change** (set
`API_ARACHNEFLY_URL` / `API_CRAWL4AI_URL`), not a code change — which is the
point of collapsing the sixteen copies.

---

## 5. CHANGED — `crawler.ts` no longer authenticates with the caller's token

`crawler.ts` relayed `req.app.locals["user"]` — the **end user's** Firebase ID
token — to the crawl agent on all six job endpoints. That is the wrong
credential: the agent is started with `WEBRAIN_HTTP_TOKEN` and wants
`Authorization: Bearer <secret>`; a relayed user token is a **401** (recorded as
verified against the running binary in the `ai_handler.ts` note). It also pushed
every tenant's credential into a shared process. It now uses
`env.CRAWL4AI_API_KEY`, the same credential `crawl4aiCore` already uses for
`POST /crawl`.

### Residual risk — the crawl job API's auth contract is UNVERIFIED

`ai_handler.crawl4aiCore` targets `${env.API_CRAWL4AI_URL}/crawl` and its note
(verified against the real binary) says the server-held secret is a 200 and a
relayed user token a 401. `crawler.ts` targets `/crawl/job/*` and
`/crawl/stream/job/*` on the **same base URL**, which is why the same credential
was applied. **This was not verified against a live worker** — no worker was
running, and nothing was deployed.

Two outcomes remain possible and neither can be settled from this repo:

1. the job routes are served by the same worker and now authenticate correctly; or
2. those routes are **crawl4ai-FastAPI** shapes that the webrain binary does not
   serve at all, in which case `CrawlerHandler` is a whole feature to retire —
   the question the platform plan has to answer, not this doc.

**How to settle it** (needs a running worker):

```
# with a real worker reachable at $API_CRAWL4AI_URL and the secret in $CRAWL4AI_API_KEY
curl -s -o /dev/null -w '%{http_code}\n' -X GET "$API_CRAWL4AI_URL/crawl/job/temp-task-id" \
  -H "Authorization: Bearer $CRAWL4AI_API_KEY"       # 200 => outcome 1, 401/404 => outcome 2
```

Until that returns 200, treat `CrawlerHandler` as **unverified**, not working.

---

## 6. NOT FIXED — the redirect hole (SSRF after a 30x)

`ai_handler.ts` validates targets **before** the request: scheme allowlist plus a
`BLOCKED_HOST` regex covering RFC1918, link-local, metadata (`169.254.169.254`),
IPv6 unique-local and `.internal`/`.local`. The author's own note is accurate and
is left in place:

> the agent needs the same list re-checked after redirects, which is the half
> this repo cannot do for it.

That is true for a reason that no amount of work in *this* repo changes: the
redirect is followed **inside the crawler's HTTP client**, after our response to
the client has begun streaming. We cannot interpose on a hop we do not perform.

**Where it must be fixed.** In the component that opens the connection:

- the crawler must be configured to not follow redirects (or to re-validate each
  hop against the same blocklist), and
- `validate_urls` on the webrain side is the intended tool for redirect-safe
  target validation (`Rust/webrain/docs/DEEPSCRAPE_FRONTEND_HANDOFF.md` §3-4).

**Residual risk, stated plainly.** A caller can submit a public URL that 302s to
`http://169.254.169.254/…` or an RFC1918 address and receive whatever the
crawler's own network position can reach. Severity depends entirely on the
crawler's egress (a cloud metadata endpoint is the worst case). This is a
**platform** fix, tracked here rather than papered over.

**One mitigation already in force:** the guard is applied once, in
`crawl4aiCore`, and the browser no longer talks to the crawler directly — see
below — so the check cannot be skipped by choosing a different door.

---

## 7. FIXED earlier — one guarded door, truthful content-type, streaming

Carried over from the same phase and still true on this branch:

- **One door.** `src/app/core/variables/aiservice.var.ts` sets
  `API_CRAWL4AI_URL = '/api'`, so every crawl call from the browser is
  same-origin and lands on the BFF, which applies the guard. There is no
  second, unguarded path from the browser to a crawl engine.
- **Truthful content-type.** `crawl4aiCore` reports
  `apiResponse.headers.get("content-type") || "application/json"` instead of
  hard-coding `application/octet-stream`; the client parses JSON as JSON.
- **Streaming restored.** `await pipeline(apiResponse.body, res)` replaces
  `await apiResponse.arrayBuffer()` + `res.end(Buffer.from(buffer))`, so a large
  crawl is no longer materialised in memory.
- **`x-set-cookie` passthrough removed** from both `crawl4aiCore` and
  `jinaAICrawl` (session fixation).

---

## 8. Platform constraints for the next phase (not yet implemented)

Recorded because violating them is a defect, not a tradeoff:

1. `WEBRAIN_NO_STATE=1` on **shared** workers. Without it the vault and browser
   profiles are process-global, so one tenant can read and then log into
   another tenant's accounts. Shared workers host stateless tenants only.
2. **Never share a `WEBRAIN_PROXIES` pool across tenants.** It is process-global
   and rotates on 403/429, so one tenant hitting a wall rotates another tenant's
   traffic. Per-tenant lanes are unbuilt.
3. A **custom deployment container** must not reuse the shared
   `agent.deepscrape.dev`; a paying customer's container gets its own URL. Point
   the client at it through the BFF so the credential and the guard stay ours.
4. `crawl4ai` and `JinaAI` remain **separate providers** with separate keys.
   Only the request *pattern* is shared, never the upstream.

---

## 9. Emulator configuration

`firebase.json` and `firebase.dev.json` both declared:

```json
"database": { "rules": "database.rules.json" }
```

`database.rules.json` **has never existed** in this repository
(`git log --oneline -1 -- database.rules.json` → empty; `Test-Path` → False), and
nothing uses Realtime Database (`onValueWritten` 0 occurrences;
`@angular/fire/database` / `firebase-admin/database` / `getDatabase(` → 0
occurrences). The block is removed from both files.

`functions/package.json`'s `serve` script also requested the `eventarc` and
`tasks` emulators. Neither trigger type occurs in the codebase
(`onTaskDispatched` 0, `onCustomEventPublished` 0; the 19 `onSchedule` functions
are Pub/Sub, and the 6 `onDocumentWritten` are Firestore — both still requested).
Both emulators are dropped from `--only`.

**Verified:** both configs parse, and `firebase emulators:exec` gets as far as
`Starting emulators: auth, firestore, storage` — i.e. the config is valid.

**Not verified — environment, not repo:** the Firestore **JVM child** then exits
with code 1 under `emulators:exec` on this machine. The same jar runs correctly
when invoked directly:

```
java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar --host 127.0.0.1 --port 5001
→ API endpoint: http://127.0.0.1:5001 ; Dev App Server is now running
```

Java is `23` (`oracle javapath`), ports 5001/8080/9150/4000 all free, and the
debug log is empty — so this is `firebase-tools`' child-process handling on this
box, not a defect in the repo config. Anyone reproducing the emulator issue
should confirm the jar path above first.

---

## 10. Commands run for this change set

| Command | Result |
|---|---|
| `bunx tsc --noEmit -p tsconfig.app.json` | exit 0 |
| `bunx tsc --noEmit -p functions/tsconfig.json` | exit 0 |
| `cd bff && bunx tsc --noEmit` | exit 0 |
| `bunx ng build --configuration=development` | exit 0, `FirebaseError` count 4 → **0** |
| `bunx ng build --configuration=production` | exit 0, **0 errors, 0 warnings** |
| `cd functions && bunx tsx --test "src/**/*.spec.ts"` | 196 tests, **fail 0** |
| `cd bff && bun test` | **61 pass, 0 fail** |
| `index_repository(deepscrape, mode=fast)` | **5,740 nodes / 16,913 edges** |

**Nothing was deployed.**

### The 4 → 0 prerender errors

`login.component.ts`'s `ngAfterViewInit()` called `initializeRecaptcha()` with
its platform guard **commented out**, and `/service/login` is a **prerendered**
route — so every build ran `new RecaptchaVerifier(...)`, which reads browser-only
Auth internals, and logged `auth/operation-not-supported-in-this-environment`
once per render. `signup.component.ts` and `verification.component.ts` already
had the guard, which is why only four errors appeared. The guard is restored and
the comment now says why it is load-bearing. A *commented-out* guard is not a
fix; this is the anti-pattern the phase description warns about.

### The component CSS budget

`admin-analytics.component.scss` was 400 bytes over the 12 kB
`anyComponentStyle` warning. The excess was **dead** CSS, not a budget that
should move: `toggle-checkbox` has 0 occurrences in the template, and
`btn-green` / `btn-red` / `btn-orange` / `btn-ring-green` / `btn-ring-red` /
`btn-ring-orange` have 0 occurrences each. (`@keyframes spin` went with them —
`animate-spin`, the only animation the template uses, resolves to Tailwind's own
global `spin` keyframes.) Deleting them clears the warning by removal.

---

## 11. Arachnefly surface vs deepscrape consumers — the wiring gap

Read from the graph, not from guesswork
(`query_graph(project=arachnefly)` on `Route` nodes, then
`get_code_snippet("arachnefly.interfaces.controller.SetupRoutes")`).

**The prefix question is settled.** `SetupRoutes` mounts every authenticated
route under `app.Group("/api", midlwrFireAuth)`, so `/api/check-image`,
`/api/machine/:id`, `/api/deploy`, … are the real paths — identical to what
`machines.ts` builds. There is no `/api` mismatch and no live 404 from this.

All nine handlers deepscrape calls map onto a real arachnefly route:

| deepscrape (`machines.ts`) | arachnefly | covered |
|---|---|---|
| `GET /api/check-image` | `authedApp.Get("/check-image")` | yes |
| `GET /api/machine/:id` | `authedApp.Get("/machine/:id")` | yes |
| `POST /api/deploy` | `authedApp.Post("/deploy")` | yes |
| `GET /api/machine/waitforstate/:id` | `authedApp.Get("/machine/waitforstate/:id")` | yes |
| `PUT /api/machine/:id/start` | `authedApp.Put("/machine/:id/start")` | yes |
| `PUT /api/machine/:id/suspend` | `authedApp.Put("/machine/:id/suspend")` | yes |
| `PUT /api/machine/:id/stop` | `authedApp.Put("/machine/:id/stop")` | yes |
| `DELETE /api/machine/:id` | `authedApp.Delete("/machine/:id")` | yes |
| `POST /api/execute-task/:id` | `authedApp.Post("/execute-task/:machine_id")` | yes |

**Gap 1 — the custom-deployment URL is built but unreachable from the product.**
`authedApp.Get("/machine/proxy/:id")` → `HandleContainerProxyFiber`
(`interfaces/handlers/fireAuth.go:961-1104`, the largest handler in the service)
exists, and **nothing in deepscrape calls it**: `grep` for
`machine/proxy|/proxy/|HandleContainerProxy|containerProxy` across the repo
returns **zero** matches. There is no `deployment.service.ts` method, no route in
`functions/src/infrastructure/syncaiapi.ts`, and no route in `bff/api.ts`.

This is precisely the "a paying customer's container gets its own URL, not the
shared `agent.deepscrape.dev`" requirement — the capability is deployed on the
arachnefly side and simply not wired into the BFF or the UI. Wiring it needs the
route added to **both** route tables (`syncaiapi.ts` for the function host,
`bff/api.ts` for the BFF) and a `deployment.service.ts` method, or the BFF
becomes the only door and the function host diverges.

**Gap 2 — two more arachnefly routes with no consumer in deepscrape:**
`GET /api/user/:id` (`GetUserInfo`, whose own comment says "this is only for
testing") and `/metricsgraph` (a monitoring page). Neither is reachable from the
product; they are candidates for removal from the public surface rather than
candidates for client work. `/metrics` and `/metricsgraph` are unauthenticated
by design (`prometheus.RegisterAt` / `app.Get` are registered before the
`/api` group), which is worth confirming against the deployment's network
policy.

**Gap 3 — three env parsers, un-reconciled.** `src/config/env.ts`,
`functions/src/config/env.ts` and `functions/src/config/upstreams.ts` plus the
root `src/environments/*` generation are separate readers of the same variables.
`upstreams.ts` deliberately does **not** add a fourth default (see §4), but the
duplication between the two `config/env.ts` files is untouched and is the Phase
3.3 item. Not started.

