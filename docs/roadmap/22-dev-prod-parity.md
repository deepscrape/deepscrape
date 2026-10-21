# 22 — Dev/prod parity: where "works locally" and "works in production" are different systems

Created 2026-10-21. Companion to `20-must-fix.md` (correctness) and `21-optimizations.md`
(cost). This one asks: **which behaviours differ between the emulator setup and production, and
which of those differences are silent?**

Everything below was read in source on 2026-10-21, or measured from the running account
(`flyctl orgs list`, `flyctl apps list`). Two rows were corrected after measurement — one had
been overstated and one suspicion was disproved; both are recorded as corrections rather
than quietly rewritten, because the wrong version is what gets re-derived otherwise. No
secrets are reproduced here — env files are referenced by name only.

## The shape of the problem, in one paragraph

Dev is not one system, it is two. The **Angular client** wires itself to the emulators when
`isLocalhost() && environment.emulators` is true (`firestore.service.ts` constructor: Firestore
5001, Auth 9099, Storage 9199, Functions 8081 *only if `this.functions` exists*). Every
`/api/*` call, however, leaves the client for the **BFF**, which has its own Firestore and its
own env. So a page can read one database directly and hit a different one through `/api` in the
same render. Everything else below is a consequence of that split or of a single hard-coded
production constant.

## Work list — easiest first

Sorted by what it costs to fix, not by severity. `kind` says whether the row is a
**correctness** defect (something produces a wrong result) or an **improvement** (something
works but is needlessly hostile in dev).

| # | Finding | Kind | Size | What / evidence | Fix and proof |
|---|---|---|---|---|---|
| 1 | **A dev batch queues work for production** ✅ **fixed** | correctness | S | `APP_ORIGIN` defaults to `https://deepscrape.dev` (`config/env.ts`, and correctly so — an email link must be absolute). `publishCrawlTarget` builds the worker URL from it, so a laptop holding a real `QSTASH_TOKEN` asks the queue to crawl **against production**, with the local uid, and it **succeeds**. Nothing on the publish path could report that. | `queueTargetsProduction(origin, isProduction)` refuses the default origin whenever the process is not the production deployment, and `publishCrawlTarget` throws before the SDK call. Three specs, state-independent like the rest of that file. Functions: build 0, lint 0, **986 tests / 977 pass / 0 fail**. |
| 2 | **A queue-less dev fails once per target** ✅ **fixed** | improvement | S | `qstashConfigured()` existed and had **zero callers**, so `enqueueTargets` published anyway: every target failed, each was recorded as a crawl failure, and the job returned 502 — N misleading rows for one deployment mistake. | `enqueueTargets` answers 503 with the two variable names before writing the job document. Same gate run as row 1. |
| 3 | **Two email failure contracts, one need** | correctness | S | `infrastructure/email.ts:sendEmail` returns `{ok:false, reason}` and never throws. `gfunctions/sessions.ts:sendSecurityNoticeEmail` **throws** when `RESEND_API_KEY` is missing. So the 6-digit device code fails with "Failed to send verification code" in dev, while every notice routed through `sendEmail` silently no-ops. Worse, the code is written to Firestore **and** Redis before the send, so a failed send leaves a live code and an already-consumed rate-limit slot. | One contract. Cheapest correct version: `sendSecurityNoticeEmail` returns the `SendEmailResult` that already exists, and the caller reports `deliveryStatus` from it instead of asserting `"sent"`. Needs a decision on the dev affordance (below). |
| 4 | **Nothing prints the code in dev** | improvement | S | Dev is expected to work like a mail-enabled environment, but neither the Resend path nor the Auth emulator can deliver a **custom** 6-digit code. The Firebase Email Verification flow is different and *does* work: the Auth emulator prints its link to the terminal. | Log the code to the functions log when the mail is not configured **and** `PRODUCTION` is not `true`. The code is already persisted, so this adds no secret to a new place; it makes an existing one readable. Never when production. |
| 5 | **SMS on the emulator already works — the reCAPTCHA widget is the noise** | improvement | S | Measured from the Firebase docs, not inferred: the Auth emulator **disables reCAPTCHA** on client SDKs once connected, prints the SMS code to the emulator terminal, and does **not** support test phone numbers with fixed codes. But `login`, `signup` and `verification` all build a `RecaptchaVerifier` in `ngAfterViewInit`/`initializeRecaptcha` and `render()` it, against the **live** site key in the environment file. | Skip `initializeRecaptcha()` when `environment.emulators` is true. Removes a widget that can never succeed and a `console.log` of a `null` element. Behaviour in production unchanged. |
| 6 | **Fly org is a literal in a create branch** — corrected | correctness | S | `"org_slug": "softmind"` at `interfaces/handlers/fireAuth.go:153`. **This row was overstated before.** `flyAppFor` returns ONE app from config (`FLY_APP`), so the create branch runs only when that app does not exist; measured with `flyctl`: `softmind` holds only `crawler4ai` (suspended since 2025) and **every platform app — `arachnefly`, `deepscrape-webrain`, `deepscrape-browser-session` — is in `personal`.** So today's sessions do not bill the wrong org, because the branch is not reached. It matters in a **new** environment, where the app it would create cannot pull `registry.fly.io/deepscrape-browser-session` (an app in another org). | `FLY_ORG_SLUG` read with `"softmind"` as the default, so production is byte-identical and a new environment can say `personal`. One line plus one secret; needs an arachnefly deploy. |
| 7 | **Emulators on, callables off** | correctness | S | `connectFunctionsEmulator` is inside `if (this.functions)` in `firestore.service.ts`, while `app.config.ts` wires the same three emulators for its own providers. Two wirings for one job. | Log an error when `environment.emulators` is true and `this.functions` is missing, rather than leaving callables pointed at production. |
| 8 | **Two databases in one page** | correctness | M | The client reads the emulator directly; every `/api/*` read hits the BFF's own Firestore. `firebase.dev.json` sets `"database": "easyscrape"`, and the client asks for `easyscrape` explicitly, so the *names* agree — what does not is which process is on the emulator. | One startup line in `bff/server.ts` naming the Firestore it opened (emulator host present / absent). Turns a silent mismatch into a visible one. |
| 9 | **No single command brings dev up** | improvement | M | `npm run serve` = `build:dev` + `firebase emulators:start`, and it does **not** start the BFF; `bff/package.json` `start` runs it separately with `bff/.env.dev`. `firebase.dev.json` rewrites hosting to a static `index.csr.html`, so only `/api` reaches the BFF — meaning a dev who starts one process gets a UI whose every API call fails, and there is no message saying why. | One documented `dev` script that runs all three (Angular dev server, emulators, BFF). Not done here: it needs a process runner, and the env file it depends on is not in the repo. |
| 10 | **`emailVerified` may differ by path** | probe | S | The combined profile ORs the Firebase flag with a custom claim (`buildCombinedUserData`); the emulator's behaviour for claims written by a blocking function differs (it writes the user record twice). | Probe: verify one user in each and compare `getTokenResult().claims`. No fix until the result is known. |
| 11 | **Dev artifacts land in the production bucket** | correctness | S | `resolveBucketName()` falls back to `${GCP_PROJECT_ID}.appspot.com` when `STORAGE_BUCKET` is unset, so the default target is the **production** bucket. Worse than untidy: `decideStorageScope` keys the `shared` scope by **URL**, so a dev instance populating it writes a body fetched from the dev machine's network position into the cache production customers read. | **No code.** `STORAGE_BUCKET=staging.libnet-d76db.appspot.com` — measured to exist with `gcloud storage buckets list` — and a second Tigris bucket for `TIGRIS_BUCKET`. The `[storage-backend]` line at boot already names which one answered. |
| 12 | **A dev process on the production Redis** | correctness | S | `upstreams.ts` has a dev branch for arachnefly, crawl4ai and webrain; **Upstash and Tigris have none** — they resolve to whatever env says, and the key builders carry no environment prefix. A dev process on the production database takes production worker leases, shares rate-limit buckets, and drains the production analytics queue. | **No code.** The account already holds two databases — `crawlcache` and `crawldev` — so dev points `UPSTASH_REDIS_REST_URL`/`_TOKEN` at `crawldev`. Verified with `redis_database_list_databases`. |
| 13 | **No Redis configured is a silent no-op, by design** | not a bug | — | `createNoopRedis` answers `"OK"`, `0`, `null` to every modelled command so callers fall through to Firestore. Leases still fail closed (a real holder string is required), but rate limits, presence and the analytics FIFO silently do nothing. | Nothing to fix. Recorded so "the dev rate limit never fires" is not chased as a defect. |
| 14 | **Two storage systems in one page in dev** | not a bug | — | Client avatars use the **client** Storage SDK (`uploadFileToStorage` → `uploads/{uid}/{name}`), which the emulator honours on :9199. Server artifacts go through the **Admin** SDK, which has no emulator and reaches GCS/Tigris directly. | Expected. Noted because "my upload works but the artifact does not" is the same page talking to two backends. |

## Where a code lives vs where the code runs (measured 2026-10-21)

| Environment | Client talks to | Server talks to |
|---|---|---|
| `npm start` (dev) | emulators, because `prbuild:dev` regenerates `environment.ts` from `.env.dev` and `EMULATORS=true` | the functions emulator (same Firestore); the BFF only if you also ran `bff/package.json start` |
| bare `ng serve` | **production** — the committed `environment.ts` is the production one (`production: true, emulators: false`) | n/a |

That table is the single most useful thing in this document. A bare `ng serve` is a
production client, and nothing in the UI says so.

## The five shared backends, measured 2026-10-21

| Backend | Any dev branch in code? | What dev therefore reaches | Separate dev resource that ALREADY exists |
|---|---|---|---|
| Firestore | yes — named database, plus the emulator | the emulator on the client; its own process on the BFF | `easyscrape` (same name both sides) |
| GCS (the artifact fallback) | **no** | `libnet-d76db.appspot.com` | `staging.libnet-d76db.appspot.com` |
| Tigris (the artifact default) | **no** | whatever `TIGRIS_BUCKET` names | none found — one bucket per environment to create |
| Upstash Redis | **no** | whatever the REST URL and token name | `crawldev` (plus `crawlcache`) |
| QStash | destination only, and only since row 1 | the production worker URL, now **refused** | `qstash-cli dev` |

The conclusion that matters: **the platform is fully parameterised already.** Dev/prod
separation for storage and Redis is two configuration values per surface, not code. The one
place that needed code was the queue destination, because that was the only one that failed
**successfully** — every other divergence here is either loud at boot (`[storage-backend]`) or
inert (`createNoopRedis`).

## Running all four processes at once (dev)

`npm run serve` starts **two** of the four. There is no single command, so this is the arrangement
that works. Ports are from `firebase.dev.json` and are not free choices — the client hard-codes
5001/8081/9099/9199 in `firestore.service.ts` and `app.config.ts`.

| # | Process | Command | Port | Must be up because |
|---|---|---|---|---|
| 1 | Emulators | `cd functions && npm run serve` | 5001/8081/9099/9199/5000/4000/8085 | Auth, Firestore, Storage, callables |
| 2 | BFF | `cd bff && bun run start` | **8080** | every client `/api`, `/event`, `/oauth` call |
| 3 | Angular | `npm start` | **4200** | the UI (`prbuild:dev` regenerates `environment.ts`) |
| 4 | webrain (docker) | `docker run -p 127.0.0.1:9223:9223 …` | 9223 | `/api/scrape`, `/api/search`, jobs |
| — | arachnefly | `go run .` with `PORT=8083` | **8083** | any machine or browser-session route |

8082 is what `bff/.env.dev.example` names and it is a free choice — but on this machine it is
already bound (a node process), so the working value here is **8083**. Whatever is chosen, the
BFF's `API_ARACHNEFLY_URL` and arachnefly's `PORT` must be the same number.

`src/proxy.conf.json` sends `/api`, `/event` and `/oauth` to `http://127.0.0.1:8080`, and the
client addresses everything relatively (`API_BASE_URL = '/api'`), so **the browser never needs the
BFF's origin** — only the dev server does. `bff/security.ts:96` allows
`localhost:4200`, `127.0.0.1:4200` and `localhost:5000` when not production; any other origin is
rejected.

### The three env files, and why there are three

`root/.env.dev` is read at **build time** by `prbuild:dev` and becomes `environment.ts`.
`bff/.env.dev` is read by the **BFF process**. `functions/.env` is read by the **functions
emulator**. The BFF and the emulator do *not* share a file even though they run the same handler
code — and that is the trap: **`bff/.env.dev` must repeat every server-side variable**, because
`functions/src/config/env.ts` reads `process.env` of whichever process imported it.

| Surface | File | Variables that matter in dev |
|---|---|---|
| client | `root/.env.dev` | `PRODUCTION=false`, **`EMULATORS=true`**, `PROJECT_ID`, `API_KEY`, `AUTH_DOMAIN`, `DATABASE_URL`, `STORAGE_BUCKET`, `MESSAGING_SENDER_ID`, `APP_ID`, `MEASUREMENT_ID`, `RECAPTCHA_KEY`, `STRIPE_PUBLIC_KEY` (test) |
| BFF | `bff/.env.dev` | `PRODUCTION=false`, `PORT=8080`, `DB_NAME=easyscrape`, **`FIRESTORE_EMULATOR_HOST=127.0.0.1:5001`**, **`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`**, `GCLOUD_PROJECT=libnet-d76db`, `COOKIE_SECRET`, `CSRF_COOKIE_SECRET`, `APP_ORIGIN=http://127.0.0.1:8080`, `API_ARACHNEFLY_URL=http://127.0.0.1:8082`, `WEBRAIN_MCP_URL`, `STORAGE_BUCKET`, `UPSTASH_*` (→ `crawldev`) |
| emulator | `functions/.env` | the same server-side list **minus the two emulator hosts** (the emulator sets those itself) |

Two gotchas in that table, both measured:

- **`FIREBASE_AUTH_EMULATOR_HOST` is load-bearing twice.** It is what points the Admin SDK at the
  Auth emulator, and it is what lets `firebase-admin` accept the emulator's unsigned `alg:none`
  tokens. `bff/security.ts:74` refuses to boot when it is set together with `PRODUCTION=true`,
  so leaving it in a production env is a start-up failure rather than a silent auth bypass.
- **`APP_ORIGIN` must be set to this machine.** With the default, `publishCrawlTarget` now refuses
  (row 1) — before that it silently queued production work.

### What to fix in the tables above

| # | Mismatch | Evidence | Fix |
|---|---|---|---|
| A | **arachnefly's dev default collides with the BFF.** `upstreams.ts` resolves arachnefly to `http://localhost:8080` outside production, which is the port the BFF itself binds. | `config/upstreams.ts` vs `bff/server.ts` | Run arachnefly with `PORT=8083` and set `API_ARACHNEFLY_URL=http://127.0.0.1:8083` (**8083, not the example's 8082** — 8082 was already bound here). Otherwise the BFF calls itself and answers 404. |
| B | **The two examples disagree on the webrain port.** `functions/.env.example` says 9223 and explains `webrain mcp --http 9223`; `bff/.env.dev.example` says 9333. | both example files | One number, matching what docker publishes. Check with `docker ps --format "{{.Ports}}"`. A wrong port presents as "search is broken", not as a config error. |
| C | **`bff/.env.dev.example` had no emulator hosts.** | the file, before this change | Three placeholders added: the two hosts plus `GCLOUD_PROJECT`. Without them the BFF falls back to ADC and talks to **production Firestore and Auth** while the browser is on the emulator. |
| D | **`npm run serve` never starts the BFF** | `package.json` scripts | Three terminals, or one `dev` script that runs all four. Not added: it needs a process runner. |
| E | **Storage needs GCP credentials even in dev** — unless Tigris is used. `admin.storage()` cannot use the Storage emulator, so `staging.libnet-d76db.appspot.com` requires `gcloud auth application-default login`. | `firebase-blob-store.ts` | Either accept the ADC login, or set `TIGRIS_BUCKET` in dev: the S3 path needs only the key pair, no GCP credentials at all. |

### arachnefly in dev

`godotenv.Load()` reads `./.env` in **arachnefly's** working directory, so that is where its settings
go — not the app's, not the BFF's. Emulator support is already built in and is the reason this needs
no credentials at all: `NewFirebaseClient` branches on `FIRESTORE_EMULATOR_HOST` to
`option.WithoutAuthentication()` and pins project `libnet-d76db`, database `easyscrape`.

```
PORT=8083
FLY_API_TOKEN=<token>
FLY_APP=deepscrape-browser-session
FIRESTORE_EMULATOR_HOST=127.0.0.1:5001
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
```

`Prefork: true` is set in `main.go`; Fiber cannot prefork on Windows, so expect a warning and treat
the root `Dockerfile` as the faithful test. Note `FLY_APP` must name an app that **exists** — that is
what keeps `CheckOrCreateApp` on its check branch and the `softmind` literal out of the picture
(row 6). Nothing is created in Fly while you are in dev unless that app is missing.

### webrain in dev: three images, one of them right

| Image | Port | Right for dev? |
|---|---|---|
| `deploy/webrain-engine/Dockerfile` (full engine) | 9223 | **yes** — chromium included, so `/api/serp` and JS pages work |
| `deploy/webrain-engine/Dockerfile.api-only` | 9223 | **no** — it is built for the *deployed* shared engine and only works with `CDP_URL` set; without a browser, `serp` on `google`/`brave` fails outright, not degraded |
| `deploy/browser-session/Dockerfile` | 11235 | only when testing the Fly machine contract: nginx in front, a **mandatory** token, and a port that is asserted rather than configured |

`-p 9223:9223` does not work on its own because the engine binds loopback by default; the container
has to say `WEBRAIN_HTTP_ADDR=0.0.0.0:9223`, which in turn **requires** `WEBRAIN_HTTP_TOKEN`. Set the
same string as `WEBRAIN_MCP_TOKEN` in the BFF and the emulator, or every call is a 401 that reads as
"search is broken".

**Publish on loopback, always: `-p 127.0.0.1:9223:9223`, never `-p 9223:9223`.** The short form
creates a 0.0.0.0 mapping, so the engine answers the whole LAN; the bare form `-p 9223` is the same
mistake. In a dev process the only client is the BFF on this machine, so loopback loses nothing. The
same holds for `11235`: the browser-session image is a Fly machine contract, and publishing it to the
LAN puts a bearer-guarded MCP surface on a host where the bearer is a word a developer picked.

### The Obscura version decides whether frames exist at all (measured 2026-10-21)

This was got wrong once, so it is written down with the numbers. Obscura's **paint engine arrived in
0.2.0** — the README says so outright ("Native rendering is here. No Chromium required."). A 0.1.x
binary answers `Page.captureScreenshot` with
`"Page.captureScreenshot is not supported by Obscura: no layout or paint engine"`, which reads like a
missing capability rather than a stale build.

| Where | Version | Can paint? |
|---|---|---|
| `browser-session:local` (what the platform deploys) | **0.2.3** | yes |
| host `webrain install obscura` | was 0.1.11, now **0.2.5** ✅ | yes |
| `h4ckf0r0day/obscura:latest` | was 0.1.11 stale, now **0.2.5** (same digest as `:0.2.5`) ✅ | yes |

**Neither stale install upgrades itself.** `webrain install obscura` prints
*"Obscura already installed"* and exits — there is no upgrade flag. The fix is to delete
`%LOCALAPPDATA%\webrain\browsers\obscura-v<version>` and re-run it, which downloads the current
release (65.6 MB for 0.2.5 against 54 MB for 0.1.11 — the difference is the paint engine). Docker has
the same trap: a `latest` tag that is months old stays stale until `docker pull` is run again.

Two consequences worth keeping. `webrain doctor` reports **✅** for an engine that cannot paint — the
engine is *present*, which is not the question a frame path needs answered, so only a **version**
check gates frames. The build block in `deploy/browser-session/Dockerfile` already runs
`"$obscura_bin" --version` and accepts whatever it prints; making that a floor is one line and turns
"silently baked a non-rendering engine" into a red build:
`printf '%s\n' 0.2.0 "$("$obscura_bin" --version | awk '{print $2}')" | sort -V -C`.
Second: 0.2.5 **refuses to bind CDP on a non-loopback address without `OBSCURA_CDP_TOKEN` of at least
32 bytes** (`refusing to expose CDP without authentication`); 0.1.x had no such guard, which is why an
unauthenticated `--host 0.0.0.0` used to work. That only affects a setup that points `CDP_URL` at
Obscura — the platform reaches Obscura through webrain, never through its CDP port — and it makes
"just publish 9222" impossible, which is the correct direction. For containerised CDP in dev, Chromium
is the simpler source.



## What is NOT a parity problem (checked, so it is not re-opened)

| Thing | Why it is fine |
|---|---|
| Firestore database name | The client calls `getInstanceDB('easyscrape')` explicitly, `firebase.json` and `firebase.dev.json` both carry `"database": "easyscrape"`, and `env.DB_NAME` defaults to `"easyscrape"`. The `(default)` fallback in `app/config.ts` therefore looks alarming and is **unreachable**: `getConfigValue` treats an empty string as absent and returns the fallback, so a blank `DB_NAME=` in `.env` still resolves to `easyscrape`. Checked, so it is not re-opened. The real trap is only in *CLI list commands*, which default to `(default)`. |
| Dev/BFF on different Firestores | Not a name problem (above); it is a *process* problem, row 8. |
| CORS / CSRF in dev | `ALLOWED_ORIGINS` includes the local origins; the BFF sets both cookies on every response, so the flow is identical to production. |
| The service-worker update path | Not run in dev (`SwUpdate.isEnabled` is false without a built SW), so nothing to compare. |
| QStash signature verification | `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` verify identically against `qstash-cli dev`, because the signature is produced by the same JWS format. Only the *destination* differed, which is row 1. |

## Verification order

Rows 1–2 are done and gated. **Next are 11 and 12, because they are two env values and zero
code** — a dev database already exists (`crawldev`) and a staging bucket already exists, so
the work is naming them in the dev env file. Then **9** (one script, removes the "why does
nothing work locally" class), then **3 + 4 together** (same edit — one return contract plus
one log line), then **5** (four lines, deletes a widget), then **6** (one line, needs an
arachnefly deploy). Rows 7 and 8 are a log line each. Row 10 is a probe before anyone writes
a fix. Rows 13 and 14 are recorded so they are not investigated twice.

What this document deliberately does not do: no probe was run against a live emulator in
this pass, so every "works in dev" claim above is either quoted from source or from the
Firebase documentation — none of it is a recorded run.
