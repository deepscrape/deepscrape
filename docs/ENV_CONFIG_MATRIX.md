# Environment & Configuration Matrix

How configuration reaches every surface in this platform, which file or secret supplies it in each
mode, and where the dev and production endpoints differ.

**This document contains no secret values, by policy.** It names keys and describes shapes. The
values live in the dotenvx-encrypted files and in Firebase/GCP secrets, and the assistant that wrote
this file is forbidden from reading or parsing those. Where a claim depends on what an env file
actually contains, it is marked **UNVERIFIED** with the command to check it yourself.

Last updated: 2026-10-02.

---

## 1. The four loading paths (verified in code)

Configuration does **not** flow through one mechanism. There are four, and they are genuinely
different.

| # | Surface | Working dir | Loader | Files it reads |
|---|---|---|---|---|
| 1 | **Angular client bundle** | repo root | `dotenvx run --overload -f <file>` → `tsx src/environments/prod_gen.ts` | `.env.dev` / `.env.staging` / `.env` |
| 2 | **Firebase Functions (deployed)** | `functions/` | `firebase-functions/params` → `defineJsonSecret("FUNCTIONS_ENV_JSON")` | one GCP secret, at **runtime** |
| 3 | **Functions (local shell)** | `functions/` | `dotenvx run --overload -f .env.local` | `functions/.env.local` |
| 4 | **BFF (Cloud Run + local)** | repo root | Bun **auto-load**, then `process.env` | root `.env`, `.env.local` (+ `FUNCTIONS_ENV_JSON` on Cloud Run) |

Two consequences worth internalising before reading further:

- **The Angular bundle is baked at build time; everything else is read at runtime.** A client
  variable cannot be changed without a rebuild and redeploy of Hosting.
- **The BFF and Functions share one secret.** `FUNCTIONS_ENV_JSON` feeds both, so a key added for the
  server side is available in both places — but only after that secret is re-published.

### 1.1 Bun's automatic `.env` loading — order matters

Bun reads, in order of **increasing** precedence:

1. `.env`
2. `.env.production` / `.env.development` / `.env.test` — chosen by `NODE_ENV`
3. `.env.local` (skipped when `NODE_ENV=test`)
4. `.env.production.local` / `.env.development.local` / `.env.test.local`

**`.env.dev` is not in this list.** It is not a name Bun recognises. `.env.dev` reaches only paths
that pass it explicitly with dotenvx `-f` — which is the Angular build, and nothing else.

This is the single most surprising fact in this document:

> `bun run bff:dev` loads root **`.env`** (production) and **`.env.local`** — not `.env.dev`.
> Setting a development value in `.env.dev` will **not** reach the BFF.

The BFF's npm script is `cd .. && bun --watch run ./bff/server.ts`, so its working directory is the
repo root — and Bun resolves these filenames against the process working directory, which is where it
looks.

### 1.2 The `encrypted:` trap

The dotenvx files are encrypted (`.env.keys` is the dotenvx marker for that). Anything that reads
them **without** going through dotenvx — which includes Bun's own auto-loader — sees the literal
string `encrypted:...` rather than the value.

`bff/security.ts` and `bff/limiter.ts` already work around this, and their comments say so: they read
`process.env['PRODUCTION']` directly rather than trusting `env.IS_PRODUCTION`, because the JSON blob's
`PRODUCTION` can hold an undecrypted value. That workaround is correct. **Do not "simplify" it back to
the typed `env` accessor** — it will silently invert the dev/prod branch.

UNVERIFIED, and it decides whether local BFF dev has working credentials at all: whether root `.env`
holds plaintext or `encrypted:` values for the keys the BFF needs.

---

## 2. The file inventory

| File | Tracked? | Encrypted? | Loaded by |
|---|---|---|---|
| `.env` | no | dotenvx | Angular prod build; Bun auto-load (BFF) |
| `.env.dev` | no | ? | **Angular dev build only** |
| `.env.staging` | no | ? | Angular staging build only |
| `.env.keys` | no | private keys | dotenvx |
| `.env.example` | yes | no (template) | nothing — reference only |
| `functions/.env.local` | no | ? | `functions:shell` (dotenvx `-f`) |
| `functions/.env` | no | ? | nothing found in code |
| `functions/.deploy-secrets.json` | no | no | `functions:secrets:set FUNCTIONS_ENV_JSON` |
| root `.env.local` | **absent** | — | — |

**There is no root `.env.local`.** Bun's precedence puts `.env.local` *above* `.env`, so its absence
means the BFF's local run is driven entirely by the production `.env`. If you intended a local
override file, it does not exist yet. This is the most likely fix for local BFF development.

---

## 3. Which key goes where

### 3.1 Client-visible (baked into the Angular bundle — never a secret)

Written by `src/environments/prod_gen.ts` into `src/environments/environment.ts`, which is
**generated — do not hand-edit**.

| Key | Notes |
|---|---|
| `PRODUCTION`, `EMULATORS` | build/runtime switches (`"true"` / `"false"`) |
| `API_KEY`, `AUTH_DOMAIN`, `DATABASE_URL`, `PROJECT_ID`, `STORAGE_BUCKET`, `MESSAGING_SENDER_ID`, `APP_ID`, `MEASUREMENT_ID` | Firebase web config — public by design |
| `STRIPE_PUBLIC_KEY`, `RECAPTCHA_KEY`, `FIREBASE_VAPID_KEY` | public keys only |
| `API_ARACHNEFLY_URL` | the browser may call arachnefly directly → CORS applies (§6) |

Hard-coded in `prod_gen.ts`, **not** from env: `wsUrl` (`wss://agent.deepscrape.dev`), `nekoUrl`
(`wss://neko-rtc.fly.dev`), all `API_*` provider hosts, `assetsUri`.

Deliberately blanked, every mode: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `JINAAI_API_KEY`,
`GROQ_API_KEY`, `GOOGLE_API_KEY` — these are set to `""`, not omitted, so an accidental `.env` entry
cannot leak a provider key into the bundle. **Keep that pattern.**

> `wsUrl` / `nekoUrl` have no dev branch. In a local build the client still points at production
> hosts. If live view needs to work against a local machine, that is a code change, not a config one.

### 3.2 Server-side shared (`FUNCTIONS_ENV_JSON`) — Functions **and** BFF

Declared once in `functions/src/config/env.ts`. Both surfaces read it: Functions through
`defineJsonSecret`, the BFF because Cloud Run is given the same secret by name.

Grouped as `env.ts` groups them:

- **Runtime / infra** — `PRODUCTION`, `COOKIE_SECRET`, `CSRF_COOKIE_SECRET`, `DB_NAME`, `STORAGE_BUCKET`, `PORT`
- **Upstash** — `UPSTASH_REDIS_REST_URL`, `_HOST`, `_TOKEN`, `_PORT`, `_USER`, `_PASSWORD`
- **Upstreams** — `API_ARACHNEFLY_URL`, `API_CRAWL4AI_URL`, `WEBRAIN_MCP_URL`, `WEBRAIN_MCP_TOKEN`, `SCRAPE_PROVIDER`
- **Browser sessions (added 2026-10-02)** — `BROWSER_MACHINE_IMAGE`, `BROWSER_MACHINE_REGION`
- **Tigris** — `TIGRIS_BUCKET`, `TIGRIS_ENDPOINT`, `TIGRIS_REGION`, `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY`
- **QStash** — `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- **Provider keys** — `JINAAI_API_KEY`, `CRAWL4AI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_API_URL`, `GROQ_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `IPREGISTRY_API_KEY`
- **Origins** — `APP_ORIGIN`, `MARKETING_ORIGIN`
- **Billing** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, all `STRIPE_PRICE_*`, `STRIPE_TRIAL_PERIOD_DAYS`, `BILLING_*`
- **Auth** — `GCP_PROJECT_ID`, `ADMIN_EMAILS`, `AUTHZ_STRICT_ORG_MODE`, `RP_NAME`, `RP_ORIGIN`

### 3.3 BFF-only and Functions-only

| Key | Read by | Why it is not in the JSON |
|---|---|---|
| `FIRE_SERVICE_ACCOUNT_KEY` | `bff/firebase.ts` | a GCP secret mounted **only** on the Cloud Run service |
| `SSR_BROWSER_DIR`, `SSR_SHELL`, `PORT` | `bff/server.ts` | set by the Dockerfile / Cloud Run |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FUNCTIONS_EMULATOR`, `FIREBASE_EMULATOR_HUB` | both | set by the emulator suite |

---

## 4. Dev vs production endpoint matrix

`functions/src/config/upstreams.ts` is the one place these are resolved, and its rule is uniform:

```
PRODUCTION === "true" ? <the configured URL> : <a localhost URL>
```

| Service | Production | Local dev | Where the default lives |
|---|---|---|---|
| **arachnefly** | `API_ARACHNEFLY_URL` (default `https://arachnefly.fly.dev`) | `http://localhost:8080` | `config/upstreams.ts` |
| **crawl agent** (crawl4ai) | `API_CRAWL4AI_URL` (default `https://crawlagent.fly.dev`) | `http://localhost:8000` | `config/upstreams.ts` |
| **webrain** | `WEBRAIN_MCP_URL` — **no default, by policy** | `http://127.0.0.1:9223` (suggested) | `config/env.ts` |
| **browser machine image** | `BROWSER_MACHINE_IMAGE` — **no default, by policy** | *the same value* — see §4.1 | `config/env.ts` |
| **deepscrape BFF** | Cloud Run `us-central1`, behind Hosting | `http://localhost:8080` | `bff/server.ts` |
| **deepscrape app** | `https://deepscrape.dev` | `http://localhost:4200` (`ng serve`) | `APP_ORIGIN` / `MARKETING_ORIGIN` |
| **Upstash Redis** | REST URL + token | same service, or emulator | `UPSTASH_REDIS_REST_URL` |
| **Tigris** | `https://t3.storage.dev`, region `auto` | same | `TIGRIS_ENDPOINT` / `TIGRIS_REGION` |

Note the asymmetry that is easy to trip over: **`PRODUCTION` is the only switch.** There is no
"staging" branch in `upstreams.ts` — staging behaves as production for upstream resolution, and the
staging dist is only reachable by running with `PRODUCTION` unset locally.

Two port facts, both verified in source:

- arachnefly listens on **`os.Getenv("PORT")`** (`main.go:125`). The `const addr = ":9090"` at
  `main.go:36` is **dead code** — it belongs to a commented-out `reuseport` listener. Reading `:9090`
  as the port is the trap.
- the BFF also defaults to **8080** (`bff/server.ts`). So the platform's dev default for arachnefly
  (`http://localhost:8080`) is the same port the BFF itself binds. **One of the two must be moved via
  `PORT`**, or the BFF will call itself instead of arachnefly. UNVERIFIED whether a local
  `arachnefly/.env` already sets `PORT` to something else — check that before debugging a 404.

### 4.1 `WEBRAIN_MCP_URL` and `BROWSER_MACHINE_IMAGE`, resolved

These are the two values the browser-session work could not proceed without, and they behave
differently from every other row above — so they get their own section.

#### `WEBRAIN_MCP_URL` — the shared engine (the free tier's path)

| | Value |
|---|---|
| **Local dev** | `http://127.0.0.1:9223` |
| **Production** | `https://<webrain-app>.fly.dev` **plus `WEBRAIN_HTTP_TOKEN`** |

Local: run the host binary (`webrain mcp --http 9223`) or the container
(`docker run -p 9223:9223 -e WEBRAIN_HTTP_ADDR=0.0.0.0:9223 <webrain-image>`). No token is needed,
because webrain's `bind_is_loopback` accepts loopback without one — the default address is
`127.0.0.1:<port>`, so `--http 9223` alone is already the safe local setup.

Production: webrain **refuses to start** on a non-loopback bind with no token
(`webrain-mcp/src/lib.rs`, `run_http`) — `0.0.0.0` and `[::]` count as exposed, so the container's
usual `WEBRAIN_HTTP_ADDR=0.0.0.0:9223` *requires* the token. Set it; there is no
"allow-unauthenticated" that is correct for a shared worker. Per roadmap `06`, that worker must also
carry `WEBRAIN_NO_STATE=1`, which **refuses `webrain_launch`**: a shared process may never host a
browser (invariant I2). The free tier is therefore HTTP-only by construction.

> **Trap.** `SCRAPE_PROVIDER` defaults to `"webrain"` while `WEBRAIN_MCP_URL` has no default. A
> deployment that sets neither has a **broken default scrape path** — every `/api/crawl` asks a
> provider that has no URL. Either set `WEBRAIN_MCP_URL` in production or set
> `SCRAPE_PROVIDER=crawl4ai` explicitly. Nothing validates this at boot.

#### `BROWSER_MACHINE_IMAGE` — the per-session machine

**There is no local variant, and that is the answer.** Every other row in the matrix resolves
differently in dev because the *caller* is on a different machine; this value is a **registry path**
that Fly pulls, and Fly is never the dev box. Local and production must point at the **same published,
pinned image**. What differs is only which tag — and production should pin one.

```
BROWSER_MACHINE_IMAGE=<registry>/<repo>/browser-session:<pinned-tag>
```

An empty value makes a dedicated session refuse with `image is not configured` (by design — see
`config/env.ts`). Note that `machineRequestFor` sends it as `imageOption: "default"` + `defaultImage`,
which `GetImageSource` returns verbatim; an empty string would flow straight to Fly
(`references/ground-truth.md`).

**No image satisfies this today.** The only publicly-proven one is the crawl worker
(`registry.fly.io/crawlagent:…`, the value in `DEFAULT_IMAGES`), which is not a browser session; and
webrain's own image is **not anonymously pullable** (GHCR returns 403 for
`ghcr.io/prokopis3/webrain`, against a 200 control). So a dedicated session cannot be provisioned
end-to-end until an image is published.

**What that image must be: `deploy/browser-session/`.** An adapter around webrain's image, because
arachnefly's `BuildConfigMap` hard-codes four things webrain's image does not do:

| Contract | `BuildConfigMap` | webrain's image |
|---|---|---|
| internal port | the `PORT` env var, else **11235** | `--http 9223`, else loopback |
| entrypoint | `processes[0].entrypoint = ["app"]` | `ENTRYPOINT ["webrain"]` |
| health check | `GET /` on that port | `/health` only — "deliberately the ONLY extra route" |
| env sent | **none** from `BrowserMachineRequest` | needs `WEBRAIN_HTTP_ADDR` + a token to bind |

A failing health check makes flyd restart the machine, and the entrypoint `["app"]` cannot run in an
image with no `app` — so an unmodified webrain image would never boot usefully. The adapter supplies
`app`, answers `/` with nginx, and asserts the port. The alternative — fixing `BuildConfigMap` — changes
a service carrying live traffic, so it is a decision rather than a side effect.

Build and publish (three steps, the first of which is not ours):

```bash
# 1. webrain publishes its own image. Its Dockerfile does multi-arch:
#      docker buildx build --platform=linux/amd64 \
#        -f docker/Dockerfile -t <registry>/webrain:<tag> .   # from the webrain repo root
# 2. build the adapter. WEBRAIN_IMAGE is required, with no default.
docker build -t <registry>/browser-session:<tag> \
  --build-arg WEBRAIN_IMAGE=<registry>/webrain:<tag> deploy/browser-session
docker push <registry>/browser-session:<tag>
# 3. give every session machine its token — an APP SECRET on the MACHINE app, not
#    machine env. `FLY_APP` is arachnefly's own env var (main.go:45) naming the app
#    it creates machines in: a separate, PRIVATE app, not the arachnefly app.
fly secrets set WEBRAIN_HTTP_TOKEN=<value> -a <FLY_APP>
```

**Setting it once IS the automation.** Fly injects app secrets into every machine in the app as
environment variables, so one `fly secrets set` covers every session machine with no per-machine step —
and unlike machine `env`, an app secret is not echoed by `GET /v1/apps/{app}/machines/{id}`.

Two variables, one value, and **nothing checks that they match**:

| Side | Variable | Lives in |
|---|---|---|
| the worker (webrain) | `WEBRAIN_HTTP_TOKEN` | the **machine app's** Fly secret |
| the platform (deepscrape) | `WEBRAIN_MCP_TOKEN` | `FUNCTIONS_ENV_JSON` |

`WEBRAIN_HTTP_TOKEN` never belongs in deepscrape's env — that name is webrain's own, read by
`run_http` to enforce the bearer. The platform's name is `WEBRAIN_MCP_TOKEN` (`config/env.ts`), and it is
sent as `Authorization: Bearer …`. Nothing enforces equality: a mismatch surfaces as a **401 from the
engine**, never as a config error, so set both from one generated value.

**Local dev needs neither.** webrain's `bearer_allows` returns `true` when its token is unset or empty,
and it is allowed to bind loopback without one; the platform sends no header when `WEBRAIN_MCP_TOKEN` is
empty. That is why both are blank in the example files, and why `http://127.0.0.1:9223` works untouched.

**Why one app-wide token is the right posture, and the precondition for it.** The token is defence in
depth, not the tenancy boundary — arachnefly's owner-checked proxy is. That holds only while the machine
app has **no public ingress** (the recorded design: "The machine app is a fleet, not a service", three
apps, three policies). `BuildConfigMap` currently still hard-codes public `services` on 80/443/the routed
port, and Fly load-balances across identically-configured machines — so until §0.3's "keep 11235 private"
lands, a shared bearer is reachable across tenants and is *not* sufficient on its own. Sequence that fix
before treating the token as adequate.

> **Step 1 fails today.** webrain's `docker/Dockerfile` pins `rust:1.85-alpine`, but the lockfile now
> resolves crates that need rustc 1.86 and 1.88 (`icu_provider`, `idna_adapter`, `image`, `time`, …), so
> `cargo build --release` exits 101 and produces no image. Bump the base to **`rust:1.88-slim-bookworm`**
> — **not** `rust:1.88-alpine`. Alpine was the obvious fix and it is wrong here: the same image has to
> exec Obscura, whose Linux release is built `x86_64-unknown-linux-gnu` (glibc ≥ 2.35), so a musl base
> fails at exec per session instead of at build. One base change fixes the rustc pin, the libc mismatch
> and `apk` together. The remedy Cargo prints — `cargo update <crate> --precise <ver>` — downgrades six crates
> to suit a stale toolchain, which is the wrong direction. Verbatim output in
> `references/ground-truth.md`.

The **adapter itself is verified**, not just written. Built and run locally against a stub upstream, it
answers `GET /` with 200, returns 401 for an unauthenticated `/mcp`, forwards an authenticated one to the
upstream, listens on `0.0.0.0:11235` with the engine on loopback only, refuses to start without
`WEBRAIN_HTTP_TOKEN`, and refuses any `PORT` other than 11235. What is **not** verified is the real
webrain binary inside that image.

Registry choice: Fly pulls `registry.fly.io` with no extra wiring, and it is where the proven crawl
image already lives. GHCR works too and is free, but a **private** GHCR package needs registry
credentials on the Fly app; a public one does not. The base image may stay private — only the adapter
is pulled by Fly, so the adapter's registry is the one that needs to be reachable.

### 4.2 The exclusive-worker pool is not this

A "pool of exclusive workers behind our router" is a different axis, and it is **not** what
`BROWSER_MACHINE_IMAGE` is. Roadmap `06` splits sourcing into (A1) where webrain runs and (A2) where
the browser comes from; a dedicated machine is A1-dedicated. The pool is A1-pool: it buys **machine
count**, not capability, and it needs infrastructure that does not exist — our own `uid → worker`
router. Roadmap `06` rec 3 says build it **later, as a cost optimisation**; rec 8 says build the
free-tier Obscura pool only when JS-dependent free calls *measurably* fail, as a capacity purchase
(`07` Part H).

**One image covers all three engines.** `kind` (`chrome` | `lightpanda` | `obscura`) is a per-session
parameter, and webrain already chooses the engine per page state — so building three images would
duplicate the engine matrix for no gain. Chrome arrives as `chromium` in webrain's base layer;
Lightpanda and Obscura are baked in at build time by `deploy/browser-session/Dockerfile`.

They **must** be baked in, and that is not a preference: `BuildConfigMap` sets no `mounts`, so a
session machine has no volume, and Fly resets a stopped machine's root filesystem to its original
state. Anything webrain downloads on demand is re-downloaded by **every cold start** — Lightpanda is
~123 MB. Without baking, every session pays that download.

**A browser pool already exists locally, and so does a deployed crawl worker** — worth knowing before
building either. Verified by inspecting the images already on this machine, projecting non-secret fields
only (`entrypoint`, `cmd`, `exposed ports`):

| Image | Entrypoint | Listens on |
|---|---|---|
| `crawlagent-browser-pool-1/2/3:latest` | `python -m uvicorn browser_pool_service:app` | 9000 |
| `crawlagent-crawlagent:latest` (the `registry.fly.io/crawlagent` lineage) | `supervisord -c supervisord.conf` | 6080 (noVNC), 8000, 9222 (CDP), 9808 |
| `lightpanda/browser:nightly` | `lightpanda serve` | 9222 (CDP) |

So the shape roadmap `06` describes as "to build" already has an implementation in the crawl4ai
lineage — a Python `browser_pool_service`, not a webrain construct — and the platform's
`DEFAULT_IMAGES` already points at `registry.fly.io/crawlagent`. That does **not** make it usable for
sessions: the routing has to be ours (`uid → worker`), which is the whole difference between a pool and
a shared process. It does mean the pool is a **reuse** question before it is a build question.

One detail worth carrying forward: `crawlagent` (9222) and Lightpanda (9222) both expose CDP, while
arachnefly's service list publishes only 80, 443, the routed port, and 6379. A machine's CDP is
therefore reachable over `.internal` but not publicly — the right default, and the reason live view must
be proxied through the BFF rather than handed to the browser.

---

## 5. How each service deploys

### deepscrape (Angular + Hosting)
```bash
bun run prebuild     # regenerates src/environments/environment.ts from the mode's dotenv file
bun run build        # ng build --configuration=production — the ONLY Angular template validator
bun run deploy:hosting
```

### Firebase Functions
`functions/scripts/deploy-with-json-config.cjs` does exactly two things, in order:
1. `firebase functions:secrets:set FUNCTIONS_ENV_JSON --data-file functions/.deploy-secrets.json`
2. `firebase deploy --only functions,hosting` with `BUILD_ENV=production`

So **the JSON file is the single source of every Functions secret**, and re-publishing it is a
separate step from deploying code. `functions/scripts/migrate-env-to-json.cjs`
(`npm run migrate:env:json`) regenerates it from the env files.

### BFF (Cloud Run)
Push an image; **do not** use `--source .` (it tars thousands of files on Windows and is unreliable).
```bash
bun run --cwd bff deploy:cloud
```
which is `docker:push` followed by a `gcloud run deploy` that sets `PRODUCTION=true` inline and mounts
two secrets: `FUNCTIONS_ENV_JSON` and `FIRE_SERVICE_ACCOUNT_KEY`. One instance is kept warm by
`--min-instances 1`.

### arachnefly (Fly.io)
Listens on `$PORT`; needs `FLY_API_TOKEN` and `FLY_APP`, plus a Google service account for the
Firestore Admin SDK and `FireAuthMiddleware`. Locally `main.go` calls `godotenv.Load()`, so an
untracked `arachnefly/.env` supplies them. On Fly they are app secrets:
```bash
fly secrets set FLY_API_TOKEN=... FLY_APP=...
```
`FLY_APP` is a **namespace**, not a workload — the container image is chosen per request by the
caller. See `docs/roadmap/02-machine-leasing.md` §1.4.

---

## 6. Findings and open gaps

Ordered by how soon each will bite.

1. **`BROWSER_MACHINE_IMAGE` is not in the deploy secret.** §1.4 refuses a dedicated session with
   `image is not configured` until this key exists in `FUNCTIONS_ENV_JSON`. It is intentionally
   defaultless — the platform must not assume an image — but that means it must be **added by hand**:
   put `"BROWSER_MACHINE_IMAGE": "<your browser image>"` into `functions/.deploy-secrets.json` (and
   the secret re-published), and into `functions/.env.local` for local runs. `BROWSER_MACHINE_REGION`
   defaults to `iad` and needs nothing.

2. **No root `.env.local`.** Bun gives `.env.local` precedence over `.env`, and the BFF dev run has no
   place to put a local override. Create it if local BFF work needs different values from production.

3. **`.env.dev` does not reach the BFF.** It is not a filename Bun auto-loads. Any development value
   put there for the BFF's benefit is silently ignored. Either add `--env-file=.env.dev` to the
   `bff:dev` script, or move those keys to `.env.local`.

4. **arachnefly's CORS list omits the Angular dev origin.** It allows `https://localhost:4200` but the
   dev server serves **http** on 4200, and it allows `http://localhost:5000` / `http://127.0.0.1:8081`.
   Any direct browser→arachnefly call from `ng serve` is therefore blocked. The list also predates the
   dashboard/console subdomain split (`ADR-2026-09-DOMAINS-MULTISITE-SPLIT`), which will need its
   origins added.

5. **Dev port collision.** BFF defaults to 8080 and so does the platform's dev default for arachnefly.
   Give one of them an explicit `PORT`.

6. **`prod_gen.ts` hard-codes `wsUrl` and `nekoUrl`**, so a development build points at production live
   view / RTC hosts. Deliberate or not, it is not configurable today.

---

## 7. Obscura / the future browser-pooling service

Placeholder so the next service lands in this document rather than beside it. When Obscura (or any
pooled-worker service) is built, it needs exactly these decisions recorded here:

- its own `API_*_URL` key with **no default** (the `WEBRAIN_MCP_URL` precedent: a new provider must
  not inherit "some host is assumed"), and a `PRODUCTION` branch in `config/upstreams.ts`
- whether it is reached by the **BFF** (server-side) or by the **client** — if the client, it must be
  baked by `prod_gen.ts` *and* added to its CORS allowlist
- a `computeSource` value so §1.6 can tell whether its compute is billable (platform vs BYO)
- a worker token, and whether that token is a tenancy boundary (it is not, for webrain — see
  `references/ground-truth.md`)

---

## 8. Auditing key presence without exposing values

Run these yourself. They print **key names only** — the assistant is prohibited from parsing
`.env*` files, so presence cannot be verified from here.

```powershell
# Key NAMES only. Never prints a value.
Select-String -Path .env.dev -Pattern '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=' |
  ForEach-Object { ($_.Line -split '=', 2)[0].Trim() } | Sort-Object -Unique
```

To compare what the code requires against what a file provides:

```powershell
# Keys the code will try to read
Select-String -Path functions\src\config\env.ts -Pattern 'getConfigValue\("([A-Z0-9_]+)"' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
```
