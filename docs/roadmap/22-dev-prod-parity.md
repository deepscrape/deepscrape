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

## Where a code lives vs where the code runs (measured 2026-10-21)

| Environment | Client talks to | Server talks to |
|---|---|---|
| `npm start` (dev) | emulators, because `prbuild:dev` regenerates `environment.ts` from `.env.dev` and `EMULATORS=true` | the functions emulator (same Firestore); the BFF only if you also ran `bff/package.json start` |
| bare `ng serve` | **production** — the committed `environment.ts` is the production one (`production: true, emulators: false`) | n/a |

That table is the single most useful thing in this document. A bare `ng serve` is a
production client, and nothing in the UI says so.


## What is NOT a parity problem (checked, so it is not re-opened)

| Thing | Why it is fine |
|---|---|
| Firestore database name | The client calls `getInstanceDB('easyscrape')` explicitly, `firebase.json` and `firebase.dev.json` both carry `"database": "easyscrape"`, and `env.DB_NAME` defaults to `"easyscrape"`. The `(default)` fallback in `app/config.ts` therefore looks alarming and is **unreachable**: `getConfigValue` treats an empty string as absent and returns the fallback, so a blank `DB_NAME=` in `.env` still resolves to `easyscrape`. Checked, so it is not re-opened. The real trap is only in *CLI list commands*, which default to `(default)`. |
| Dev/BFF on different Firestores | Not a name problem (above); it is a *process* problem, row 8. |
| CORS / CSRF in dev | `ALLOWED_ORIGINS` includes the local origins; the BFF sets both cookies on every response, so the flow is identical to production. |
| The service-worker update path | Not run in dev (`SwUpdate.isEnabled` is false without a built SW), so nothing to compare. |
| QStash signature verification | `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` verify identically against `qstash-cli dev`, because the signature is produced by the same JWS format. Only the *destination* differed, which is row 1. |

## Verification order

Rows 1–2 are done and gated. Next by value per line of code: **9** (one script, removes the
"why does nothing work locally" class entirely), then **3 + 4 together** (they are the same
edit — one return contract plus one log line), then **5** (four lines, deletes a widget),
then **6** (one line, but it needs an arachnefly deploy). Row 7 is a log line. Row 8 is a log
line. Row 10 is a probe before anyone writes a fix.

What this document deliberately does not do: no probe was run against a live emulator in
this pass, so every "works in dev" claim above is either quoted from source or from the
Firebase documentation — none of it is a recorded run.
