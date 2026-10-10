# Ground truth — verified anchors

Every claim below was verified against source or the indexed code graph on **2026-10-01**.
The command used is recorded with each section so it can be re-run. Nothing here is
inferred, and nothing here should be edited to match an assumption — re-verify instead.

---

## arachnefly — authorization gap

Root: `D:\Windows\Documents\Programming\Projects\Go\deepscrape\arachnefly`
(codebase-memory project `arachnefly`, 784 nodes / 1,521 edges)

Router: `interfaces/controller/router.go`, `SetupRoutes` (lines 24–105).
Every machine route is registered on the authenticated group:

```go
authedApp := app.Group("/api", midlwrFireAuth)
```

So every route below requires a valid Firebase ID token. **None of that implies ownership.**

Verified route count: **13**.

### Handlers that read the caller

`c.Locals("userID")` — found in exactly 7 places (middleware + 6 handlers):

| Handler | Lines | Route |
|---|---|---|
| `FireAuthMiddleware` | `interfaces/controller/middleware.go` 12–44 | (group middleware) |
| `WaitForState` | 222–317 | `GET /api/machine/waitforstate/:id` |
| `DeployMachine` | 320–463 | `POST /api/deploy` |
| `StartMachine` | 466–544 | `PUT /api/machine/:id/start` |
| `SuspendMachine` | 546–623 | `PUT /api/machine/:id/suspend` |
| `StopMachine` | 626–715 | `PUT /api/machine/:id/stop` |
| `DestroyMachine` | 718–859 | `DELETE /api/machine/:id` |

### Handlers that do NOT read the caller

| Handler | Lines | Route |
|---|---|---|
| `GetUserInfo` | 122–155 | `GET /api/user/:id` |
| `GetMachine` | 158–220 | `GET /api/machine/:id` |
| `ExecuteTask` | 862–956 | `POST /api/execute-task/:machine_id` |
| `HandleContainerProxyFiber` | 961–1104 | `GET /api/machine/proxy/:id` |

All in `interfaces/handlers/fireAuth.go`.

`ParseImageHandler` (1112–1217, `GET /api/check-image`) is **not** an ownership hole, because
it names no machine. It is a separate primitive: it takes a caller-supplied image name and
issues `remote.Head(ref)` against the registry inside that name, so an authenticated caller can
make arachnefly originate a request to a host of their choosing. Treat it as an SSRF/probe
surface, not an authorization gap. (An earlier draft of this file listed it as a fifth
ownership hole — that was wrong.)

### Mutating handlers that checked too late

`StartMachine`, `SuspendMachine`, `StopMachine` and `DestroyMachine` all read
`c.Locals("userID")`, but only use it for the **Firestore write at the end**. Each issues its
Fly API call first:

| Handler | Fly call | Ownership consulted |
|---|---|---|
| `StartMachine` 466–544 | `POST .../machines/:id/start` first | only afterwards, in `UpdateMachine` |
| `SuspendMachine` 546–623 | `POST .../machines/:id/suspend` first | only afterwards |
| `StopMachine` 626–715 | `POST .../machines/:id/stop` first | only afterwards |
| `DestroyMachine` 718–859 | `DELETE .../machines/:id` first | only afterwards |

"Reads the uid" was never the same as "verifies the uid". A cross-tenant caller could mutate
another tenant's machine and then receive a 500 when the trailing Firestore write failed — the
mutation had already happened.

### What that permitted

With one valid ID token from any account, a caller could:

- read any machine's details and IP — `GET /machine/:id`
- proxy into any running container — `GET /machine/proxy/:id`
- execute arbitrary tasks on any machine — `POST /execute-task/:machine_id`
- start, suspend, stop or destroy any machine — `PUT` / `DELETE /machine/:id*`
- read any user's record — `GET /user/:id`, whose route comment reads
  *"get userID from context and pass to handlers, this is only for testing"*

### The literal identity header

`HandleContainerProxyFiber` deleted `Authorization`, then set a **literal**:

```go
c.Request().Header.Set("X-Authenticated-User-Id", "userID")
```

The target service therefore could not identify the caller at all, and anything trusting the
header received a constant.

---

## FIXED 2026-10-01 — ownership guard

Machine-scoped routes carry `AuthHandler.MachineOwnershipMiddleware`
(`interfaces/handlers/fireAuth.go`), registered as the **first handler of each route** in
`interfaces/controller/router.go`:

```go
authedApp.Get("/machine/:id", fireAuthHandler.MachineOwnershipMiddleware, MakeAPICallback(fireAuthHandler.GetMachine))
```

Covered: `GET /machine/:id`, `GET /machine/proxy/:id`, `GET /machine/waitforstate/:id`,
`POST /execute-task/:machine_id`, `PUT /machine/:id/{start,suspend,stop}`,
`DELETE /machine/:id`. `GET /check-image` and `POST /deploy` are deliberately uncovered —
neither names an existing machine.

Because the guard runs **before** the handler, it also closes the late-check defect above: no
Fly call is reachable for a machine the caller does not own. It reads the machine id from
either route parameter name (`:id`, `:machine_id`), and returns **404** rather than 403 so it
does not confirm that another tenant's machine exists. An unverifiable claim (Firestore error)
fails **closed** with 500.

Backing store: `Firestore.MachineExists(userID, machineID)` — one document existence check on
`users/{uid}/machines/{machineId}`, matching the layout `CreateMachine` writes. Declared on
`domain.IFirestore`.

Also fixed in the same pass: the forwarded identity header now carries the resolved uid, and
`GetUserInfo` refuses to return another user's record (a path parameter is not a capability).

Test: `interfaces/handlers/machine_ownership_test.go` — the first test file in that package.
Six cases: owner passes, non-owner refused, Firestore error fails closed, missing caller
identity refused without consulting the repository, and the `:machine_id` parameter name.

### TRAP — `app.Group("")` silently registers nothing

The first implementation used `authedApp.Group("", middleware)` and registered the machine
routes on that group. `go build` and `go vet` both passed. The test then showed **every**
machine route returning 404: the empty group prefix did not produce working routes.
Registration is now per-route, which is also the clearer diff.

Do not reintroduce an empty-prefix group here. If a group is ever wanted, prove it with a
request test first — this failure class is invisible to the compiler and to `go vet`.

### FIXED 2026-10-01 — SSRF through the `check-image` registry probe

`ParseImageHandler` took a caller-named image reference and called `remote.Head(ref)`, which
originates a request from arachnefly to whatever host that name contains. Nothing validated
the host first, so any authenticated caller could aim it at loopback, the cloud metadata
address, or **Fly's own Machines API at `_api.internal:4280`**.

`registryIsBlocked` in `interfaces/handlers/fireAuth.go` now refuses the request before
`remote.Head` runs. It strips a port, then blocks loopback, private, link-local,
unspecified and multicast IPs, `localhost`, a `0.` prefix, `.local`, `.internal`, and any
single-label name. It deliberately mirrors `BLOCKED_HOST` in
`functions/src/domain/url-guard.domain.ts` so the two services cannot disagree about what
"private" means — the repo's own rule is that this policy lives in one place per language, not
one place total. Test: `interfaces/handlers/registry_guard_test.go` (20 host cases).

The platform side is intentionally unchanged. `handlers/machines.ts` forwards `name` verbatim
and should not grow a second, hand-rolled Docker-reference parser; arachnefly owns the parse
(`ref.Context().RegistryStr()`) and is the component that opens the socket.

### FIXED 2026-10-01 — a `log.Fatalf` in a request handler killed the orchestrator

`DeployMachine`'s `CreateMachine` error path called `log.Fatalf` (`fireAuth.go:488`), which calls
`os.Exit(1)`. So one tenant's failed Firestore save **terminated the arachnefly process** — after Fly had
already created the machine, and before the 500 response sitting immediately below it could be returned,
leaving a machine no record points at. Two sibling `Fatalf` calls at `:426` and `:447` were already
commented out for this reason; this one was missed. Now `log.Printf`, so the intended 500 is returned.
No live `log.Fatalf` remains in the handler (`interface/repository/firestore.go:37` is startup-only and
correct there).

### `machine.schema.json` — required, tracked now, and it validates NOTHING

Corrected 2026-10-01. The previous version of this section said "required at runtime but NOT in
git" and implied an empty schema was reaching production. Both halves were wrong or incomplete.

What was true: `NewFirestore` (`interfaces/repository/firestore.go`) read the file from
`os.Getwd()`, **printed** the `os.Open` error and **discarded** the `os.ReadFile` error, so a
missing file yielded an empty string. It was gitignored (`.gitignore` = `*.schema.json`) and
untracked (`git ls-files` → 0).

What that note missed:

- **The Dockerfile already COPYs it** — `COPY --from=builder /app/machine.schema.json` with
  `WORKDIR /app` — so a container deploy has it, and a build whose context lacks it **fails
  loudly**. Production was never silently validating nothing. The real casualty is a **fresh
  clone**, which cannot build at all.
- **The schema validates nothing even when present.** Its root keys are `["schema"]`. Every
  constraint sits *under* that one property, and `schema` is not a JSON Schema keyword, so the
  loaded document has **no validation keywords at all** and accepts any document. Corroboration:
  `CreateMachine` checks `machine["id"]` by hand *before* validating, which would be redundant if
  the schema worked.

Fixed: the `.gitignore` carries a `!machine.schema.json` negation (it is tracked now), and the
loader **fatal-errors** when it cannot read the file or when the document is not a compilable JSON
Schema — an empty schema can no longer be silent, and it is a boot failure rather than a request
failure. `scripts/gen-machine-schema` regenerates it.

**The obvious spec URL is dead.** `docs.machines.dev/swagger/doc.json` → **404**. The live one is
`https://docs.fly.io/api/machines/openapi.json` (OpenAPI 3.1.0). The generator emits a
self-contained draft-07 document (root `type: object`, refs rewritten `#/components/schemas/X` →
`#/definitions/X`, 182 definitions), deliberately **without** `required` or
`additionalProperties: false` so an upstream field addition cannot become a failed deploy.

**Open — and this one should change the plan.** Validating Fly's *response* runs **after**
`FlyRequest` has already created the machine, so a failure cannot protect anything: it can only
skip the Firestore write and **orphan** the machine. Turning this check on is therefore a
*downgrade* in safety today. A schema earns its keep on the **request** (`machineConfig`),
validated *before* `SaveDeployment` and `FlyRequest`. The generated file is ready for that; do not
swap it in without moving the check.

### Residual (not fixed)

- The platform turns arachnefly's 400 into a 500, because `checkImageDeployability` throws on
  any non-OK response. Cosmetic: the request is refused either way, but the status is wrong.
- Two `log.Printf` calls inside `HandleContainerProxyFiber` still interpolate the literal
  `"userID"`. Cosmetic — log output only — but misleading in a security path, and both sit
  above the point where the caller id is resolved.
- `DestroyMachine` still writes history after the Fly delete. The guard makes the
  cross-tenant path unreachable; the ordering itself is unchanged.

---

## deepscrape — the Express table is NOT a second host

Verified 2026-10-01. `bff/api.ts` (Bun + Elysia, Cloud Run `deepscrape-bff`) is the **only** served
`/api` surface.

`functions/src/infrastructure/syncaiapi.ts` is a **library** the BFF consumes: `bff/api.ts:68` imports
`ReverseAPIProxy`, `:72` instantiates it, and the BFF binds its middleware — `isJwtAuth`,
`requirePaidAccess`, `resolveAccess`, plus private org handlers reached by name through the `org(name)`
accessor (which throws at startup on a rename). The class is very much alive.

What is **not** alive is its route table. The ~49 `this.router.<method>(...)` registrations inside
`ReverseAPIProxy` are never mounted:

| Evidence | Finding |
|---|---|
| `functions/package.json` `main` | `lib/functions/src/index.js`, compiled from `functions/src/index.ts` |
| `functions/src/index.ts` | contains **none** of `express`, `Router`, `infrastructure`, `onRequest`, `ReverseAPIProxy` |
| `functions/src/server.ts` | does not exist |
| `firebase.json` | every hosting `rewrites` entry is `{"source":"**","run":{"serviceId":"deepscrape-bff"}}`; no `function` rewrite on any of the three sites |
| `ReverseAPIProxy` importers | only `bff/api.ts` and `syncaiapi.org-guard.spec.ts` |

**Consequence: route drift between the two tables cannot 404 anywhere.** `scripts/route-parity.ts`
compares a live table against a dead one; it is an inventory aid, not a gate. An earlier version of
this file claimed drift caused a silent 404 "on the other host" — that was wrong, and so was the
`02` / `05` / roadmap `README` guidance built on top of it.

**Do not "fix" parity drift by adding routes to `syncaiapi.ts`.** Nothing serves them. Add routes to
`bff/api.ts` only. The Functions-side coupling that *does* matter is the handler modules the BFF
imports directly: `handlers/machines.ts`, `handlers/webrain-config.ts`, `handlers/contact_handler.ts`,
`handlers/home_handler.ts`, `infrastructure/qstash`.

The five "BFF-only" routes the diff reports are all legitimately BFF-only: `POST /jobs/crawl/worker`
and `POST /jobs/crawl/failed` (QStash callbacks, authenticated by HMAC signature — QStash cannot hold
a Firebase JWT), `GET /status` (health, outside `/api`), `POST /services/contact` (public form,
deliberately CSRF-exempt), and `POST /machines/execute-task/:machineId`, which one live UI path calls:
`deployment.service.ts:255` → `/api/machines/execute-task/:machineId` ← `machines.component.ts:312`.

Related unresolved discrepancy (unchanged): `functions/src/handlers/machines.ts` forwards the
**caller's** token (`const token = req.authToken`) while
`docs/ADR-2026-09-PLATFORM-ARCHITECTURE.md` says the platform uses a server-held token only.

---

## Decoys — things that look live and are not

Three artefacts in this workspace read as active machinery and are inert. Each has already cost
investigation time; verify before trusting a config file.

| Artefact | Reality |
|---|---|
| `functions/src/infrastructure/syncaiapi.ts` route table | never mounted (see the section above) |
| arachnefly `fly-autoscaler.toml` | config for a **different** Fly app (`app = "arachnefly-autoscaler"`, `:1`), scaling on **response time** (`:11-12`), not idleness. Nothing deploys it: arachnefly's `.github/workflows/` is an **empty folder** and its `Makefile` has no autoscaler target. |
| arachnefly `SCALER.md` | a pasted chat transcript (`:1` is prose about Prometheus query choice), not decision logic. `README.md:48` describes scaling on "Active Requests / Queue Depth / CPU and Memory", which does not match the committed `fly-autoscaler.toml`. |

The only idle mechanism that actually acts on tenant machines is **Fly's platform `autostop`**, written at
deploy time from the user's own dropdown (default `suspend`; `src/app/core/functions/global.fun.ts:367-371`
→ `routines/global.go:236` → `"autostop": machineConfig.AutoStop`). Machines deployed as `manual`/`off`
never autostop. **No team-written reaper exists** — and `synchronizer.go` is a state mirror only: it lists
machines and writes Firestore `state`, with no `suspend`/`stop` call.

## The platform URL guard — two silent IPv6 bypasses (fixed 2026-10-01)

`functions/src/domain/url-guard.domain.ts` is the single SSRF guard for crawl, scrape, monitor, job
and AI targets. Its host pattern matched **text**, and the WHATWG URL parser does not hand over the
text you wrote, so two whole classes of address passed:

| Submitted | `new URL().hostname` | Old verdict |
|---|---|---|
| `http://[::1]/x` | `[::1]` — brackets kept | **allowed** — `::1$` cannot match a string ending in `]` |
| `http://[::ffff:169.254.169.254]/` | `[::ffff:a9fe:a9fe]` — the IPv4 re-encoded as hex | **allowed** — stripping `::ffff:` left `a9fe:a9fe`, matching nothing |

`fe80::/10` (link-local), `ff00::/8` (multicast) and `::` (unspecified) were absent from the pattern
entirely. `isBlockedHost` now strips brackets, decodes the mapped hex form back to dotted IPv4 so the
IPv4 alternatives judge it, and the pattern covers the missing families. Verified by direct
evaluation:

```
safe=false  http://[::ffff:169.254.169.254]/   <- was true
safe=false  http://[::1]/x                     <- was true
safe=false  http://[fe80::1]/x                 <- was true
safe=false  http://[::]/x                      <- was true
safe=true   http://[2606:4700::1111]/x         <- public IPv6 still crawls
```

Regression pinned in `url-guard.domain.spec.ts` — a new file, because the guard had **no spec**, which
is why both bypasses survived. Anything that reuses `isBlockedHost` (the new `decideCdpUrl` among
them) inherits the fix.

## Machine ownership — the owner is the path, not a field

- Path: `users/{uid}/machines/{machineId}`, where the doc id is the **Fly machine id**
  (`interfaces/repository/firestore.go:116,121`). `MachineExists` checks exactly this path (`:148-159`).
- `MachineInDB` (`domain/machine.go:253-272`) has **no UserID field**. The owner is the parent path plus
  redundantly `config.metadata.user_id` (`infrastructure/routines/global.go:255-256`), which the
  synchronizer reads back (`synchronizer.go:99-100`).
- A cross-user query therefore needs a **collection-group** query reading `doc.Ref.Parent.Parent.ID`
  (`firestore.go:262`), plus a composite index that does not exist today.
- `machines_history/{machineId}` is flat, so the **owner is lost** on delete (`firestore.go:162-195`).
- The owner uid is **required** by `MachineOwnershipMiddleware`, so any service actor that must act on a
  machine it does not own cannot use the HTTP routes — see roadmap `02` §1.5.

---

## webrain

Root: `Rust/webrain` (codebase-memory project `webrain`, 2,546 nodes / 5,951 edges).
Also distributed as a **portable desktop binary** — that distribution must keep working
standalone and must not be coupled to platform auth.

- `ProxyPool` (`proxy.rs:35`) is a **proxy** pool, not a browser pool. It serves only the
  no-browser SERP path.
- The process has no caller identity: one process-wide secret, `session_id` accepted verbatim,
  and `session(op=list)` enumerates every session including `cdp_url`.
- The `WEBRAIN_NO_STATE` guard now covers the umbrella `webrain_session` tool.
- `fallback_chain` (`serp.rs:1240`): HTTP engines first → `serpapi_google` → `browser_search`
  **last**, and only when a browser backend is present. **Free tier needs no browser.**
- `docker/Dockerfile` installs chromium but never starts it (`ENTRYPOINT ["webrain"]`,
  `CMD ["mcp","--http","9223"]`).

### HTTP transport auth — verified 2026-10-01

Layout first: the crate is `webrain-mcp/src/lib.rs`, **not** `src/lib.rs`. Asking
`check_index_coverage` for `src/lib.rs` returns "missing" for that reason.

| Fact | Anchor |
|---|---|
| Token env var | `WEBRAIN_HTTP_TOKEN`, read once per request at `webrain-mcp/src/lib.rs:1252` |
| Compare | constant-time `token_eq` (`:97`); scheme case-folded, value byte-exact |
| **Unset ⇒ allow all** | `bearer_allows` returns `true` when the expected token is unset, empty, or whitespace-only (`:131`) |
| Only bypass | `/health`, answered **before** the token is read and on **any** method (`:1221`) |
| Loopback detection | none existed — nothing inspects the bound address or the peer, so the loopback default was a default, not an invariant |
| Bind | `WEBRAIN_HTTP_ADDR`, default `127.0.0.1:<port>` (`webrain-cli/src/main.rs:69`) |
| Desktop path | **stdio only** — `webrain mcp` without `--http`; HTTP is opt-in |

**Fixed 2026-10-01 — fail closed on an exposed bind.** `run_http` (`:1099`) now refuses to
start when no token is set *and* the bind is not loopback-only. `bind_is_loopback` (`:1089`)
treats `0.0.0.0`, `[::]`, an unresolved hostname, and an empty address as exposed.
`WEBRAIN_ALLOW_UNAUTHENTICATED=1` is the single explicit opt-out — used by
`docker/docker-compose.yml`, whose port is published to host loopback only, so the unsafe case
has to be *stated* rather than inherited from a default. Test:
`bind_is_loopback_only_for_loopback_literals` (`:1552`).

The token gate itself is a shared secret: no per-caller identity, no rotation, no replay
window. Adequate for a worker behind arachnefly; **not** a tenancy boundary. webrain's own
`docs/PLATFORM_EXPOSURE_PLAN.md` agrees — webrain may never have ingress.

Client side was already correct: `functions/src/infrastructure/webrain-mcp.ts` sends
`Authorization: Bearer <token>` (`authHeaders`), resolving the token per call via
`webrainMcpToken()` so a Secret Manager rotation reaches the next request.

**THE UNCOMMITTED GATE — the most important fact in this section.** `git show
HEAD:webrain-mcp/src/lib.rs | grep -c WEBRAIN_HTTP_TOKEN` → **0**, and likewise for tag
`v0.8.0`. The bearer gate, `/health` and `WEBRAIN_NO_STATE` exist **only as dirty working-tree
changes**. Every tagged release is therefore an unauthenticated engine on every route, and any
deploy built from a tag or from CI — rather than from this working tree — ships with no auth
at all. Nothing in the repository prevents that; the guard added above constrains only code
that is actually committed.

### Engine matrix

Source: webrain's own `skills/webrain/references/browser-selection.md`.

| Engine | JS | SPA | Screenshots | Batching |
|---|---|---|---|---|
| Chrome | yes | yes | yes | parallel tabs |
| Obscura | yes | no | yes — v0.2.0+ render builds (+ PDF) | parallel tabs |
| Lightpanda | yes | no | **placeholder PNG** | sequential |

`install_obscura(force, stealth, render)` publishes four build variants, which is why the
render build exists. Lightpanda's screenshot is a placeholder image, so the failure mode is a
plausible wrong image rather than an error — **gate frames in code**.

Page-state routing: `PROTECTED + CHALLENGE → real Chrome + human-in-the-loop`. That is the
live-view paid use case.

### Obscura itself — what it is, and the glibc trap (verified 2026-10-03)

**Upstream is `h4ckf0r0day/obscura`.** That is the literal URL in
`webrain-core/src/install.rs`: `https://api.github.com/repos/h4ckf0r0day/obscura/releases/latest`.
Any document citing a different repo for "obscura" is describing something else, or is wrong.

- Latest release is **v0.2.3, 20 assets** = 4 variants × 5 platforms
  (win-x86_64, mac-x86_64, mac-aarch64, linux-x86_64, linux-aarch64). The variants are
  `{,-stealth,-no-render,-no-render-stealth}`, exactly the suffix logic `install_obscura` uses.
  webrain's comment says "v0.2.0 ships 4 packages per platform" and its fallback tag is
  `v0.1.11` — both are older than what is actually published.
- **`install.rs` line 218 lies.** Its comment reads "(obscura ships only x86_64-windows)", but
  the function directly below maps five platforms and the doc comment twelve lines down says
  "Windows assets are .zip; linux/macos are .tar.gz". The parenthetical is stale; the code is
  right. **Do not quote that comment as a constraint.**
- **THE LINUX BINARIES ARE GLIBC, NOT MUSL.** `release.yml` builds
  `x86_64-unknown-linux-gnu` on `ubuntu-22.04`, so they need **glibc ≥ 2.35**, and obscura's own
  image runs them on `gcr.io/distroless/cc-debian12:nonroot`. On Alpine this fails *after* a
  successful download, at exec, because `/lib64/ld-linux-x86-64.so.2` is absent — so it surfaces
  the first time a session needs Obscura rather than at build time. Debian bookworm (glibc 2.36)
  and Ubuntu 22.04+ work; bullseye (2.31) does not.
- **The worker model is shipped, not marketing.** Every tarball contains **both `obscura` and
  `obscura-worker`**, and `release.yml` builds `-p obscura-cli --bins`.
- **The CDP entrypoint is `obscura serve --port 9222 --host 0.0.0.0`**, and webrain both knows it
  (`main.rs:910` prints `Obscura: obscura serve --stealth`) and can spawn it
  (`webrain_core::launch::launch_obscura`).
- **Correction to the earlier "CDP has no authorization" note.** It has `OBSCURA_CDP_TOKEN`, and
  upstream requires it for any non-loopback bind — "publish to host loopback as an additional
  boundary". The conclusion is unchanged, the mechanism is now named.
- **Untrusted page JavaScript runs in-process through V8.** Upstream's stated reason for running
  nonroot is that a V8 exploit then lands with the process's privileges. For a multi-tenant pool
  this is the strongest available argument that an isolation unit must be a **process**, not a
  context in a shared one — which is what invariant I2 already requires.

### Degradation signals — which path emits which (verified 2026-10-03)

webrain has **four** page-quality signals, and the bare fact that governs the escalation ladder is *where
each one is emitted*. They are not one family.

| Signal | Set where | Available on the browserless path? |
|---|---|---|
| `needs_js` | `webrain-mcp/src/lib.rs:243` — `v["needs_js"] = json!(tools::probe_needs_js(&html))` | **yes** — it is the only one |
| `challenge` | `cdp.rs:1486`, `cdp.rs:2396`, `browser.rs:411` | **no — but only because nobody calls it** |
| `crippled` | same three sites | **no, and genuinely cannot be** |
| `chrome_error` | same three sites | **no — but only because nobody calls it** |

- **`needs_js` is a raw-HTML heuristic and it has a real blind spot.** `probe_needs_js` returns true if the
  HTML contains any of `"enable javascript"`, `"javascript is required"`, `"javascript is disabled"`,
  `"enable js"` — **or** if `visible_text_len(html) < 100 && l.contains("<html")`. A Cloudflare deny page
  ("Error 1020", `cf-error-code`) has ample visible text and none of those four phrases, so it returns
  **`false`**: a blocked page reports as a clean fetch. `needs_js` detects *JS shells*, not *blocks*.
- **`challenge` is a pure string classifier and needs no browser.** `detect_antibot(title, text)` matches on
  `format!("{title}\n{text}")` lowercased — STRONG markers (`__cf_chl`, `challenge-platform`,
  `cf-error-code`, `h-captcha`, `g-recaptcha`), one hit is enough; then WEAK phrases
  (`checking your browser`, `just a moment`, `verify you are human`, `access denied`, `forbidden`) of which
  **two** must corroborate, so a support article that merely says "forbidden" is not misread as a block.
  Its own comment: *"No HTML/network."* Its three call sites are all browser-path, which is a gap in the
  caller, not a limit of the classifier.
- **`crippled` is the one that truly needs a browser.** It is
  `elements_ok && detect_crippled(&challenge, elements.len())` — it consumes an interactive-element count, so
  there is no browserless version of it.
- **`chrome_error`** (`detect_chrome_error(title, text)` → an `ERR_*` code or `"CHROME_ERROR"`) also needs
  only title+text, and exists so an error page is not scraped as content.
- **Do not port the marker list to TypeScript and match it against `text`.** `__cf_chl`,
  `challenge-platform`, `cf-error-code`, `h-captcha` and `g-recaptcha` live in attributes, classes and URLs,
  so they do not survive into *visible* text. A platform-side reimplementation would match nothing and look
  correct while doing so.
- **Three different things are called `status`, and conflating them is easy.** A captured `webrain_scrape`
  payload carries `status: "ok"` at the top level *and* `result.status: 200` inside it — and
  `WebrainToolResult.status` in `functions/src/infrastructure/webrain-mcp.ts` is a **third** value: the HTTP
  status of the call *to webrain's MCP endpoint*, `0` when the connection itself failed, with non-2xx
  treated as an error before the payload is parsed. So the platform's `status` is **transport, not the
  page**, and a health check reading it is answering a different question than it looks like.
- **The page's own status is on the wire and nothing reads it.** `json.result.status` is in the captured
  payload, so a `403`/`503` block is distinguishable **today, with no webrain change** — a cheaper first
  step than waiting on `challenge`, which needs the engine edited. It also catches blocks that
  `needs_js` misses and that a challenge-marker list might not name. `webrainPayloadSignals` does not read
  the field yet; it is the next one to add, precisely because it needs no cooperation from webrain.

---

## Phase 1 §1.2 — the session store (shipped 2026-10-01)

Anchors, verified by running them:

- `functions/src/domain/browser-session.domain.ts` — `SESSION_STATES`, `BrowserSessionRecord`,
  `BrowserSessionPublic`, `toPublicSession`, `idleDeadlineForTier`, `initialStateFor`, `cdpSecretId`.
- `functions/src/infrastructure/browser-session.store.ts` — `BROWSER_SESSIONS_COLLECTION`,
  `sessionsRef`/`sessionRef`, `parseSession`, and five operations
  (`create` / `read` / `list` / `keepalive` / `close`).
- Path: `users/{uid}/browserSessions/{sessionId}`, built from
  `db.collection("users").doc(uid).collection(...)` — `db` is the singleton from `../app/config`.
- Gate: `TSC_EXIT=0`, `LINT_EXIT=0`, `TEST_EXIT=0` — 462 tests, 453 pass, 0 fail, 9 skipped.

Three things not worth re-deriving:

- **`expiresAt` and `idleDeadline` are one value.** The plan used both names. The record stores
  `idleDeadline`; the public shape calls it `expiresAt`. Do not add a second field.
- **A zero idle TTL omits the deadline.** `free` and `admin` carry `idleTtlMs: 0`. Storing
  `lastUsedAt + 0` would put the deadline in the past and a reaper would expire every free session
  immediately. `idleDeadlineForTier` returns `undefined`, and `toPublicSession` then omits `expiresAt`.
- **The BYO secret is per user, not per session** (`browser-cdp-${uid}`), so `closeBrowserSession`
  does not purge it — another session may still be attached. Clearing BYO config is separate (§1.7).

### Store-file lint requirements (cost 3 passes)

- `valid-jsdoc` demands `@param` and `@return` on **every** function, including module-local arrow
  consts such as a ref helper. `@return {*}` is the accepted form for a Firestore reference.
- These store files carry `/* eslint-disable max-len */` on line 1, exactly as
  `storage-settings.store.ts` does. Prose comments in a long header will otherwise break the 80-col
  rule, and fixing them one line at a time does not converge.

### FIXED 2026-10-02 — the session cap was a TOCTOU, so it was not a cap

`browserSessionCreate` read the live sessions, ran `decideLease`, then called `createBrowserSession`,
which wrote a **freshly UUID'd** document. Read, decide, write — with nothing between them. Two
concurrent POSTs both read the same count, both passed `decideLease`, both wrote.

Blast radius: a tier capped at **one** dedicated session could hold several, each with its own Fly
machine and its own deploy. The route's guard chain is `access` + `perm('crawl','execute')` — there is
**no idempotency key and nothing serialising a caller**, so a double-submit was enough to exceed the cap.
What the cap fails to bound is platform compute, i.e. money.

The fix is one transaction in the store, which now **owns** the decision:

```ts
return db.runTransaction<CreateBrowserSessionResult>(async (transaction) => {
  const snapshot = await transaction.get(sessionsRef(input.uid))
  const decision = decideLease({..., liveSessions: countLive(snapshot), ...})
  if (!decision.ok) return {ok: false, reason: decision.reason}
  transaction.set(sessionRef(input.uid, id), record)
  return {ok: true, session: toPublicSession(record)}
})
```

Four things not worth re-deriving:

- **Reading a query inside a transaction is what makes it atomic.** A concurrent insert changes the
  *result of that read*, so Firestore aborts and replays the second transaction, which then sees the
  first session and refuses with `quota`. `transaction.get(CollectionReference)` takes the
  `Query` overload and `tsc` accepts it — verified, `TSC_EXIT=0`.
- **Nothing with a side effect may live in the transaction body**, because contention re-runs it from
  the top. That is why `upsertSecretValue` (Secret Manager) stays OUTSIDE. Cost, stated rather than
  hidden: a BYO request that loses the race to `quota` has already stored its own endpoint, under its
  own uid, at a path keyed by uid, with the value it just sent. Benign, not a leak.
- **The count must NOT be passed in.** A count passed down was read before the transaction — that is the
  race itself. The route still calls `decideLease` first, but as a **pre-flight only**: it preserves the
  order refusals are reported in and avoids storing a credential for a plain refusal. Both checks return
  the same `decideLease` reason, so `refusalFor` maps them identically and the caller cannot tell which
  answered.
- **The filter is written once.** `isLive` (a type predicate, so it narrows) is shared by
  `listBrowserSessions` and the transactional `countLive`. Two copies of "not closed" would let the
  enforced rule drift from the pre-flighted one.

One residual: after exhausting Firestore's retry on a hot conflict the handler's `catch` answers 500
rather than 403 `quota`. Contention here is a single caller double-submitting, so this is rare — and it
is arguably the honest answer, since the platform genuinely could not decide.

**NOT VERIFIED — and this is the important caveat.** The suite is byte-identical before and after
(510 tests, 501 pass, 0 fail, 9 skipped), which means **no test exercises `createBrowserSession` at all**
— the store builds the Admin SDK on load, so it needs an emulator. The atomicity above is therefore
argued from Firestore's documented semantics and type-checked, but **unproven**. Proving it wants either
the Firestore emulator or two concurrent POSTs against a real project.

---

## arachnefly's real scope — machines yes, sessions NO (verified 2026-10-01)

All 13 routes, read from `interfaces/controller/router.go`:

- `GET /` (Welcome), `GET /metricsgraph`, `GET /404`
- Machine lifecycle: `GET /machine/:id`, `GET /machine/proxy/:id`, `GET /machine/waitforstate/:id`,
  `POST /execute-task/:machine_id`, `PUT /machine/:id/{start,suspend,stop}`, `DELETE /machine/:id`,
  `GET /check-image`, `POST /deploy`
- `GET /user/:id`

**No session record, no session state machine, no CDP handling, no caps.** arachnefly is the machine
plane: lifecycle + the container proxy + the machine registry. Browser **sessions** live in deepscrape —
`functions/src/domain/browser-session.domain.ts`, `infrastructure/browser-session.store.ts`, and
`/api/browser/session*` in `bff/api.ts`.

**The one deliberate exception: the reaper (§1.5).** It must run in-process because a Cloud Function
cannot mint an owner ID token, so arachnefly *reads* `browserSessions` to suspend machines. It reads; it
does not own. This creates a cross-repo schema dependency — see the drift risk below.

## `FLY_APP` is a NAMESPACE — the image is per-deployment (verified 2026-10-01)

`Global.GetImageSource(imageOption, machineConfig)` (`infrastructure/routines/global.go:292`):

```
case "default": return machineConfig.DefaultImage, nil
case "clone":   return machineConfig.CloneMachine, nil
case "url":     return h.DecodeImageName(machineConfig.DockerHubUrl)
case "upload":  return machineConfig.Dockerfile, nil   // TODO comment in live code
```

`machineConfig` is `c.BodyParser(machineConfig)` in `DeployMachine` — **the caller's request body**.

- So the Fly app was never crawl4ai-specific. crawl4ai was a *value of `DefaultImage`*, not a property of
  the app. Freezing crawl4ai changes a request value, **not the app**.
- `"default"` does NOT mean "baked into arachnefly" — it means "whatever the caller sent".
- **"webrain is the default provider" must be implemented in deepscrape**, in whatever builds the deploy
  body. arachnefly cannot enforce a provider default; it resolves what it is handed.
- **Risk, not yet investigated:** the caller chooses the container image (`"url"` → `DecodeImageName`).
  Phase 0.3 fixed the registry *probe* SSRF; the **deploy** path still accepts an image string from the
  caller. That is a supply-chain surface — an arbitrary image pulled into the platform's Fly app.
- `"default"` has no validation: an empty `DefaultImage` flows straight to Fly.

## Three apps, three scaling policies (design decision, 2026-10-01)

| App | Posture | Scaling unit | Runs |
|---|---|---|---|
| arachnefly | public API | instances | the orchestrator |
| the machine app (`FLY_APP`) | **private**, per-tenant | machine count per tier | webrain + bundled browser, one VM per user |
| shared stateless webrain | **private** | instances | `WEBRAIN_NO_STATE=1`, stateless tools only |

- The machine app is a **fleet, not a service**. Machines are reached only through arachnefly's
  owner-checked `GET /machine/proxy/:id`; **no public ingress**, not even for live view.
- `WEBRAIN_NO_STATE=1` is the *enforcement* that makes a shared worker safe: it refuses `webrain_launch`
  (it is in `STATEFUL_TOOLS`), so a shared process physically cannot start a browser.
- **Never one shared webrain serving browser sessions.** `session_id` is taken verbatim (`lib.rs:1236`),
  `webrain_session(op=list)` enumerates every session and its `cdp_url` (`lib.rs:1276-1288`), and there is
  one process-wide secret with no caller identity (`lib.rs:84`). **The insecure unit is the webrain
  PROCESS, not the browser.**
- One app per workload because **scaling policy is per-app**: `fly.toml`/`fly-autoscaler.toml` set one
  policy, and `ListFlyMachines` + `syncMachines` reconcile every machine in the app together. Long-lived
  browser machines and ephemeral crawl machines want different autoscale behaviour.
- Not verified: the mechanics of "internal" on Fly (private DNS within an org, releasing public IPs).
  Asserted as a principle, not confirmed against Fly's docs.

## §1.5 reaper — state as of 2026-10-02

Built and green: `domain.DecideReap` + 5 tests, `infrastructure/reaper.Reap` + 7 tests,
`interfaces/repository/browser_sessions.go` (`DueBrowserSessions`, **untested — needs an emulator**),
`domain.BrowserSession.DocPath`, and the `COLLECTION_GROUP` index on `idleDeadline`.

Load-bearing rules, each with a test:
- **Suspend the machine BEFORE closing the session.** Inverted, a session whose suspend failed is marked
  closed, the next pass skips it, and the machine runs forever with nothing pointing at it.
- **`idleDeadline <= 0` means NO expiry** (free/admin write 0). Reading it as a past instant would suspend
  every unlimited session on the first tick.
- A BYO session is never reaped; `suspended` is not special-cased into a skip.

**DONE 2026-10-02 — the reaper is wired end to end.** `NewFirestore(db, flyApiToken, flyApp, flyApiUrl)`;
`*Firestore` implements BOTH `reaper.Sessions` (`DueSessions`) and `reaper.Releaser` (`SuspendMachine`,
`CloseSession`), so the synchronizer passes the same value twice rather than wrapping it;
`Synchronizer.reapIdleSessions` runs on the EXISTING cron beside `syncMachines` and logs the report;
`main.go` injects the two values. Gate green: gofmt clean, BUILD/VET/TEST 0.

Three things to know before trusting it:

- **The switch is thrown in source.** Deploying arachnefly arms a job that suspends machines every minute.
  It is inert in practice until §1.4 lands — nothing writes `machineId` yet, so every dedicated session
  hits `DecideReap`'s `no-machine` branch and is held. That is luck, not design: the moment §1.4 attaches
  machines, this job starts acting.
- Two independent gates protect a LIVE session: the query returns only sessions past `idleDeadline`, and
  `DecideReap` (8 tests) re-filters closed / byo / no-machine / no-deadline / live. A wrong field name
  makes the query match nothing — a money leak, never an outage.
- `SuspendMachine` refuses to act when `FLY_APP` is empty, because a blank app builds
  `/apps//machines/<id>/suspend`, which Fly 404s — that reads as transient and retries forever.

`DueSessions` is still **untested**: `interfaces/repository` has no test files and needs an emulator, so
`BUILD_EXIT=0` proves it compiles and nothing more. Its three silent-failure strings are the collection
name `"browserSessions"`, the field `"idleDeadline"`, and that the value is epoch MILLIS (a number), not
a Firestore Timestamp.

### Cross-repo drift risk (OPEN — created by the reaper)

`arachnefly/domain/browser_session.go` mirrors `browser-session.domain.ts`. Nothing enforces agreement on
`mode`/`state`/`machineId`/`idleDeadline`, or the value vocabularies (`dedicated`/`byo`,
`starting`/`ready`/`suspended`/`closed`). The reader queries on those names, so a rename in one repo makes
the other **match nothing, with no error** ⇒ machines never reaped ⇒ unbounded cost. A test cannot span
two checkouts cleanly. Cheapest mitigation: log `Report.Considered` every tick, so "always 0 while
sessions demonstrably exist" is visible.

---

## Fly Machines API rate limits — the platform's real capacity ceiling (2026-10-02)

From `docs.fly.io/machines/api/working-with-machines-api`: limits are **per-action, per-machine**, scoped
by identifier — Machine ID or App ID depending on the request. **1 req/s per action, burst 3.** The single
exception is Get Machine at **5 req/s, burst 10**. App deletions: 100/min.

**`Create Machine` is scoped by APP**, because no machine exists yet — and every tenant shares ONE Fly app
(`FLY_APP`). So the whole platform can create **~1 machine per second, burst 3.** There is no queue, no
backoff and no retry anywhere in the deploy path, so concurrent session creation will 429.

Machine-scoped actions (start/stop/suspend/destroy) are scoped per MACHINE, so the reaper is **not**
exposed: it suspends many distinct machines, each with its own 1/s bucket.

Also worth knowing: `202 Accepted` is a success code, `422` is validation failure, `408` is a timeout, and
there is a separate internal base URL `http://_api.internal:4280` reachable from inside the WireGuard
network — arachnefly runs on Fly, so it could use that instead of public egress. `main.go` currently
hard-codes `https://api.machines.dev/v1`.

### FIXED 2026-10-02 — `FlyRequest` never read the status code

`infrastructure/routines/global.go` `FlyRequest` checked **only** the fasthttp transport error. It then
parsed the body as a JSON object, and returned success if there was no `"error"` key; if the body did not
parse at all (empty, as with `204`) it also returned success, with an empty map.

⇒ **Any non-2xx whose body is not literally something with an `error` key was reported upward as
SUCCESS.** A Fly 429 during deploy reached the platform as a confusing 500 ("Failed to get machine ID")
with the real cause invisible — the worst possible shape, because it reads as a bug in our code rather
than as a rate limit.

Now non-2xx returns an error carrying the status and Fly's body, and logs it. **2xx behaviour is
deliberately unchanged**, including the empty-map return for a body that does not parse — a `204` depends
on exactly that. Two `println` lines that fired on every response (dumping the whole response header map)
were removed.

### DONE 2026-10-02 — the upstream status now survives to the caller

`FlyRequest` returns a typed `*FlyAPIError{StatusCode, Body}` for non-2xx, and `routines.UpstreamStatus(err)`
maps it: **429 is carried through**, everything else keeps the 500 these handlers always returned. Applied
to `DeployMachine` and `SuspendMachine` — the two on the browser-session path. **`StartMachine`,
`StopMachine` and `DestroyMachine` still answer a flat 500** and are the remaining follow-on.

The restraint is deliberate: passing Fly's own 401/403 upward would blame our caller for OUR token, and
moving everything else to a 502 would change behaviour for a client that never asked. `errors.As` rather
than a type assertion, so a caller wrapping the error with `%w` cannot lose the rate limit — there is a
table test for exactly that case.

On the deepscrape side a deploy failure carrying `status === 429` answers **503 `capacity_unavailable`**
instead of 502 `deploy_failed`, and the close path does the same for a throttled suspend (still leaving the
session OPEN so the reaper retries). Both in `handlers/browser-sessions.ts`.

### DONE 2026-10-02 — a bounded retry on 429, in the deploy path only

`deployBrowserMachine` now retries on **429 only**, twice, after 1s and then 3s
(`DEFAULT_DEPLOY_RETRY_DELAYS_MS`). Nothing else is retried: a broken image or a rejected token fails
identically however many times it is asked, so retrying those would only spend the caller's latency and
multiply our own load.

**Retrying this call is safe, and the reason is worth stating.** The machine is named from the session id
and Fly requires a name to be unique within an app, so a retry cannot produce a second machine — the worst
it can do is be refused for the duplicate name. That property is what makes a blind retry acceptable on
this call and nowhere else in the platform.

The delays are injectable (`retryDelaysMs`; `[]` means one attempt, no retry), so the four retry tests
exercise the policy without sleeping.

**Still absent: a queue.** The retry rides out a burst — three CREATEs are allowed, then one per second —
but a sustained backlog of session creation still 429s and the caller gets `capacity_unavailable`. Queueing
that is a real infrastructure decision (QStash, or in-process with ordering) and has not been made.

### What `execute-task` actually is (verified 2026-10-02) — and why it is NOT the missing join

Read before trusting it, because its name invites a wrong conclusion. arachnefly's `ExecuteTask` does not
execute anything. It relays the caller's JSON to a **hard-coded** URL:

```go
taskUrl := fmt.Sprintf("https://%s/crawl", h.flyApp+".fly.dev")
FlyRequest("POST", taskUrl, MachineExecute,
    map[string]string{"fly-replay": fmt.Sprintf("instance=%s", machineId)}, nil)
```

So it is a **crawl-task forwarder**: it drives the crawl4ai `/crawl` contract, pinned to one machine by
Fly's `fly-replay: instance=<id>` header, over the app's **public** hostname rather than the machine's
private IP. The body is an unvalidated `map[string]interface{}` passed straight through.

**Not webrain's MCP surface. Not CDP. Not a shell.** An earlier version of `docs/BROWSER-SESSIONS-EXPLAINED.md`
recommended a session-scoped `POST /api/browser/session/:id/execute` built on this; that would have named a
machine and driven the **wrong service**, which is worse than the gap it closed. Corrected.

The genuine missing link is the one roadmap `06` already names — `GET /machine/proxy/:id`, which has **no
handler in `handlers/machines.ts`** — or a per-machine webrain URL, which nothing derives (`WEBRAIN_MCP_URL`
is a single global value with no default). Both decide the shape of access, so they belong to roadmap `03`.

### DONE 2026-10-02 — `ExecuteTask` no longer lists every machine to log them

`ExecuteTask` called `machines.NewClient(...).List({State: Started})` on **every invocation**. Nothing read
the result: it fed a `for` loop that only called `log.Println`, and the `machine` map the code actually uses
comes from `GetMachineDetails` above it (the loop shadowed it, which is what made the dead call look live).

Two real costs, both now gone:

- A failure in that list turned a **working** execute-task into a 500, for a value no one consumed.
- Every call spent an **app-scoped** Fly API request. The Machines API allows 1 req/s per APP (burst 3) and
  `Create Machine` shares that bucket — so a needless list on every task competed directly with deploys.

### Gap: `WaitForState` is unused by §1.4

`attachMachine` moves a session to `ready` as soon as a machine id exists. The container may still be
booting — `ready` means "has a machine", not "accepting connections". `GET /machine/waitforstate/:machineId`
exists in arachnefly, is ownership-checked, and is unused. It is the honest fix.

Read before using it (verified 2026-10-02): the handler requires `state` **and** `instance_id` as query
params — 400 without either — and forwards to Fly's own `GET .../machines/{id}/wait`, which Fly
long-polls. So it costs **one** app-scoped Fly request per use, not a poll loop. `instance_id` is the
machine's version id, which nothing stores today.

---

## The machine contract — what `BuildConfigMap` demands of an image (verified 2026-10-02)

`infrastructure/routines/global.go:231` builds the Fly config for every machine. Four things are
hard-coded, and an image must satisfy all four:

| Contract | The value in source | Consequence |
|---|---|---|
| `internal_port` | the `PORT` **env var**, else `11235` | the image must listen on the port we send, or on arachnefly's default |
| process entrypoint | `processes: [{"entrypoint": ["app"]}]` | Fly runs a program named `app`; the image's own ENTRYPOINT is overridden |
| health check | `checks.httpget` → `GET /` on that port | a non-2xx answer makes flyd restart the machine |
| env | `BuildEnvVars(machineConfig.EnvironmentVariables)` | whatever the deploy request sends — and **we send none** |

Also in that config, and relevant to cost and to Phase 0 §0.3: `auto_destroy: false`,
`restart.policy: "always"`, `guest` from cpu/memory, and **two** services — one on the routed port
(exposing 80 with force_https, that port, and 443) and **one on 6379 (Redis)**, which §0.3 says must be
dropped. There is no `mounts`, so a machine has **no volume**.

### webrain's image does NOT satisfy it — four mismatches

Read out of both sides rather than inferred:

1. **Port.** webrain's Dockerfile is `CMD ["mcp","--http","9223"]`; `internal_port` would be 11235.
2. **Bind.** `webrain-cli/src/main.rs` resolves the address as `WEBRAIN_HTTP_ADDR` or
   **`127.0.0.1:<port>`** — loopback by default, so even on a matching port it is unreachable through
   Fly's proxy.
3. **Entrypoint.** No executable named `app` exists in webrain's image — and the glibc base move discussed
   above does not add one. The adapter ships it.
4. **Health check.** webrain answers `/health` and **only** `/health` — "Deliberately the ONLY extra
   route." A `GET /` therefore reaches MCP dispatch and returns 401 (once a token is set) or an MCP
   error. It can never be 2xx, so the check can never pass.

The `WEBRAIN_HTTP_TOKEN` interaction is the trap in the middle of all that: `run_http` refuses to start
on a **non-loopback** bind with no token (`0.0.0.0` and `[::]` count as exposed). So "fix the bind" and
"forget the token" converts *unreachable* into *crash loop* — and with `restart.policy: always` plus
`auto_destroy: false` that loop never resolves. The default, with no env at all, is neither: it binds
loopback, starts happily, and answers nothing on the routed port. **Order matters: token first, then the
bind.**

**Answer to ADR-2026-10 §4 — "does the per-image contract hold? Unverified in both repos": no, and it is
worse than the port.** Fixed for the session path by `deploy/browser-session/`, an adapter image, which
is the option that does not change a live-traffic service.

### The webrain image is not published

`ghcr.io/prokopis3/webrain` — the name in webrain's own Dockerfile comment — returns **403** to an
anonymous GHCR manifest request, against a 200 control (`astral-sh/uv`). Private or absent, either way
not pullable, so `BROWSER_MACHINE_IMAGE` cannot point at it today. The only publicly-proven image
remains the crawl worker in `DEFAULT_IMAGES` (`registry.fly.io/crawlagent:…`), which is not a session.

### No `mounts` ⟹ on-demand engine downloads repeat forever

Fly resets a stopped machine's root filesystem to its original state, and a session machine has no
volume. webrain installs Lightpanda and Obscura **on demand** into its engine cache (~123 MB for
Lightpanda), so with no volume that download is paid by **every cold start**. Bake the engines into the
image instead: `webrain install obscura` and `webrain install lightpanda` are real CLI subcommands
(`webrain-cli/src/main.rs`, `Some("install")`), and Obscura's default package is the **render** build —
the `--no-render` variant silently serves no frames.

### `SCRAPE_PROVIDER` defaults to a provider with no URL

`SCRAPE_PROVIDER` defaults to `"webrain"` while `WEBRAIN_MCP_URL` has **no default**. A deployment that
sets neither has a broken default scrape path: every `/api/crawl` asks a provider whose URL is empty,
and nothing validates it at boot. Either set `WEBRAIN_MCP_URL` in production or set
`SCRAPE_PROVIDER=crawl4ai` explicitly.

---

## `deploy/browser-session/` — the adapter, VERIFIED in a container (2026-10-02)

Built and run locally against a stub upstream, so every row below is an observation rather than an
argument. The stub is a second nginx on `127.0.0.1:9223` standing in for webrain; nothing in the adapter
cares which process answers there.

| Assertion | Observed |
|---|---|
| `GET /` (the check `BuildConfigMap` configures) | **200** `{"status":"ok"}` |
| `GET /mcp`, no `Authorization` | **401** — the gate fires |
| `GET /mcp`, any bearer | **200** and the body came from the upstream — so the proxy forwards |
| `GET /health` | **200**, body from the upstream — proxied, and NOT behind the gate |
| listening sockets | `0.0.0.0:11235` only, upstream on `127.0.0.1:9223` |
| `PORT=9999` | **exit 64**, with the reason in the log |
| no `WEBRAIN_HTTP_TOKEN` | **exit 78**, with the reason in the log |
| a child process dies | the container **exits 1**, so Fly restarts it |

The last row was observed by accident, and it is the most reassuring one. The first stub used
`busybox httpd`, and this image's busybox has no `httpd` applet — `httpd: applet not found`. That looked
like a failure and was the supervise loop doing its job: it noticed the dead child and stopped the
machine rather than pretending to serve.

Two limits, stated rather than glossed:

- **The real webrain binary inside this image is NOT verified** — only the adapter is. The stub cannot
  exercise `webrain install obscura` / `webrain install lightpanda`, and it ignores
  `WEBRAIN_HTTP_ADDR`, so the loopback bind above is the stub's own `listen`, not webrain's resolution.
- **The auth gate is presence-only.** That `200` for `auth /mcp` is the *stub* answering; against real
  webrain a wrong token is a 401 from webrain. The adapter never validates the token, and says so.
- **The base image changed on 2026-10-03, so the install layer is now re-verified only in isolation.**
  `apk add --no-cache nginx` became `apt-get install nginx ca-certificates`, because obscura's Linux
  release is glibc and Alpine is musl (see the Engine-matrix section above). Re-verified on the base the
  change requires: `debian:bookworm-slim` → `nginx/1.22.1`, **glibc 2.36** (≥ the 2.35 obscura needs),
  exit 0. The other rows are config-level — they describe `nginx.conf` and `entrypoint.sh` — so they still
  hold; what changed is the base and the package-manager line. A full re-run needs a **glibc stub** image,
  which does not exist yet because webrain's own image still cannot build.

## webrain's own Dockerfile does not build (verified 2026-10-02)

Step 1 of the documented image sequence — "webrain publishes its own image" — **fails today**:

```
#20 ERROR: process "/bin/sh -c cargo build --release --bin webrain ..." did not complete successfully: exit code: 101
  icu_properties_data@2.2.0 requires rustc 1.86
  icu_provider@2.2.0 requires rustc 1.86
  idna_adapter@1.2.2 requires rustc 1.86
  image@0.25.10 requires rustc 1.88.0
  time@0.3.54 requires rustc 1.88.0
  time-core@0.1.9 requires rustc 1.88.0
```

`docker/Dockerfile` pins `FROM rust:1.85-alpine`, deliberately, and its comment says why — "not a floating
`latest` ... so rebuilds are reproducible". The pin is now **older than what the lockfile resolves to**, so
every rebuild of that image fails. Cargo's own suggestion is `cargo update <name> --precise <ver>`, i.e.
downgrade six crates to suit a stale toolchain, which is the wrong direction. Bump the base instead — but
to **`rust:1.88-slim-bookworm`, not `rust:1.88-alpine`**. Alpine was my earlier answer and it is wrong for
this image: the same container has to exec obscura, whose Linux release is `x86_64-unknown-linux-gnu`
(glibc), so a musl base fails at exec, per session, rather than at build. One base change removes the rustc
pin, the musl/glibc mismatch, and `apk` together.

**NOT VERIFIED: that bumping the base fixes it.** The diagnosis is Cargo's verbatim output; the fix is the
obvious one and untested, because confirming it costs another full release Rust build.

Same file, lesser trap: the cache mount id is `webrain-target-$TARGETARCH`, and a plain `docker build`
(not buildx) leaves `$TARGETARCH` undefined. BuildKit warns `UndefinedVar` and the id becomes the literal
`webrain-target-`. Harmless for correctness — but the comment claims the cache is keyed per arch to stop
amd64/arm64 artifacts mixing, and under plain `docker build` it is not.

Also: `target/release/webrain.exe` exists in the checkout and is a **Windows** binary, so it cannot be
dropped into a Linux image. Worth knowing before reaching for it as a shortcut.

---

## Gates

Run the gates for every repo you touched. Print the exit code immediately after each command.

```bash
# Firebase Functions
cd functions && bun x tsc --noEmit && bun run lint && bun run test

# Bun + Elysia BFF
cd bff && bun x tsc --noEmit && bun test

# Angular app — tsc, then the ONLY template validator
bun x tsc --noEmit -p tsconfig.app.json && bun run build

# Angular unit specs. `ng test` alone watches forever.
bun x ng test --watch=false

# arachnefly (Go). `go` is on PATH: GOROOT=C:\Users\proko\go, GOPATH=C:\Users\proko\gopath.
go fmt ./... ; go vet ./... ; go test ./...

# webrain (Rust)
cd ../Rust/webrain && cargo fmt --all -- --check \
  && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace
```

### Traps

- **`get_errors` is not evidence.** It reported "No errors found" on two files that could not
  compile. Gate structural edits with `bunx tsc --noEmit -p tsconfig.app.json`.
- **`bun run build` is the only template validator.** `tsc` never parses templates; Karma only
  compiles components some spec imports. A template error in an unspecced component passes
  both. Also grep `*/` under `src/**/*.html` — an HTML comment closed with `*/` instead of `-->`
  truncates the template, and Angular reports the error on the **last** line with misleading
  `NG8113 "X is not used within the template"` warnings.
- **Exit codes after `;` or a pipe belong to the last command.** Run the build as its own
  command, or first, and print `"EXIT=$LASTEXITCODE"` right after it. Angular budget violations
  print `✘ [ERROR]` yet still write the artifact, so "Output location: …" is not evidence of
  success — only the exit code is.
- **A command that does not exist leaves `$LASTEXITCODE` at its previous value.** Running
  `go build ./...` on a machine with no `go` on PATH printed `BUILD_EXIT=0` while nothing had
  run. Confirm the tool executed before believing its exit code — same family as reading an exit
  code after a pipe.
- **Never batch two edits to one file in a single tool block.** It has silently corrupted files
  twice in this repository.
- **`bun run build` can exit 127** when Google Fonts inlining fails offline.
- **Never print secrets.** No `.env`, no `gcloud ... describe` with `environmentVariables`
  (it echoes cleartext), no `printenv`. Project explicitly:
  `--format=json(name,state,serviceConfig.timeoutSeconds,serviceConfig.availableMemory)`.
