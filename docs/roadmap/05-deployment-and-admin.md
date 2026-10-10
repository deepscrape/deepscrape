# Deployment, secrets, and the admin console

Cross-cutting. Read this before shipping any phase.

---

# Part A — deployment topology

| Component | Runs on | Notes |
|---|---|---|
| Angular app | Firebase Hosting | SSR/prerender entry `src/main.server.ts`; 14 prerendered routes at last build |
| BFF (Bun + Elysia) | **Cloud Run** `deepscrape-bff` | the production API surface — `/api/*` lands here, *not* on the Express router |
| Functions | Firebase Functions v2 | callables + `onSchedule`; `lib/` is what ships, **not** `src/` |
| Machines | **Fly.io** | one app today; per-tenant app is Phase 4 |
| Artifacts | **Tigris** (S3) | private bucket for artifacts; `image-cdn-a.deepscrape.dev` is the **public** CDN and is a different bucket |
| Search | Meilisearch on Fly | `deploy/meilisearch/` |
| Cache / rate limit | Upstash Redis | |
| Payments | Stripe | |

**The BFF is the only API surface.** `functions/src/infrastructure/syncaiapi.ts` is a *library*, not
a second host: it exports `ReverseAPIProxy`, whose middleware the BFF imports and binds (`isJwtAuth`,
`requirePaidAccess`, `resolveAccess`, the org handlers). The `this.router.*` registrations inside that
class are **never mounted** — `functions/src/index.ts` imports no Express app, `functions/src/server.ts`
does not exist, and every `firebase.json` hosting rewrite goes to Cloud Run `deepscrape-bff`.
Verified 2026-10-01.

Consequence: adding a route to `bff/api.ts` requires **nothing** on the Functions side, and the earlier
version of this paragraph — which said a hand-written twin was mandatory and nothing fails if you
forget it — was wrong. The real Functions-side coupling is the handler modules the BFF imports
directly: `handlers/machines.ts`, `handlers/webrain-config.ts`, `handlers/contact_handler.ts`,
`handlers/home_handler.ts`, and `infrastructure/qstash`.

---

# Part B — the env and secret matrix

**I did not read any `.env` file while writing this** — only code, `fly.toml`, `docker-compose.yml` and
`env.ts`. Names only, never values.

| Process | Variable | Default | Required? |
|---|---|---|---|
| functions | `WEBRAIN_MCP_URL` | `""` — no host assumed, deliberately | yes, for any webrain route |
| functions | `WEBRAIN_MCP_TOKEN` | none | **yes in production** |
| functions | `TIGRIS_BUCKET` | `""` → falls back to GCS | yes, to migrate off GCS |
| functions | `TIGRIS_ENDPOINT` | `https://t3.storage.dev` | no |
| functions | `TIGRIS_REGION` | `auto` | no |
| functions | `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY` | none | yes when the bucket is set — **throws if missing** |
| BFF (Cloud Run) | `PRODUCTION`, `FUNCTIONS_ENV_JSON`, `FIRE_SERVICE_ACCOUNT_KEY` | — | exactly this set today |
| webrain machine | `WEBRAIN_HTTP_ADDR` | — | yes: `0.0.0.0:9223` in a container |
| webrain machine | `WEBRAIN_HTTP_TOKEN` | unset ⇒ **no auth** | **yes, always** |
| webrain machine | `WEBRAIN_NO_STATE` | unset | **yes on any shared worker** |
| webrain machine | `WEBRAIN_PROXIES` | — | the proxy pool on the **worker** side. Distinct from the platform's `WEBRAIN_PROXY_POOL` (comma-separated, read at `webrain-config.store.ts:178`), which is a different variable with a confusingly similar name |
| webrain machine | `CDP_URL` | `http://127.0.0.1:9222` | no |
| arachnefly | `FLY_APP`, `FLY_API_TOKEN` | none | yes |
| arachnefly | `PORT` | `11235` | the port machines listen on |

Three deployment facts that have cost time:

1. **`FUNCTIONS_ENV_JSON` is read through `getConfigValue`, which checks `process.env` first.** So local
   dev is plain env vars and production is the merged secret — same code path, no branch.
2. **The BFF's production env has no `WEBRAIN_MCP_URL` and no `QSTASH_*`.** So anything scheduled must run
   as an `onSchedule` function, not as a QStash delivery to the BFF — a queued delivery would 401. This is
   why the monitor drain is inline. Note the limit of that rule: `onSchedule` is correct for anything that
   authenticates with a **bearer secret** (the monitor drain uses `webrainMcpToken()`), and **wrong** for
   anything that must act as a **user** — arachnefly's machine routes verify a Firebase ID token and enforce
   ownership, so a reaper calling them from a schedule cannot work. See `02` §1.5.
3. **`functions/.env.dev` containing `PRODUCTION=true` together with `FIREBASE_AUTH_EMULATOR_HOST` is a
   live auth bypass** — the Admin SDK accepts unsigned `alg:none` tokens. A guard in `bff/security.ts`
   now throws on that combination in production. Do not remove it.

---

# Part C — deploy runbook

```bash
# app + functions
bun run prebuild          # dotenvx -> prod_gen.ts -> environment.ts (generated; never hand-edit)
bun run build             # ng build --configuration=production

# BFF — push an image; `--source .` tars thousands of files on Windows and is unreliable
docker build -t deepscrape-bff:local .
docker tag deepscrape-bff:local us-central1-docker.pkg.dev/libnet-d76db/deepscrape/deepscrape-bff:latest
docker push us-central1-docker.pkg.dev/libnet-d76db/deepscrape/deepscrape-bff:latest
gcloud run deploy deepscrape-bff \
  --image us-central1-docker.pkg.dev/libnet-d76db/deepscrape/deepscrape-bff:latest \
  --region us-central1 --allow-unauthenticated --port 8080 \
  --memory 512Mi --cpu 1 --min-instances 1 \
  --set-env-vars "PRODUCTION=true" \
  --set-secrets "FUNCTIONS_ENV_JSON=FUNCTIONS_ENV_JSON:latest,FIRE_SERVICE_ACCOUNT_KEY=FIRE_SERVICE_ACCOUNT_KEY:latest"
```

**Secret hygiene, non-negotiable:** never run `gcloud functions describe` with
`serviceConfig.environmentVariables` (or any projection including it) — it prints values in cleartext.
Use safe projections only:
`--format=json(name,state,serviceConfig.timeoutSeconds,serviceConfig.availableMemory,serviceConfig.maxInstanceCount)`.
Same for `gcloud secrets versions access`, `gcloud run services describe`, `firebase functions:config:get`.

---

# Part D — the admin console

## What already exists

| Piece | Where |
|---|---|
| Webrain admin page (MCP token + proxy pool) | `src/app/pages/admin/admin-webrain.component.*` |
| Its route | `src/app/routes/user/admin.route.ts` → `path: 'webrain'`, `canActivate: [adminGuard]` |
| Its nav entry | `adminNavigation` in `src/app/_nav.ts` (added this session — without it the page was unreachable) |
| Its API | `GET /api/webrain/config`, `POST …/token`, `POST …/proxies` guarded by `perm("platform", read\|write)` |
| Storage BYOB settings | account settings → Storage tab |

**The `platform` resource is granted to NO role in `POLICIES`** — only the `isPlatformAdmin`
short-circuit in `canPerform` admits it. That is deliberate and the same construction as
`suspend an account`. Keep it: platform config is not a grantable permission.

## What to add

| View | Backend | Frontend |
|---|---|---|
| **Machine fleet** | **BUILT 2026-10-03** — `GET /api/admin/machines`, gated `perm('platform','read')` | **BUILT read-only**: machine id (short) + name, owner uid, region, state, created, updated. Lifecycle actions are NOT offered — see the note below |
| **Live sessions** | **BUILT 2026-10-10** — `GET /api/admin/sessions`, gated `perm('platform','read')` | **BUILT read-only**: owner, mode, engine, state, idle minutes, minutes billed. Reclaim is NOT offered: it suspends another tenant's live, still-billing machine |
| **BYO Fly tenants** | Phase 4 resolver | per-org: app name, token state (`set` / `not set`), **never the token**; rotate + purge buttons |
| **Org billing / margin** | Phase 4.3 | org list, consumption, margin at their prices |
| **Worker health** | `/api/webrain/config` + a probe | last probe result, token state, `NO_STATE` state |

**CORRECTION (2026-10-03): the "Machine fleet" row above said the backend was `existing
/api/machines/*`. That is WRONG — there is no list route.** Every machine route is per-machine
(`GET /api/machines/machine/:id`, plus start / suspend / stop / destroy), and the Angular client already
wraps every one of them (`core/services/deployment.service.ts`, with a spec), so the *client* is not the
gap. The gap is the list itself. arachnefly persists machines at
`users/{uid}/{domain.MachinesCollection}/{machineId}` (its
`interfaces/repository/firestore.go:CreateMachine`), so a fleet view needs a **cross-user
collection-group query**, which means three things before any page exists:

1. a store function using `.collectionGroup(MachinesCollection)` — the same shape as
   `listMeterableSessions()`, with its own entry in `firestore.indexes.json`;
2. a route registered in `bff/api.ts` (the only served table);
3. the page, which is then thin, because the client calls already exist.

**Do NOT gate that route on `machine.read`.** The existing machine routes take `paid +
perm('machine', …)`, which is TENANT-scoped; putting a cross-tenant list behind it would hand every paid
user a list of every tenant's machines — precisely the class of bug Phase 0 closed. The correct gate is
**`perm('platform', 'read')`**: `platform` is granted to no role in `POLICIES` and is admitted only by the
`isPlatformAdmin` short-circuit in `canPerform`, which is exactly the scope this view needs.

### BUILT 2026-10-03 - read-only, and the read-only part is forced

| Layer | File |
|---|---|
| Cross-user read | `functions/src/infrastructure/machine.store.ts` - `listFleetMachines()` |
| Handler | `functions/src/handlers/machine-fleet.ts` |
| Route | `GET /api/admin/machines` in `bff/api.ts`, `guard([perm('platform', 'read'), machineFleetList])` |
| Index | `machines` / `created_at` DESC at `queryScope: COLLECTION_GROUP` |
| Page | `src/app/pages/admin/admin-machines.component.*` (12 specs), route `admin/machines`, nav "Machines" |

**The projection is FIELD BY FIELD because a machine document carries a credential.** `config.env` on
`users/{uid}/machines/{id}` includes `WEBRAIN_HTTP_TOKEN`. Handing `doc.data()` to the page would put
every tenant's worker credential into a response body, into a browser, and into every proxy log between
them. `FleetMachine` has no field a credential could occupy, so the store cannot widen the shape by
accident and the handler only adds an envelope.

**Field names are arachnefly's, and nothing enforces that agreement.** `MachineInDB` in
`domain/machine.go`, written by `interfaces/repository/firestore.go:CreateMachine`. They are snake_case
(`created_at`), and `created_at` is a **string**, not a timestamp, so the page formats it and falls back
to the raw value when it will not parse instead of rendering `Invalid Date`.

**ACTIONS ARE NOT OFFERED, and that is a finding rather than an omission.** arachnefly's
`MachineOwnershipMiddleware` (`router.go:94-104`) admits only the machine's owner and has **no admin
bypass**, so a platform admin can LIST another tenant's machine and cannot start, suspend, stop or
destroy it. Four buttons that each answer 403 would be a worse answer than one sentence explaining why
there are none. Two ways to get actions, both needing sign-off because they change authorization in a
service carrying live traffic: (a) an admin-scoped action route that forwards the OWNER's uid, or
(b) an explicit platform-admin bypass in the ownership middleware. Neither is done.

**Known gap in the columns:** this row originally asked for "last used". No such field exists in
`MachineInDB`, so the page shows `updated_at` and labels it "Updated" rather than relabelling a
different fact as activity.

**The index is DECLARED, NOT DEPLOYED, and where it is declared matters.** It lives in `fieldOverrides`
with `queryScope: COLLECTION_GROUP`, NOT in `indexes`. A single-field entry in `indexes` is dropped by the
CLI without error, so the deploy reports success and the index never exists; the first fleet read would
then answer `FAILED_PRECONDITION`, which is exactly the "looks like an empty list" failure the page is
built to avoid. `functions/src/config/firestore-indexes.spec.ts` caught this, and its
`COLLECTION_GROUP_FIELDS` registry now carries `machines.created_at` (plus `browserSessions.state`, which
was declared but unregistered) so a future regression fails the test rather than production.

Gates: app TSC 0, suite **723 SUCCESS** (was 711), `bun run build` 0, functions TSC 0 + lint 0 errors,
bff TSC 0 + 70 tests. Proven in the artefact rather than assumed: `chunk-PNQHC2MV.js` in `dist` carries
both `app-admin-machines` and `ADMIN_MACHINES`.

## Admin UI rules

- **A token is shown once, on creation, and never read back.** Offer "generate", display it with a
  copy button and an explicit "this will not be shown again", then only ever show `set` / `not set`.
  The webrain console already follows this — keep the convention.
- **Rotate is a first-class action**, not a re-enter: `upsertSecretValue` on the server, audit-logged.
- **Never echo a submitted secret** in a response, an error, or a log.
- Every admin action that changes platform state gets an audit entry (`admin_audit` is append-only and
  never client-writable).
- **Route + nav entry in the same commit.** A route with no nav entry is invisible; that is exactly how
  `/admin/webrain` was temporarily unreachable.

---

# Part E — pre-deploy checklist

- [ ] `bun run prebuild` run after any `.env` or `prod_gen.ts` change
- [ ] functions: `bun x tsc --noEmit` && `bun run lint` && `bun run test`
- [ ] bff: `bun x tsc --noEmit` && `bun test`
- [ ] app: `bun x tsc --noEmit -p tsconfig.app.json` && `bun run build` && `bun x ng test --watch=false`
- [ ] Any new `/api/*` route is registered in **`bff/api.ts` only**. The `syncaiapi.ts`
      route table is **never mounted** — it is a library the BFF imports handlers from, and
      `functions/src/index.ts` imports no Express app. An earlier revision of this checklist
      said "both tables", which is wrong and harmful: it asks for a duplicate table that no
      request can reach, and route drift between the two is therefore not a safety property.
      See the "Where a change belongs" table in the browser-platform skill.
- [ ] Any new route has a nav entry, or is deliberately deep-link-only and stated in the PR
- [ ] i18n parity clean across all five locales; no banned dashes
- [ ] `WEBRAIN_HTTP_TOKEN` set on every deployed machine; `WEBRAIN_NO_STATE=1` on shared workers
- [ ] No secret in a response shape, an error message, or a log line
- [ ] Firestore rules updated for every new subcollection — `match /users/{userId}` does **not** cover
      `/users/{uid}/<anything>`
- [ ] Conventional commit via `git cz`; release notes are generated, never hand-edited

## Known provisioning gaps (as of 2026-10-01)

- `WEBRAIN_MCP_URL` / `WEBRAIN_MCP_TOKEN` appear in **one** document
  (`docs/ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md:652`) and in no env template I read — an undocumented
  required var is how an empty token ships.
- `docker/docker-compose.yml` sets **only** `WEBRAIN_HTTP_ADDR`: no token, no `NO_STATE`. Phase 0.2 fixes
  it.
- **CLOSED 2026-10-03.** The per-image contract — that a deployed image listens on **11235** — was
  *undefined in both repositories* and unverified. It is now defined **and asserted**:
  `deploy/browser-session/nginx.conf` is compiled to listen on 11235, and `entrypoint.sh` refuses to start
  on any other `PORT` with **exit 64**, so a future default change fails at boot instead of producing a
  machine that looks healthy and answers nothing. `entrypoint.sh` also refuses to serve without
  `WEBRAIN_HTTP_TOKEN` (**exit 78**), because a session machine is publicly addressable and Fly
  load-balances across identically-configured machines — an unauthenticated one can be mistaken for
  another tenant's. Both asserted and probed, plus the serving path: `GET /` → **200**, `GET /mcp` without a
  bearer → **401**, with it → **200**. Verified against `browser-session:local` (1.62 GB, all three engines
  baked in). **Nothing was deployed** — local image, local probe.
- The Fly service template exposes **6379 (Redis)** publicly. Phase 0.3 removes it.

### The session image now verifies itself at build time (2026-10-03)

`deploy/browser-session/Dockerfile` asserts that all three engines **execute** in the builder,
immediately after installing them:

```
Chromium 154.0.8037.92 built on Debian GNU/Linux 12 (bookworm)
obscura_bin=/root/.cache/webrain/browsers/obscura-v0.2.3/obscura                  -> obscura 0.2.3
lightpanda_bin=/root/.cache/webrain/browsers/lightpanda-nightly/lightpanda        -> 1.1.0-nightly
```

Costs 0.4 s. This is the one lesson from the image chain worth institutionalising: on a musl base
`webrain install obscura` **succeeded**, and the binary only failed when a session tried to start it --
per session, in production, never in the build. A build that never executes its engines cannot tell
those two apart. Two details a guess gets wrong, and did: `lightpanda` takes `version`, not
`--version`; and the engine path is discovered with `find`, because the version directory changes on
every install and a hard-coded path would silently assert nothing.

`deploy/meilisearch/fly.toml` was checked at the same time and is **already correct** -- it pins
`getmeili/meilisearch:v1.53.2` rather than a floating tag, so the deploy is immutable and no change was
needed. It is also the only other container definition under `deploy/`.

### The deployment tab now reports capacity honestly (2026-10-03)

`pages/user/crawl-pack/machines/` is the UI that talks to arachnefly, and its failure path was wrong in two
ways at once. The deploy handler passed the raw error **object** as the snackbar message:

```ts
this.showSnackbar(error, SnackBarType.error, '', 5000)
```

so every deploy failure rendered as `[object Object]` -- and because the message carried no status, the 503
`capacity_unavailable` the backend had just been taught to emit read exactly like a real 502
`deploy_failed`. The customer was told to investigate a deploy that was never the problem.

- New `core/functions/machines.fun.ts`: `describeMachineFailure(error)` returns the message key **and**
  whether a retry is worth offering -- 503 -> capacity (retryable), 502 -> upstream (not), 403 ->
  permission, 402 -> plan, anything else (including status 0, a request that never landed) -> retryable.
  Five specs, including the pair that must not collapse.
- Five new `MACHINES.*` keys in **all five locales** (`CAPACITY`, `UPSTREAM_FAILED`, `FORBIDDEN`, `PLAN`,
  `ACTION_FAILED`). `MACHINES` is now 21 keys in each, checked by parsing every file rather than by
  trusting the edit.
- The component also gained the `ChangeDetectionStrategy.OnPush` the repository requires and did not have.
  Its absence is why the file reached for `ChangeDetectorRef.detectChanges()`.

**Still open on that tab, so the next pass does not have to rediscover it:**

1. The four lifecycle actions (`start`/`suspend`/`stop`/`destroy`) still hard-code English in their
   snackbars (`Machine X starting failed`), so a non-English user receives English. They are machine-scoped
   and cannot hit the create ceiling, which is why only deploy was given capacity copy -- but they should be
   routed through the same mapper and the `MACHINES.*` keys for i18n.
2. `console.log` remains on several success paths (`Machine created waiting for state change`,
   `waitforState successful`, and the same pair for start/suspend/stop/destroy).
3. `app-docker-stepper.component.ts` carries a `// Mock data (replace with API calls in production)`
   comment. Worth confirming nothing in that step is still mocked before it is trusted.

### The frontend's API base was named after a provider (2026-10-03)

`src/app/core/variables/aiservice.var.ts` declared `export const API_CRAWL4AI_URL = '/api'` -- the
platform's OWN API base, named after one of the providers it consumes. Ten services imported it,
including `webrain-tools.service.ts` and `webrain-config.service.ts`, so a **webrain** service named a
**crawl4ai** constant to reach itself.

The name had also **collided across layers**, which is what makes it dangerous rather than merely
untidy:

| Layer | `API_CRAWL4AI_URL` meant |
|---|---|
| frontend (`src/app/core/variables`) | `'/api'` -- the BFF |
| backend (`functions/src/config/env.ts`) | `https://crawlagent.fly.dev` -- a real third-party upstream (legacy crawlagent) |

One name, two meanings, two layers, is how a client gets pointed at a vendor by a change that looks
like a fix. Renamed to **`API_BASE_URL`**, with a doc comment stating the architecture the name has to
reflect: the client addresses **neither** arachnefly nor webrain directly, and every call goes to the BFF
at `/api`, which relays on the caller's behalf and holds the credentials. A client that named a service
here would be one refactor away from bypassing it.

Left alone deliberately: `environment.API_CRAWL4AI_URL` in `crawlapi.service.ts` is a different symbol
and may genuinely point at a third-party host, so renaming it would have been wrong. Gates: tsc 0, suite
**693 SUCCESS**, and a residual grep shows the only surviving mentions of the old name are inside the new
doc comment.
