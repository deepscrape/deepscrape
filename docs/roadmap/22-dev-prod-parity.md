# 22 — Dev/prod parity: where "works locally" and "works in production" are different systems

Created 2026-10-21. Companion to `20-must-fix.md` (correctness) and `21-optimizations.md`
(cost). This one asks: **which behaviours differ between the emulator setup and production, and
which of those differences are silent?**

Everything below was read in source on 2026-10-21. A row says **measured** only where the claim
is a quoted code path; **probe** means the code implies it but nobody has run it, and the probe
is named so it can be settled in one command. No secrets are reproduced here — `bff/.env.dev`
is referenced by name only.

## The shape of the problem, in one paragraph

Dev is not one system, it is two. The **Angular client** wires itself to the emulators when
`isLocalhost() && environment.emulators` is true (`firestore.service.ts` constructor: Firestore
5001, Auth 9099, Storage 9199, Functions 8081 *only if `this.functions` exists*). Every
`/api/*` call, however, leaves the client for the **BFF**, which has its own Firestore and its
own env. So a page can read one database directly and hit a different one through `/api` in the
same render. Everything else below is a consequence of that split or of a single hard-coded
production constant.

## Work list — easiest first

| Do | Finding | Kind | Risk | What / evidence | Fix and proof |
|---|---|---|---|---|---|
| 1 | **The Fly organisation is a literal** | measured | billing, tenancy | arachnefly creates every app with `"org_slug": "softmind"` — a string literal, not config: `interfaces/handlers/fireAuth.go:153`. A dev session therefore provisions a **real, billable machine in the production Fly org**, beside production apps. There is no `resolveFlyTenant` in the repo (one match for the whole concept). | Read `FLY_ORG_SLUG` with `"softmind"` as the default and set it per environment (`personal` for dev). Code is a one-liner; the work is the deploy + the secret. Proof: a dev session's machine appears under the dev org in `fly apps list`. |
| 2 | **Emulators on, callables off** | measured | correctness, data | `connectFunctionsEmulator` is inside `if (this.functions)`. If that field is undefined at construction, Firestore/Auth/Storage go to the emulator while **callables go to production** — a mixed backend that presents as "some requests hit prod". | Make the condition explicit: log an error when `environment.emulators` is true but `this.functions` is missing, rather than silently leaving callables pointed at production. Prove with a console assertion on a dev boot. |
| 3 | **Two databases in one page** | measured | correctness | The client's direct reads hit the emulator; every `/api/*` read hits the BFF's Firestore. `bff/.env.dev` mentions the emulator host (name only, not reproduced), and the Admin SDK honours `FIRESTORE_EMULATOR_HOST` automatically — so the BFF is on the emulator **only if** that file is actually loaded by the process you run. | One startup line in `bff/server.ts` saying which Firestore it opened (emulator host present / absent). Cheap, and it turns a silent mismatch into a visible one. Prove by booting with and without the var. |
| 4 | **A verification code that is generated but never sent** | measured | correctness (dead end) | `infrastructure/email.ts:sendEmail` needs `RESEND_API_KEY` + `RESEND_FROM_EMAIL`; without them it returns `{ok:false, reason:"email-not-configured"}` — a boolean, not an error. In dev the 6-digit code is stored and the mail never leaves. | Decide one: (a) dev logs the code to the emulator console, or (b) the UI says "mail not configured". **Logging a code is a security decision** — dev only, never when `PRODUCTION=true`. |
| 5 | **Phone/SMS on the emulator** | probe | correctness | Every phone flow builds a `RecaptchaVerifier` (`login`, `signup`, `verification` components). Against the Auth emulator, reCAPTCHA is not required and the widget has nothing to talk to; the emulator accepts a fixed test code instead. | Probe: run signup-phone against the emulator and record whether `signInWithPhoneNumber` resolves. If it fails, skip the RecaptchaVerifier when `environment.emulators`. |
| 6 | **A dev crawl batch publishes to the real queue** | probe | cost | `publishCrawlTarget` posts to QStash. Nothing in the read path stubs it for dev, so a local batch can enqueue real messages that a deployed worker consumes — against the BFF's data, which (3) may not be the emulator's. | Probe: enqueue one target in dev and check the QStash dashboard. If it lands, gate publishing behind the same "emulators" switch or a dev destination. |
| 7 | **`emailVerified` differs by path** | probe | correctness | The combined profile ORs the Firebase flag with a custom claim (`buildCombinedUserData`). The emulator issues no custom claims; production does. So "verified" can be true in prod and false in dev for the same user, and `authGuard` redirects on it. | Probe: verify one user in each and compare `getTokenResult().claims`. If they differ, document it where the guard reads it. |

## What is NOT a parity problem (checked, so it is not re-opened)

| Thing | Why it is fine |
|---|---|
| Firestore database name | The client calls `getInstanceDB('easyscrape')` explicitly and `firebase.json` carries `"database": "easyscrape"`, so dev and prod agree on the name. The trap is only in *CLI list commands* defaulting to `(default)`. |
| CORS / CSRF in dev | `ALLOWED_ORIGINS` includes the local origins; the BFF sets both cookies on every response, so the flow is identical to production. |
| The service-worker update path | Not run in dev (`SwUpdate.isEnabled` is false without a built SW), so nothing to compare. |

## Verification order

Rows 1 and 2 are worth doing before any browser-session testing in dev: 1 spends real money in
the production org, and 2 makes callable behaviour depend on a field that may be null. Rows 3–4
cost a log line each. Rows 5–7 need a probe before anyone writes a fix.
