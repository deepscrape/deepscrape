---
name: browser-platform
description: This skill should be used when implementing, extending, reviewing, or debugging the deepscrape browser-session platform — machine leasing, browser sourcing (pooled workers, BYO CDP, dedicated machines), live view, organizations, billing budgets, and deployment — across the Angular app, the Bun/Elysia BFF, Firebase Functions, arachnefly (Go), and webrain (Rust).
---

# Browser Platform Skill

Build the browser-session platform. This skill carries the invariants and the execution
loop; the plan detail lives in `docs/roadmap/`. Read the plan, apply the invariants, run
the gates.

## Outcome

Ship a browser capability a customer can be billed for, without the platform absorbing
unbounded cost and without a cross-tenant leak.

## When to use

- Implementing any phase of `docs/roadmap/README.md` (steps 1–18)
- Adding or changing a browser-touching route (BFF, Functions, arachnefly)
- Wiring live view, frames, or `cdp_url`
- Touching billing, credits, budgets, or organization scoping
- Reviewing an existing browser or leasing change

Do not use for:
- Visual styling with no platform semantics → `ui-designer-skill`, `deepscrape-theme-template-skill`
- Angular performance work only → `angular-performance-skill`
- Auth/authz architecture (ReBAC/ABAC) → `docs/ADR-2026-03-AUTHZ-REBAC-ABAC.md`

## Read first, in this order

If the *role* of a session is unclear, read `docs/BROWSER-SESSIONS-EXPLAINED.md` first: the two sourcing
axes, what a session leases (a webrain **worker**, not a different engine), the tier model, where webrain
deploys per tier, and the missing join that leaves a session undriveable today. Then:

1. `docs/roadmap/README.md` — master sequence, steps 1–18, and the gates
2. `docs/roadmap/06-browser-sourcing-options.md` — decide sourcing before building anything
3. `references/ground-truth.md` (this skill) — verified file:line anchors
4. The single phase document you are implementing

## The three invariants

**I1 — Build the scheduler, never the browser.**
Consume browser engines as versioned releases (Chrome, Obscura, Lightpanda, or a purchased
CDP provider). Writing, forking, or vendoring an engine is permanently out of scope,
including "just a small patch".

**I2 — No shared-process browser.**
Exclusivity is the safety boundary. A browser reachable through a process anyone else can
reach is a cross-tenant leak, whatever the pooling arrangement is called. If you cannot
name the one tenant who owns a worker, do not launch a browser in it.

**I3 — The spend cap fails closed; the rate limiter fails open.**
The existing fixed-window budgets (`enforceBudget`, `withinNotifyBudget`, the callable
limiter) deliberately fail open when Redis is unavailable. That is correct for a rate limit
and catastrophic for money. Never reuse them for a spend cap. A spend cap that cannot read
its counter is **at** the cap.

## Ground truth (verified, not assumed)

| Repo | Path | Shape |
|---|---|---|
| deepscrape | `Angular/deepscrape` | Angular 20 (zoneless) + Bun/Elysia `bff/` + Firebase Functions |
| arachnefly | `Go/deepscrape/arachnefly` | Go/Fiber, 13 routes, Fly.io machine orchestrator |
| webrain | `Rust/webrain` | Rust engine, MCP over HTTP, **also ships as a portable desktop binary** |

All three are indexed in codebase-memory (`deepscrape`, `arachnefly`, `webrain`). Query the
graph before opening files — `search_graph`, `trace_path`, `get_code_snippet`.

Two facts that cause silent production bugs:

1. `functions/src/infrastructure/syncaiapi.ts` is a **library the BFF consumes**, not a second
   host. `bff/api.ts` imports `ReverseAPIProxy` from it and binds its middleware (`isJwtAuth`,
   `requirePaidAccess`, `resolveAccess`, the org handlers). The `this.router.*` registrations
   inside it are **never mounted**: `functions/src/index.ts` imports no Express app and every
   `firebase.json` hosting rewrite goes to Cloud Run `deepscrape-bff`. So route drift between the
   two tables is **not** a safety property — an earlier version of this file was wrong to claim
   it was. Add routes to `bff/api.ts` only.
2. arachnefly authenticated every `/api` machine route but did not authorize it:
   `StartMachine`, `SuspendMachine`, `StopMachine` and `DestroyMachine` issued their Fly call
   **before** consulting the uid, and `GetMachine`, `ExecuteTask` and
   `HandleContainerProxyFiber` never checked ownership at all. **Fixed 2026-10-01** with a
   per-route `MachineOwnershipMiddleware`. Authentication is not authorization — see
   `references/ground-truth.md` for the guard, its test, and the `app.Group("")` trap.

The webrain desktop binary must keep working standalone. Never couple it to platform auth,
platform secrets, or a platform-only code path.

## Where a change belongs

| Change | Goes in | Never |
|---|---|---|
| Customer-facing HTTP route | `bff/api.ts` (**the only served table**) | `functions/src/infrastructure/syncaiapi.ts` — its route table is never mounted |
| A handler the BFF imports | `functions/src/handlers/*.ts` (imported directly by `bff/api.ts`) | assuming the Express table reaches it |
| Browser tool exposure | `functions/src/domain/webrain-tools.domain.ts` | inline in a handler |
| Fly machine lifecycle | arachnefly, `interfaces/handlers/fireAuth.go` | the Angular app |
| Browser-launch decision | server-side only | the client |
| Browser secret / token | Fly app **secrets**, via the Machines Secrets API | the repo, a log, a client |

## Phase 0 ships first

Steps 2–5 of the master sequence are security fixes and are independent of every feature.
Do not build a feature on top of them.

1. ~~Ownership checks on the arachnefly machine routes~~ — **done 2026-10-01.** A per-route
   `MachineOwnershipMiddleware` now runs before every machine handler, so no Fly call is
   reachable for a machine the caller does not own. See `references/ground-truth.md`.
2. ~~A worker token for webrain (`WEBRAIN_HTTP_TOKEN`)~~ — **gate existed; the bind is now
   fail-closed (2026-10-01).** The token gate and the deepscrape client were already correct.
   Added: webrain **refuses to start** on a non-loopback bind with no token unless
   `WEBRAIN_ALLOW_UNAUTHENTICATED=1` states the intent, so an exposed unauthenticated engine
   can no longer arise from a forgotten setting. ~~**Load-bearing work is uncommitted in
   webrain — every tagged release predates the auth gate entirely.**~~ **CORRECTED 2026-10-16:
   nothing is uncommitted.** webrain's working tree holds only two untracked `build-webrain.log`
   / `push-webrain.log` leftovers, and arachnefly's reaper + ownership guard + machine MCP
   transport were all committed as `8d91cdc`. See `references/ground-truth.md`.
3. ~~SSRF on arachnefly's `check-image` registry probe~~ — **fixed 2026-10-01** via arachnefly
   `registryIsBlocked`, which mirrors the platform's existing `BLOCKED_HOST` policy. `cdp_url`
   is **not yet an input** — `cdp` appears zero times in `functions/src/**` — so no validation
   was written for it. When a `cdp_url` field is added it must go through the same guard **and**
   accept `ws://`/`wss://`, which `isSafeTargetUrl` currently rejects outright. An existing
   guard exists — `functions/src/domain/url-guard.domain.ts` — reuse it, never fork it.
4. ~~A reaper for leaked leases~~ — **mis-sequenced; moved to Phase 1 `§1.5`.** It cannot be built
   yet, and the three reasons are worth knowing before Phase 1: (a) no session store or deadline
   field exists — `browserSessions` has zero code, docs only; (b) there is **no idle clock** for
   machines in either repo, so "idle" is unmeasurable; (c) arachnefly's `FireAuthMiddleware` accepts
   only a Firebase **ID token**, so an `onSchedule` job cannot authenticate as the machine's owner —
   and item 1's ownership guard makes that mandatory. Resolution is in `§1.5`: the reaper belongs
   **inside arachnefly**, next to the existing `cron.AddFunc("@every 1m")` in `synchronizer.go`.

**Phase 0 is complete.** Along the way the platform's own URL guard turned out to admit two IPv6
SSRF shapes — `[::1]`, and `[::ffff:169.254.169.254]`, which the URL parser re-encodes as
`[::ffff:a9fe:a9fe]` so a text match cannot see it. Fixed in place, with a spec the guard never had.
See `references/ground-truth.md`.

## Where we are

Keep this section SHORT — it is a pointer, not a changelog. The file is attached to every request, so
narration here is a per-turn token cost. Detail belongs in `references/ground-truth.md` and
`docs/roadmap/02-machine-leasing.md`.

**Phase 3 exists: `docs/roadmap/08-production-readiness.md` (2026-10-10), from a measured audit of all
four repos.** Two facts to carry here. **(1) The frontend↔BFF wiring is CLOSED** — 56 routes, 18 client
roots, **0** client calls with no route; the 8 client-less routes are 3 computed paths, 3
variable-passed paths and 2 webrain callbacks. Measure with `bunx tsx scripts/route-parity.ts`
(rebuilt 2026-10-10 — this file cited it and the file did not exist; its first version reported 29
client-less routes because it read only `API_BASE_URL` and missed the `core/variables/` constants that
ARE the paths, e.g. `API_ARACHNEFLY_URL` is `/api/machines`). **(2) `POST /machine/mcp/:id` was absent from arachnefly's 13 routes and is now BUILT
(2026-10-10) — arachnefly is at 14**, so the transport blocker is removed rather than reasoned away.
The route bypasses `MakeAPICallback` on purpose: that wrapper calls `c.Type("json")` before
serialising, which would label a PNG `application/json`. **Frames are closable end-to-end:** the BFF
route and the fps cap are both in place. Phase 3 order: a verified dead constant (§3.1) →
profiles correctness (§3.3) → the purchase path (§3.2, §3.5). **~~the two undeployed indexes
(§3.4)~~ — CORRECTED 2026-10-16: both are DEPLOYED and READY.** Measured with
`npx firebase firestore:indexes --project libnet-d76db --database easyscrape`: 34 composite
indexes, all `READY`, plus 7 `fieldOverrides` carrying `browserSessions.idleDeadline` and
`browserSessions.state` at `COLLECTION_GROUP` scope. The reason this stayed mis-labelled is a
trap worth keeping: **the list command defaults to `(default)` while the app's data is in
`easyscrape`**, so `firebase firestore:indexes` with no `--database` answers
`{"indexes":[],"fieldOverrides":[]}` and reads as "nothing was ever deployed". `firebase.json`
does carry `"database": "easyscrape"`, which is why *deploy* was always targeting the right
one. `gcloud firestore indexes composite list` has the same default and the same trap.

**Phase 0 complete. Phase 1: §1.1, §1.2, §1.3, §1.4, §1.5 all done.** Domain, store, the four
`/api/browser/session*` routes, machine provisioning with the deploy charge, and the reaper wired end to
end. ~~**The reaper is LIVE in source: the next arachnefly deploy suspends machines every minute — and §1.4
now writes `machineId`, so it has something to act on.**~~ **CORRECTED 2026-10-16: the reaper is
DEPLOYED.** Its files were written 2026-10-01, and the newest `.go` in the repo (`machine_mcp_test.go`,
2026-10-10) also predates the last release (`v11`, 2026-10-15 17:16) — and `flyctl deploy` builds the
working tree, so v11 carries it. The late commit `8d91cdc` (19:12 that same day) committed code that was
already live. **What is still unproven is that it REAPS:** that needs a session with an expired
`idleDeadline`, and none exists. Closing a session releases its own machine
(suspend), because the reaper skips `closed` sessions by design; a failed release deliberately leaves the
session OPEN so the reaper stays the backstop. **Only §1.6 is outstanding** — it needs pricing amounts,
which is a human decision.

Last green (2026-10-03): functions TSC/LINT/TEST 0 (535 tests / 526 pass / 0 fail / 9 skipped),
bff TSC/TEST 0, arachnefly gofmt clean + BUILD/VET/TEST 0.

Two traps already paid for, so do not re-litigate them: the `machine.schema.json` check **validates
nothing and sits after the Fly call** (never switch it on in place — validate the *request*), and the
`idleDeadline` cross-repo field names have **nothing enforcing agreement** between the TS writer and the
Go reaper. Both are in `references/ground-truth.md`.

**§1.6 rate DECIDED (2026-10-03)** → `07` Part E.1: **1 credit per started 5-minute block**, first block
included in `machines.deploy`, **20-credit session ceiling**, **0 credits when `computeSource="byo"`**, free
tier not metered in minutes. The rationale is scarcity of Fly machine *creation*, **not** compute cost — a
machine-minute is $0.00013 against a €0.125–0.19 credit, so ~1,000 minutes per credit and **credits cannot
express browser time at all**. **The ceiling stays 20, not 15** (decided 2026-10-03, `07` Part E.2): 5 credits
is under €1 and <0.5% of any plan, while 15 would cut the maximum session from 105 to 80 minutes — capability
lost for almost no money. It is unreachable by accident (the 15-min idle reap costs 8 credits total; only
~105 min of *active* use reaches it) and `dedicated: 1` prevents multiplying it. **But it does not bound
compute** — past block 21 the meter emits no more keys, so the session runs *free*, which is the opposite of
cost control. **That free window is CLOSED (2026-10-03).** `isMeterExhausted` fires once the last billable
block (21, running 100 to 105 min) is DONE, and the sweep then moves the session's **idle deadline to now**,
which is how it asks the Go reaper to suspend the machine since a scheduled job cannot authenticate as the
owner. No separate lifetime field was added: the ceiling is already the agreed spend, so it doubles as the
lifetime. The boundary is off by one from the obvious reading (a "no credit is due" test fires at 101 and cuts
off a block already billed) and the first version was wrong there. What it does NOT fix: a deleted session
record or a sweep that never runs still strands a machine, which stays the reaper's job.

**The meter's rate logic is BUILT (2026-10-03)** in `domain/browser-meter.domain.ts` + 32 tests — pure, no
clock, no DB, because a mistake here is an invoice. It settles three things the rate table left implicit: the
billable window ends at the **idle deadline** (past it the machine is suspended); block *n* is credit *n−1*,
so the 20-credit ceiling lands at **block 21**; and `meterChargeFor` returns **ledger keys, not a delta**
(`applyBillingCreditMutation` is already exactly-once on `idempotencyKey`, so a crash between the charge and
the counter write is a no-op — the meter heals itself). **BYO is derived from `machineId` absence, so no
`computeSource` field is needed**; and `minutesBilled` **already exists** (`browser-session.domain.ts:246`).

**The sweep that charges is BUILT (2026-10-03)** — `gfunctions/browser-meter.ts`, exported from `index.ts`
(an unexported trigger never deploys), scheduled `*/5 * * * *` because the block size *is* the cadence, so a run
crosses at most one boundary. It needed two things the store lacked, both added to
`infrastructure/browser-session.store.ts`: **`listMeterableSessions()`** — the only cross-user read in the
file — via a collection-group query on `state in [starting, ready, suspended]` (new `state`
collection-group index in `firestore.indexes.json`, beside the reaper's `idleDeadline` one); and
**`recordMeteredMinutes()`**, which advances `minutesBilled` **monotonically** inside a transaction so a
straggling run cannot rewind the counter. The bucket is read from `machineChargeFor`, never restated. Still
**pass `releaseReserved: false`** or the default drives `reserved` negative on a charge with no reservation
behind it; the record field is **`state`**, not `status`.

**Revenue gap CLOSED (2026-10-03).** A session ending between two sweeps used to escape its final block
permanently, because the sweep excludes `closed`. The close route now makes a final charge, ordered **after**
the machine release but **before** the record is marked closed — so a failure leaves the session OPEN for the
sweep to retry rather than silently losing the money. The money step moved into
`infrastructure/browser-meter-charge.ts` (`meterWalletFor` + `chargeSessionMeter`), called by BOTH the sweep
and the close route so they cannot drift; **`releaseReserved: false`** lives there.

**The query is now verified at RUNTIME (2026-10-03).** It was executed against a real Firestore emulator
(v1.22.0, JDK 21) in a container: four seeded sessions across three uids returned exactly the three
non-closed ones, the uid was correctly derived from `doc.ref.parent.parent.id`, and the `closed` document
was correctly excluded. Query semantics and the uid derivation are therefore measured, not assumed. **What
this does NOT prove:** the emulator does not enforce collection-group indexes, so the `state` index
declaration remains unproven and production can still answer `FAILED_PRECONDITION`. The index stays declared
but undeployed and the first live sweep is still the real test.

**Frontend: panel BUILT (2026-10-03)** — types, `core/services/browser-session.service.ts` (the one writer of
`/api/browser/session*`), `browser-session-chip.component.*` (8 specs) and `browser-session-panel.component.*`
(17 specs), hosted at route `browser` (`/browser`, `/{orgId}/browser`) by `pages/user/browser/`. Gates: app
TSC 0, `bun run build` 0, panel spec 24/24. **Admin fleet view BUILT 2026-10-03** (`GET /api/admin/machines` +
`pages/admin/admin-machines.component.*`, 12 specs). Outstanding: the fleet view's ACTIONS. **Do NOT use a `BROWSER.*` i18n
namespace** as `03` B.6 instructs: one already exists for the remote-browser VIEWER, so session keys live
under **`BROWSER_SESSION.*`** (33 keys, all five locales, parity checked). Naming hazard:
`browser.service.ts` / `browser.component.*` and the `crawlpack/browser` route are a DIFFERENT feature, which
is why the new files are `browser-session.*`. **Two panel decisions not to re-litigate:** it has TWO error
channels (the envelope covers a list-load failure only, so a failed keepalive or close cannot hide the
session that still needs closing and is still billing), and it separates a 402 plan boundary from a 403
permission boundary. **Trap:** an UNREFERENCED component escapes `bun run build`.

**Live view BUILT and REACHABLE (2026-10-03)** —
`core/components/browser-session/browser-frame.component.*` (11 specs) renders `session.frameUrl(id, nonce)`
as one `<img>` per poll, and `BrowserSessionService.frameUrl()` returns
`/api/browser/session/{id}/frame?n={nonce}`, matching `03` A.2 exactly so Part A only has to implement the
route. It is **mounted on demand** from `browser-session-panel`, behind a `FRAME_SHOW` / `FRAME_HIDE`
toggle: the frame owns the poll, so "closed" has to mean DESTROYED and never `display:none`. The panel is
hosted by `/browser` **and** the playground's `browser` mode, so the component is wired into two surfaces
with `strictTemplates: true` type-checking the bindings. `BROWSER_SESSION` is now **42 keys** x 5 locales.
Gates after wiring: app TSC 0, suite **711 SUCCESS** (was 693), `bun run build` 0.

**`/machines` — one surface for both kinds of machine, BUILT 2026-10-03.** The crawl-pack `machines` tab was
DELETED and the route MOVED to `/machines`: one entry in the root nav, `pages/user/crawl-pack/machines/`
unchanged on disk, `crawl-pack.component.ts` down to 5 tabs (its spec asserts the count and resolves the
active tab through `/crawlpack/browser`). A session's machine and a crawl machine were ALREADY the same
object — one collection (`users/{uid}/machines`), one arachnefly, one Fly app, one billing action
(`machines.deploy`) — and the reaper/meter already treat `bs-<sessionId>` documents as sessions, so the tab
split was the only thing keeping them apart. **What did NOT merge is the action layer, and it must not.** The
crawl machine serves `/crawl` through `execute-task` + `fly-replay`; the session image has no such route, and
lifetime, billing (meter + 20-credit ceiling), authz scope and reaper treatment all differ. So the page
COMPOSES: the container console, plus `<app-browser-session-panel />` above it, which owns its own list,
create form and actions.

**The read that makes it work is tenant-scoped, and it is a JOIN, not a name parse.** `GET /api/machines` ->
`machineListMine` (`guards: paid`, `perm('machine','read')`) -> `machine.store.listMachinesForUser(uid)`,
which projects seven scalar fields (**never `doc.data()`** — `config.env` holds `WEBRAIN_HTTP_TOKEN`) and
derives `kind` by joining the caller's non-`closed` session records, **not** from the `bs-` prefix, which
nothing enforces and which this data uses to decide whether a destructive action is offered. Scope is the
caller, so `machine.read` is correct here; the cross-tenant `/api/admin/machines` fleet still needs
`platform`.

**Destroy on a session row was a PRE-EXISTING hazard, now guarded.** Session machines have always appeared
in that list, and destroying one does NOT end the session: the record survives and `chargeSessionMeter` bills
from the RECORD, not the machine, so the customer keeps paying until the spend ceiling and the idle reaper
catch up, with nothing left to connect to. `refuseSessionOwnedAction()` refuses Stop and Destroy on a
session-owned row and points at the panel, where ending a session stops the meter and the record together.
It is a guard at the point of damage rather than a UI change: `container-box` still has exactly one input
(`machine`) and five outputs. The refusal is **`MACHINES.SESSION_OWNED`** (MACHINES is 22 keys x 5 locales,
parity checked), and the guard is now SPEC'd: `machines.component.spec.ts` asserts the join filter, that an
unannotated row degrades to a container (the deliberate fail-open direction), and that `destroyMachine` on a
session row never reaches the endpoint.

**Trap: a `proxy.conf.json` entry for a route SHADOWS that Angular route in dev.** `/machines` carried a
proxy block from when the surface was a crawl-pack tab and the client addressed arachnefly past the BFF. The
proxy middleware runs before the SPA fallback, so `GET /machines` answered with the BFF's JSON instead of the
page, while production (which has no proxy) was correct. Deleted; `/api` already covers `/api/machines`. Any
route that is also a proxy prefix fails this way, and it presents as a broken page, not a config error.

**Two frame facts that are engineering, not preference.** `canFrame()` refuses **lightpanda**: its
screenshot is a placeholder, so a live view there would promise an image that cannot exist, and the row
explains instead of rendering a permanently broken panel. And a frame POLLS once per second, which is real
money on a dedicated session, so it is off by default, and it stops while the tab is hidden. Visibility is
component STATE, not a `document` read inside the poll: headless Chrome reports `hidden`, which is exactly
how the first spec run failed 2 of 9 with `?n=0` never advancing. Obscura's `--no-render` build also serves
no frames; that refusal belongs on the SERVER, since the client type carries no build variant.

**Fleet view is READ-ONLY, and that is forced (`05` Part D).** arachnefly's
`MachineOwnershipMiddleware` has **no admin bypass**, so a platform admin can list another tenant's
machine and cannot act on it. Its store reads arachnefly's `users/{uid}/machines/{id}` and projects
SEVEN scalar fields because `config.env` there holds `WEBRAIN_HTTP_TOKEN`: never return `doc.data()`.
Gate is `perm('platform','read')`, never `machine.read` (tenant-scoped, every paid user holds it).
Field names are snake_case and `created_at` is a STRING. Actions need sign-off: an admin route
forwarding the owner's uid, or a bypass in the middleware. Its index belongs in `fieldOverrides`
(`COLLECTION_GROUP`), never in `indexes`, which drops single-field entries silently.

**Admin → Live sessions BUILT, read-only (2026-10-10) — step 13's remainder.** `GET /api/admin/sessions`
(`guard([perm('platform','read'), sessionFleetList])`, `handlers/session-fleet.ts`) ->
`listAdminSessions()` in `infrastructure/browser-session.store.ts` ->
`pages/admin/admin-sessions.component.*` (9 specs), route `admin/sessions` + nav "Sessions".
**It adds NO index, and that is the design rather than a saving.** The read reuses
`listMeterableSessions`'s existing `state` collection-group query and deliberately omits
`orderBy("lastUsedAt")`, because that would need a COMPOSITE collection-group index and an UNDEPLOYED
index answers `FAILED_PRECONDITION` — which this page would render as "no sessions", telling an operator
the platform is idle while customers are being billed. So it caps at `ADMIN_SESSION_LIMIT` (500, `+1` to
detect truncation, exactly the fleet's convention) and says so on screen.
**RECLAIM IS NOT BUILT, and it is a decision, not an omission.** `05` Part D asks for "one-click reclaim";
that moves the idle deadline the Go reaper reads, which suspends a customer's live, still-billing machine
— a destructive act on another tenant's money. Same class as the fleet's lifecycle actions, same answer:
read-only until there is sign-off.
**The projection drops `cdpSecretPath`, field by field,** for the reason `FleetMachine` names its own
fields: the record carries it, the console has no use for it, so the shape has no field it could occupy.
Two client decisions worth keeping: an unusable `lastUsedAt` renders as UNKNOWN (`sr-only` text, not a
bare dash) rather than as "0 idle", because "unknown" and "just used" must not look alike to an operator
hunting a stuck session; and a future stamp clamps to 0 rather than rendering a negative age when the
writer's clock and this browser disagree. Gates: functions TSC/lint/tests 0, bff TSC 0 + 70 pass,
app TSC 0, `bun run build` 0, suite **752 SUCCESS**, five locales parse at 19 keys.
**Test-suite note:** the first full run after these changes reported `2 FAILED` and two later full runs
plus an isolated run of the new spec were green, so it was not reproduced. Worth knowing that this suite
has been observed flaky once; a single red run is not by itself evidence about the change.

**Pricing page BUILT from the table (2026-10-03, `07` Part G item 2)** - `GET /api/pricing/rates`
(`guard([access, pricingRates])`) projects `getPublicPricingRates()`, and
`pages/user/billing/rates/rates.component.*` (13 specs) renders it. The page holds NO numbers and
contributes only labels, so a rate added to the table appears by existing. Do not hard-code a price in a
template: the drift is silent because the code keeps charging correctly. Route + nav in one commit.
**Part F's `GET /api/pricing/estimate` still does not exist.** Step 15's cap is **WIRED end to end
(2026-10-04)**: `domain/billing-policy.domain.ts` (15 specs, fail-closed) + `infrastructure/billing-spend.store.ts`
+ `handlers/billing-policy.ts` + `GET`/`PUT /api/billing/policy` + the admission check in
`handlers/browser-sessions.ts` + the counter advance in `infrastructure/browser-meter-charge.ts`. Gates: functions
TSC 0 / lint 0 errors / **601 tests, 0 fail**, bff TSC 0 / tests 0. **The unit is `spendCapCredits`, NOT
`spendCapMinor`** — nothing converts a credit to money (`creditPackCatalog` is 19.0 minor/credit at 100 and 15.8
at 500, and plan-granted credits have no price at all), so a money cap would need lot accounting over
`credits_ledger`. Credits are the unit the platform already charges in, so this is not a shape change. Two
documents, deliberately: the policy is the customer's, the `.../billing/spend/{periodKey}` counter is not, because
a shared document would let them zero their own counter.
**The meter-side STOP landed (2026-10-04, same gates re-run green).** `capReached(uid, now)` in
`infrastructure/billing-spend.store.ts` answers "is this customer at their limit right now" — a different question
from the admission check's "may this charge proceed", and a different direction of failure. It is consulted **once
per caller** in `sweepBrowserMeter`, right after the `!wallet` guard and before the session loop (so N sessions
cost 2 reads, not 2N), and on true it calls `expireMeteredSession` for every session that caller owns — the same
mechanism the 20-credit ceiling uses, because a scheduled job cannot authenticate as the owner, so pulling the idle
deadline forward is the only handle it has on the Go reaper. `>=` and not `>`: `decideSpend` lets a charge land
exactly ON the cap, so a counter sitting at the cap has no room left. **The meter must never REFUSE a charge** —
that would leave a running machine unpaid, strictly worse than the overspend it prevents. Honest cost: a cap
crossed *during* a sweep is acted on by the next one, up to five minutes later; the ceiling has the same
granularity because the block size *is* the cadence. A `capped` count is now in the sweep's summary log.
**The alert LANDED (2026-10-04), so step 15 is COMPLETE — admission, stop, and notice.** `alertCapReached(uid,
now)` writes `users/{uid}/alerts/spend-{periodKey}-{threshold}` from the sweep, called AFTER the stop. The fixed
ID is the whole idempotency story: `alert-fanout.ts` listens for *create*, so the second sweep in a period writes
an update rather than an event, and a new period is a new key with no field to reset. It honours the `alertsAt`
array already on `SpendPolicy` (default `[100]`) and writes ONE document for the highest threshold crossed — the
fan-out throttles per (user, category) in Redis, so writing 50+80+100 together buys one push and two bell
entries, the noise without the warning. It swallows its own failures: it is a courtesy on a path that has already
stopped the sessions.
**No `spend_cap` branch in `alert-presentation.ts` was needed**, which is why this was small: an unknown category
already falls through to push-only using the document's own `title`/`message`. That fallback is push-only BY
DESIGN — email is opt-in per category, the same reason `mfa_disabled` is — so this alert does not email.
Deliberate, not an omission.
**Spend-cap EMAIL is built and inert-by-default (2026-10-04).** A `spend_cap` branch now exists in
`domain/notifications/alert-presentation.ts` (`channels: {email: true, push: true}`), and
`gfunctions/alert-fanout.ts` gates the mail on an **opt-in**: email sends only when
`users/{uid}.notifications.preferences.spendCapEmail === true`. Push and the bell are unaffected, so today's
behaviour is unchanged until someone opts in — which is why this could ship ahead of its UI.
**No schema change and no migration:** it rides `notifications.preferences`, the open bag already declared on
`UserNotifications` (`domain/global.domain.ts:206`). Use that bag for the next SaaS notification too rather
than adding named fields. It also costs **no extra read** — the fan-out already fetches the user document.
**Formatting trap that was already waiting:** the alert's `metadata.cap`/`spent` are NUMBERS, and
`alert-presentation.ts`'s `str()` helper returns `""` for anything that is not a string, so reading them
through `meta()` would have silently deleted every details row from the email. The branch formats at the edge
instead; the stored type stays numeric. **Known narrow interaction, documented in the code rather than
discovered later:** the fan-out's existing `securityAlerts === false` check is not category-aware, so a
customer who muted security mail also loses this billing mail. Left alone on purpose — widening the one
existing opt-out inside a money path deserves its own decision.
Gates: functions TSC 0 / lint 0 errors / 601 tests, 0 fail.

**There is STILL no client for any of this, and that is now the whole of step 15's remainder.** Two gaps, and
they need the same missing thing — a settings surface:
1. `PUT /api/billing/policy` (`spendCapCredits` / `period` / `alertsAt`) has **no client at all**; the cap is
   settable by curl and nothing else.
2. The spend-cap email toggle's **writer now EXISTS (2026-10-04)**: `getMyNotificationPreferences` +
   `setMyNotificationPreference` in `gfunctions/user-settings.ts`, both exported from `index.ts` (an
   unexported callable never deploys). It writes `notifications.preferences.spendCapEmail` with
   `merge: true`, which is load-bearing: Firestore merges nested maps field by field, so writing one key
   cannot drop the user's other preferences or the `securityAlerts`/`emailNotifications` flags beside them —
   a whole-object replace would silently discard them. The key is an **allowlist**
   (`WRITABLE_NOTIFICATION_PREFERENCES`), because a passthrough would let a caller write any field into their
   own user document. Gates: functions TSC 0 / lint 0 errors / 601 tests, 0 fail.
   **The UI LANDED (2026-10-04) as a SECTION of `settings/general`, not a tab. An earlier version of this
   file was WRONG about that.** It described a `pages/user/settings/alerts/` tab in `ACCOUNT_DATA_TABS` routed
   at `/settings/alerts`. **No such directory exists** — the tab was built, the owner corrected the placement,
   and it was re-implemented in place. The i18n namespace stayed **`SETTINGS_ALERTS`** (now 13 keys x 5
   locales). **Building it in place is what fixed a design drift, and that is the transferable lesson:** built
   in isolation it used raw Tailwind grays and `app-checkbox`; built in `general` it inherits the page's own
   tokens (`gray2/gray5/gray6`) and **`app-radiotoggle`**, matching the push row directly above it. Read the
   neighbouring controls before choosing one, not after. Other facts that cost a lookup each: the locales are
   **en, el, de, es, fr** (Greek included); `bell` was NOT registered, so `lucideicons.ts` needed BOTH the
   `lucide-angular` import block and the lowercased `myIcons` object edited; and **no gate validates i18n
   JSON** — parse all five explicitly. Two decisions in it: a failed READ renders an error rather than an
   unchecked box (otherwise the customer sees a preference they never set as their current state), and a
   failed SAVE reverts the control with `emitEvent: false` (otherwise the revert echoes back forever).

**Step 15 is COMPLETE end to end (2026-10-04), including the client that was missing.** The cap was settable
by curl and nothing else, which also made the email toggle above it meaningless — it notified about a limit
the customer had no way to set. `core/services/billing-policy.service.ts` is now the one client of `GET`/`PUT
/api/billing/policy`, and the cap row sits under that toggle in `settings/general`.
**The cap is NOT save-on-change, and that is a money decision:** a `type="number"` input emits per keystroke,
so save-on-change would PUT `1`, then `10`, then `100` on the way to typing `100` — storing two caps the
customer never chose and stopping a running session against the first. It is an explicit Save button.
**Empty input saves `0`, never `null`:** the route reads `0` as "no cap" and refuses a non-integer, so `null`
would be a 400 with the cleared cap still in force. `window: null` (a FAILED counter read) renders as no spend
line at all rather than "0 credits", and the row is rendered only after a SUCCESSFUL policy read, because an
empty box means "no cap". Gates: app TSC 0, `bun run build` 0, suite **743 SUCCESS**, five locales parse at
13 keys. Three specs pin the money branch (empty -> 0, typed passthrough, no save on change).
**Two preference homes exist, and the choice is load-bearing.** `users/{uid}.notifications.preferences` is the
field on the user document (what the fan-out reads ⇒ zero extra reads); `users/{uid}/settings/preferences` is a
subcollection document used by `scrape-provider.store.ts`. Putting a fan-out preference in the subcollection
would cost the fan-out an extra read per alert.
**Pattern to follow:** `gfunctions/user-settings.ts` — `guardedOnCall`, a local `requireUid`, shared `OPTIONS`,
and never a uid from the request body (a route that reads a uid parameter is how one account writes another's
settings). New callables must be exported from `index.ts` or they never deploy.
**The user asked for a NEW settings section** (not `settings/security`, beside `riskEmailNotifications`) so
future SaaS notifications have a home. Existing tabs: `api-keys`, `general`, `profile`, `security`, `storage`,
`workspace`; registry is `ACCOUNT_DATA_TABS` in `core/variables/global.var.ts` and `general` is first. A new
tab is component + template + spec + route in `routes/user/settings.route.ts` + registry entry + i18n in all
five locales — plus the `bun run build` gate, which is the only thing that parses a template.

**A session cannot be driven yet, and that is structural.** `machineId` is absent from
`BrowserSessionPublic` on purpose, and the frame route `03` A.2 specifies —
`GET /api/browser/session/:id/frame` — **does not exist yet**. `execute-task` is NOT the join: it relays
to a hard-coded `https://<FLY_APP>.fly.dev/crawl` pinned by `fly-replay`, so it drives the crawl4ai
contract, not a browser. The real join is a per-machine worker URL or the proxy, and both decide the shape
of access — that is roadmap `03` Part A territory. See `docs/BROWSER-SESSIONS-EXPLAINED.md`.
**Correction to an earlier claim in this file:** `functions/src/handlers/machines.ts` is NOT a handler
table and its name is misleading. It is the **arachnefly client** — a `MachinesHandler` class exporting a
singleton `arachnefly`, whose methods take Express `(req, res, next)`. So "the route has no handler in
`handlers/machines.ts`" was the wrong place to look: the missing piece is a BFF route plus a **new method
on that client**, and `executeTask` in the same file is the template to copy (validate the id first, send
`req.authToken` as a bearer, set an explicit `Content-Length`, never echo the upstream error body).
**Question 1 is ANSWERED (2026-10-04), and the answer corrects the document.** The frame primitive is
`webrain_observe(what="screenshot")` → base64 PNG — **NOT `webrain_screenshot`**, which the binary's own
17-tool list (`AGENT_GUIDE` in `webrain-mcp/src/tools.rs`) does not contain. `TileEngine` is real but
belongs to `webrain_vision` (a tile index), not the frame path. Since the tool returns PNG, **serve
`image/png`**, not A.2's `image/webp` — converting would buy an image codec for a content-type. **Still
open: A.3's "paid 1–2 fps" is a range, not the single server-side cap A.2 rule 2 requires.** That one
number is the only thing left to decide, and A.2 rule 2 defines it as a BILLING control — **now DECIDED,
see the fps note below.**
**Part A's recorded plan is WRONG. Disproved by reading the dependency, 2026-10-10.** The plan said "a
proxy method on `MachinesHandler`, the `.../frame` route, and the fps cap" — i.e. carry the frame through
`HandleContainerProxyFiber`. It cannot. Two INDEPENDENT reasons, each verified in source:
1. **The proxy discards the PATH.** The handler builds `targetAddr` as scheme+host only
   (`http://<id>.vm.<app>.internal:11235`, no path) and calls `proxy.Do`. Fiber v2.52.9's `doAction` runs
   `req.SetRequestURI(addr)`, which REPLACES the URI wholesale — so the machine always receives `GET /`
   and the path the client asked for never arrives. Read in the module cache, not inferred.
2. **The wrapper discards the BODY.** `controller.MakeAPICallback` ends in
   `return c.Status(httpResponse.Code).JSON(httpResponse)` on BOTH the error and the success path, so
   anything `proxy.Do` wrote into `c.Response()` is overwritten by the envelope. The handler's own closing
   comment — "If proxy.Do returns nil, the response has already been written to c.Response()" — is
   therefore FALSE, and `GET /api/machine/proxy/:id` is a **liveness probe answering `{status:true}`**.
   Nothing flows back through it.

GET-only + path-discarding + body-discarding means the proxy can never carry an MCP call. **Part A needs a
NEW POST route in arachnefly**, and the shape is now fully determined:
- arachnefly: `POST /machine/mcp/:id` beside the existing proxy route, SAME `MachineOwnershipMiddleware`,
  forwarding to **`http://<id>.vm.<app>.internal:11235/mcp` with the path INCLUDED in `addr`** (that is
  what makes it reach `/mcp`), and reading `c.Response().Body()` into `Data` BEFORE returning, because
  `MakeAPICallback` is about to overwrite the response with the envelope;
- `bff/api.ts`: `GET /api/browser/session/:id/frame`, owner-scoped via `readBrowserSessionRecord(uid, id)`
  -> 404 before any capture, `Cache-Control: no-store`, and it must serve **`image/png`** (the tool returns
  PNG; converting would buy an image codec for a content-type);
- the fps cap.
**Two of those are DECISIONS, not implementation, which is why this is raised rather than taken.** (a) The
new route lets the BFF drive arbitrary MCP on a tenant machine, which BYPASSES `decideWebrainTool`'s tier
allowlist — defensible only because the machine is leased to exactly one tenant, so I2 is satisfied by the
lease rather than by the allowlist, but it is authorization-adjacent in a live service. (b) A.3's "paid
1-2 fps" is a RANGE, and it is the server-side billing control A.2 rule 2 requires, so it needs one number
per tier. **RESOLVED 2026-10-10 — the number already existed.** `SESSION_CAPS` in
`functions/src/domain/browser-session.domain.ts` has carried `fps` per tier all along: **free 0, paid 1,
admin 4.** The earlier "DECIDED: paid 2" in this file was WRONG — it invented a number that contradicted a
constant already shipping. The lesson is that the cap was never missing, only unwired. It is now read
through `frameIntervalMs()` so the table stays the single source of truth: paid 1000ms, admin 250ms, and
free `Infinity`, which refuses every frame including the first.

**The transport is BUILT and TESTED (2026-10-10).** `POST /machine/mcp/:id` exists in arachnefly —
14 routes now, not 13. `HandleContainerMCP` sits behind the SAME `MachineOwnershipMiddleware`, sends the
MACHINE'S OWN `WEBRAIN_HTTP_TOKEN` (from the machine read that already happened, so no extra Firestore read
and no extra Fly request), refuses a suspended machine with 409 and a tokenless one with 503, and forwards
`Mcp-Session-Id` without inventing one. **It is registered WITHOUT `MakeAPICallback`** — that wrapper calls
`c.Type("json")` then serialises a `domain.HTTPResponse`, so a PNG would arrive labelled `application/json`.
An earlier version of this file said to copy the body into `Data`; that keeps the bytes and loses the
content type. Spec'd: `interfaces/handlers/machine_mcp_test.go`, 6 cases, including an assertion that the
body carries no `Status`/`Code`/`Message` envelope — which is what stops a future "tidy-up" from routing it
back through the wrapper and silently breaking every frame.
**CORRECTED 2026-10-11: the chain was NOT closed, and this file said it was.** Everything existed
except the two things that JOINED it: `browserSessionFrame` was described here and written NOWHERE in the
repo, and `GET /api/browser/session/:id/frame` was not registered in `bff/api.ts`. So every frame poll from
a shipped `<app-browser-frame>` was a 404, while the transport, the provisioner call, the fps helpers and 11
client specs all passed. Third instance of this class after `/api/vision` and `/api/pricing/estimate`; the
method-path list in `route-parity.ts` still cannot see it, because the client builds the path
(`this.base + '/' + id + '/frame?n='`) rather than concatenating a literal onto its root.
Both pieces now exist. The client method did NOT go in `functions/src/handlers/machines.ts` (this file said
it would): `observeMachineFrame()` went beside `suspendBrowserMachine` in the provisioner, where the other
arachnefly calls live, because `callArachnefly` parses a JSON envelope and cannot carry an image.
`browserSessionFrame` in `functions/src/handlers/browser-sessions.ts` resolves the session, refuses a
machine-less one with 409 `no_frame_source`, applies the fps cap, and relays the bytes.
`GET /api/browser/session/:id/frame` is registered in `bff/api.ts` and added to the route inventory in
`bff/api.spec.ts`. Spec'd: `observeMachineFrame` (5 cases) and `frameIntervalMs` / `frameTooSoon`
(6 cases). **The handler itself has NO spec** — that module imports the store, which builds the Admin SDK
at load, so it cannot be imported by a test without an emulator. Its fps state is a module-level Map, so it
is per-INSTANCE: N warm instances permit up to N times the tier's fps.

**A hazard the frame route routes around — and one this file had WRONG (corrected 2026-10-15).**
`webrain_observe` is in `PAID_ONLY_TOOLS` and NOT in `SHARED_UNSAFE_TOOLS`; that much was true, but the
conclusion drawn from it was not. `needsExclusiveWorker` is an OR over `SHARED_UNSAFE_TOOLS` **and
`EXCLUSIVE_PAID_TOOLS`**, and `observe` has been in the second list all along — as have `navigate`,
`interact`, `batch` and `crawl`. So a pooled `webrainTool("webrain_observe", ...)` is **already** refused
on an unleased worker, and the disclosure described here cannot happen. **Do not "fix" it by adding
`observe` to `SHARED_UNSAFE_TOOLS`**: that list is spec-pinned to be a SUBSET of `SHARED_POOL_TOOLS` and
`observe` is not in it. The frame route still never uses the pool — it asks the session's own machine,
which is what makes the image the tenant's own rather than a shared one's.
`webrain_interact` was listed in `EXCLUSIVE_PAID_TOOLS` "although no route exposes it yet" precisely so
the first drive route fails closed; that route is now built
(`POST /api/browser/session/:id/tool`, `SESSION_TOOLS`).
**`SESSION_TOOLS` is now FIVE, not three (2026-10-16): `navigate`, `observe`, `interact`, `batch`,
`crawl`.** The capacity pair was held back for being long-running, and the meter already prices duration
(per started 5-minute block, 20-credit ceiling), so that objection bought nothing -- while it made the new
`/api/batch` and `/api/spider` routes **doors into a wall**, because `needsExclusiveWorker` refuses both on
the unleased `WEBRAIN_MCP_URL` and no pool exists. `download`/`watch` stay out (unbounded bytes, not metered
by payload) and so do `eval`/`eval_in_frame`. **The pool is a cost optimisation, not the unlock**: the lease
is the boundary, which is what makes the machine the first surface these tools can legitimately use.
Note the shape of the guard around all of this: the machine-direct route takes the caller's args RAW by
recorded design, so the mappers on `/api/batch` are narrowing for the POOL and are **not** a boundary on a
machine the caller already owns.
The earlier note stands and is worth keeping: `webrain_observe(what="screenshot")` -> base64 PNG is the
frame primitive, NOT `webrain_screenshot` (absent from the binary's own 17-tool `AGENT_GUIDE`).

**The proxy carries the machine's OWN token now — FIXED 2026-10-04, and it is free.** The old problem: even
with a client method, a frame through `GET /api/machine/proxy/:id` was refused, because arachnefly's
`HandleContainerProxyFiber` did `Header.Del("Authorization")` before forwarding while the machine image's
nginx 401s without it and webrain enforces the token behind that — so relaxing nginx would not have helped.
Deleting the header was RIGHT (a caller's Firebase ID token means nothing to a machine and must not be
carried into another tenant's network position); the defect was deleting it without replacing it. The hop
now sets `Authorization: Bearer <the machine's own WEBRAIN_HTTP_TOKEN>`.
**The token comes from a read that already happened.** `HandleContainerProxyFiber` already calls
`GetMachineDetails`, and Fly's Machines API returns `config.env` on a machine read — which is exactly where
`BuildConfigMap` writes the per-machine token. So this adds **no Firestore document read and no Fly API
request**, which is the thing that matters here: the Machines API allows one request per second per APP,
shared with Create Machine. That efficiency is the reason to prefer forwarding over an admin bypass — a
bypass would also loosen authorization, which forwarding does not. The token is **per-machine, never
platform-wide**, so one machine's token cannot be replayed against another's. An absent token logs a WARN
instead of failing silently: the request still goes out and the machine refuses it with a 401, so without
that line the symptom is an unexplained refusal with nothing to correlate it to.
Note the ADRs still describe `X-Authenticated-User-Id` as the literal `"userID"`; that was fixed and they
are stale.

**Done 2026-10-02:** arachnefly carries Fly's **429** through (typed `*FlyAPIError` + `routines.UpstreamStatus`),
so deepscrape answers **503 `capacity_unavailable`** for a capacity refusal and 502 `deploy_failed` for a
real one, and the deploy path **retries a 429 twice** before giving up. `StartMachine`/`StopMachine`/
`DestroyMachine` still return a flat 500. There is still **no queue** — a sustained backlog is the
caller's problem.

The **env/config matrix is DONE** (2026-10-02) → `docs/ENV_CONFIG_MATRIX.md`. It found six gaps; the one
that blocks a shipped feature is `BROWSER_MACHINE_IMAGE` missing from the `FUNCTIONS_ENV_JSON` secret.

**DEPLOYED 2026-10-04 — both images are published and the engine is LIVE.** Verified by PROBING,
not by reading a deploy log:

| | |
|---|---|
| `WEBRAIN_MCP_URL` | **`https://mcp.deepscrape.dev`** — custom domain, cert ISSUED (Let's Encrypt). `https://deepscrape-webrain.fly.dev` is the same engine |
| custom domain | `mcp.deepscrape.dev` — Fly cert + Cloudflare **DNS-only** A `66.241.124.140` / AAAA `2a09:8280:1::1a6:1b87:0`. Orange-cloud proxying would intercept the ACME HTTP-01 challenge and the cert would never issue; `agent`/`ip` can stay proxied only because they use Fly's `flydns.net` CNAME delegation (DNS-01) instead |
| engine app | `deepscrape-webrain` — `WEBRAIN_HTTP_TOKEN` set as a `fly secrets` entry |
| engine image | `registry.fly.io/deepscrape-webrain:webrain-2026-10-04` |
| **`BROWSER_MACHINE_IMAGE`** | **`registry.fly.io/deepscrape-browser-session:browser-session-2026-10-04`** |
| adapter app | `deepscrape-browser-session` — an IMAGE HOLDER and never deployed; arachnefly creates machines in it |

Probes against the live engine: `GET /health` → **200**, `GET /mcp` → **401**, `GET /` → **401**. So
the process serves, the MCP surface is token-gated, and unauthenticated is refused. Config is
`deploy/webrain-engine/fly.toml`; no `[processes]` section on purpose (a process group's command
SUPERSEDES the image CMD, which is what starts the MCP server).

**Both values still need to reach the BFF's `FUNCTIONS_ENV_JSON`** — `WEBRAIN_MCP_URL` has NO default
(`config/env.ts`), and the token is `WEBRAIN_MCP_TOKEN` there while the engine calls it
`WEBRAIN_HTTP_TOKEN`: **one value, two names, two stores.** A mismatch is a 401 on every call and
presents as "search is broken".

**Orgs: `personal` = dev, `softmind` = prod. `crawlagent` is LEGACY** — do not push to it.
`CheckOrCreateApp` (`arachnefly/interfaces/handlers/fireAuth.go:101`) hard-codes
`"org_slug": "softmind"`, so production machine apps are created there automatically.

**Trap that cost five attempts: `docker push` to `registry.fly.io` for a ~1.1 GB image DIES SILENTLY
at the manifest commit when the launching terminal is recycled** — every layer lands, there is NO
error line, no `digest:`, and exit 1; Fly then reports `Could not find image`. I misdiagnosed it twice
(Docker credential, then a 60 s client timeout); neither was the cause. Run the push inside ONE command
that retries in a loop, and prove success by the presence of **`digest:`**, never by an exit code.
Recipe in `/memories/repo/fly-topology-and-image-push.md`.

**Deploy runbook: `deploy/browser-session/README.md` (added 2026-10-04), and it corrects a registry mistake.**
Push the adapter to **`registry.fly.io/…`, NOT Artifact Registry** — Cloud Run and Hosting pull a private AR
repo because they share the GCP project, but a Fly machine is a different cloud and needs registry
credentials on the Fly app to pull a private repo, which is machinery that rots silently until a customer
starts a session. Fly's registry is org-scoped and is already the shape this repo deploys
(`global.fun.ts:287` has `registry.fly.io/crawlagent:...`). Two more properties worth not rediscovering: the
value is a **secret version set ONCE per environment** (rotating an image = push a tag, edit one line,
`secrets:set`, restart the BFF, no rebuild), and a **local tag can never be this value** because Fly pulls
from a registry — locally `BROWSER_MACHINE_IMAGE` stays empty and §1.4 correctly refuses a dedicated session.
The engine image and the adapter image need **different registries**: the engine is a BUILD input (reachable
from the build machine), the adapter is a RUNTIME input (reachable from Fly).

§1.4 is **DONE** (2026-10-02) and shipped the charge with it: a dedicated session pays the existing
`machines.deploy` action, composed in the route because `access` bills nothing. The machine is named
`bs-<sessionId>`, which makes Fly's own uniqueness rule the idempotency key.

**`BROWSER_MACHINE_IMAGE` — investigated 2026-10-02, and it needs an image published.** No existing image
satisfies `BuildConfigMap`'s contract: webrain's mismatches it four ways (port, loopback-only bind,
entrypoint `["app"]`, and it answers only `/health` while the check is `GET /`), and webrain's image is
**not pullable** (GHCR 403 against a 200 control). `deploy/browser-session/` is the adapter that fixes
that, and it is **verified in a container** — 200 on `/`, 401 unauthenticated, forwarded when
authenticated, and both guards refuse (wrong `PORT` → 64, no token → 78). Engines are baked in because a
machine has **no volume**. **`docker/Dockerfile` had TWO independent defects; both are FIXED in webrain's working tree (2026-10-03,
UNCOMMITTED — which adds to the uncommitted-work hazard already noted above, so commit it):**

1. The builder pinned `rust:1.85-alpine` while the workspace resolves deps needing rustc 1.88, so
   `cargo build --release` failed. Now `rust:1.88-slim-bookworm`.
2. **The runtime stage was `alpine:3.21` — musl — so it could not exec the engines at all.** Obscura's Linux
   release is `x86_64-unknown-linux-gnu` (glibc ≥ 2.35). Now `debian:12-slim`.

Defect 2 is the one with teeth, and it is MEASURED rather than argued:

| Base | `ldd --version` |
|---|---|
| `alpine:3.21` | `musl libc (x86_64)` |
| `debian:12-slim` | `ldd (Debian GLIBC 2.36-9+deb12u14) 2.36` |

A musl runtime fails **per browser session, at exec, never at build** — it first appears as a browser that
will not start, not as a red build. Both `rust:1.88-slim-bookworm` and `debian:12-slim` confirmed to exist.

**Then the build was actually run (2026-10-03), and it found a THIRD defect that reading could not.** With
both packaging fixes in place the whole dependency graph compiled and `webrain-core` plus `webrain-mcp`
built cleanly — so the base-image change was correct. It then failed on webrain's own **source**:

```
error[E0658]: use of unstable library feature `round_char_boundary`
  --> webrain-cli/src/main.rs:88:34
88 |  let end = state.text.floor_char_boundary(state.text.len().min(2000));
```

`str::floor_char_boundary` is not stable in rustc 1.88, and `--release` treats E0658 as a hard error. The
repo declares `rust-version = "1.85"`, so its own manifest is wrong about what it needs. Replaced with the
stable equivalent (`is_char_boundary` walking back from the cap) — same behaviour, no toolchain bump, and a
sweep confirmed it was the only use in the tree.

A fourth, smaller defect came out of Docker's own lint: `$TARGETARCH` was used inside the build stage
without being declared, so it expanded to **empty** and the arch-keyed target cache its comment promised was
really one shared key. Fixed with `ARG TARGETARCH`.

**Lesson worth keeping:** the adapter's Dockerfile documents the same 1.88 fix and calls it sufficient. It is
right about the *packaging* — and the source still would not compile. Two documents agreeing did not find
this; running the build did.

**RESULT (2026-10-03): the image BUILDS.** After the source fix the same build completed —
`Finished release profile [optimized] target(s) in 5m 53s` — producing `webrain:local` (1.14 GB). The runtime
was then probed, and it satisfies the exact constraint this whole exercise was about:

| Check | Result |
|---|---|
| glibc | `2.36-9+deb12u14` |
| `/lib64/ld-linux-x86-64.so.2` | **exists** — the very file a musl base lacks, and the reason Obscura fails at EXEC instead of at build |
| chromium | `/usr/bin/chromium` |
| the binary runs | usage lists `install`, `obscura`, `lightpanda`, `fetch`, `screenshot` |

**The first link of the chain is therefore MEASURED, not argued.** `BROWSER_MACHINE_IMAGE` can point at an
image that builds and can exec a glibc engine. The next link is the adapter:
`docker build --build-arg WEBRAIN_IMAGE=webrain:local deploy/browser-session`, which fetches Obscura and
Lightpanda at build time — the image IS the engine cache, because a machine has no volume. The env values,
and why the exclusive-worker pool is *not* this, are in `docs/ENV_CONFIG_MATRIX.md` §4.1–4.2.

**RESULT (2026-10-03): the adapter BUILDS and PASSES its probes.** The chain is now measured end to end.

Its lightpanda fetch is why a fifth defect was waiting. `fetch_chunk` in `webrain-core/src/install.rs`
hard-coded `.timeout_global(Some(Duration::from_secs(60)))`, and this download takes **218.3 s** —
`lightpanda-x86_64-linux: 179.7 MB in 218.3s`. Obscura's tarball (67.6 MB in 44.3 s) fits inside 60 s and
lightpanda's cannot, so the failure looked engine-specific and was not. The limit is now
`WEBRAIN_FETCH_TIMEOUT_SECS`, default **300**, applied per attempt; 60 s was never a considered value, it was
a number that happened to suit the smaller artefact. **Because `install.rs` compiles into the webrain
binary, the webrain image has to be rebuilt before the adapter can benefit** — the fix is invisible until
then, and a fully-cached `docker build` is not evidence that it is present. (Prove it in the artefact:
`grep -ac WEBRAIN_FETCH_TIMEOUT_SECS /usr/local/bin/webrain` returns 1. `strings` is absent from
`debian:12-slim`, so a `strings | grep` that reports nothing is the tool missing, not the fix.)

| Probe | Expected | Result |
|---|---|---|
| no `WEBRAIN_HTTP_TOKEN` | refuse to serve | **78** |
| `PORT=9999` | refuse — nginx listens on 11235 only | **64** |
| `GET /` with a token set | health check answers | **200** |
| `GET /mcp` without `Authorization` | gate stays closed | **401** |
| `GET /mcp` with the bearer header | forwarded to webrain, accepted | **200** |

`browser-session:local` is 1.62 GB and carries all three engines — chromium from `apt`, obscura and
lightpanda baked in at build time. That is roadmap step 6 satisfied for the machine image. **Nothing was
deployed:** this is a local image and a local probe, and the machine-level checks (Fly services, secrets,
route-in-`bff/api.ts`) are untouched.

The image now **asserts that all three engines EXECUTE at build time** (0.4 s, verified in the layer log),
because a musl base installed Obscura successfully and only failed when a session started it. Never trust
an install you did not execute — that single rule is what the whole image chain cost.

**`needs_js` is wired (2026-10-03).** `webrain_scrape` — i.e. `/api/scrape`, a free live route — has always
reported whether a page turned out to be a JS shell; nothing read it. Now parsed in
`domain/webrain-signals.domain.ts` and surfaced on `WebrainToolResult`, with **absent kept distinct from
`false`** (a tool that never reports it must not look like a page that fetched cleanly). This is the trigger
for the escalation ladder in `06`, and it corrects the earlier claim that the signal lived only on
`fetch_http`, a tool we do not expose.

**The `/api/extract` and `/api/pdf` cross-tenant read is CLOSED at the shared-worker axis (2026-10-04).** The
hazard: the platform sends no `Mcp-Session-Id`, so every tenant's call resolved to webrain's single
`"default"` session — and neither tool takes a URL (`webrain_extract` reads "the CURRENT page",
`webrain_pdf(op=page)` saves it), so a free caller could read the page the previous caller left. **The
prerequisite check came first and it changed the fix:** `WEBRAIN_NO_STATE` does NOT cover these two (it
refuses exactly `profiles`, `launch`, `login`), so the guard had to be ours. `SHARED_UNSAFE_TOOLS` +
`needsExclusiveWorker()` now refuse them when the acquired target is **not leased**, and
`WorkerTarget.leased` is exactly that signal: `use-single` returns `leased: false` (the single
`WEBRAIN_MCP_URL` is shared), a pooled claim returns `leased: true` (exclusive). **The check sits AFTER the
acquire, not with the tier decision, because that is the first point at which the worker is known** — and it
is free there, since the unleased path never took a lease to give back. They stay in `SHARED_POOL_TOOLS` on
purpose: the requirement is exclusivity, not a tier, so a **paid caller on a leased worker keeps both tools**.
**Do NOT "simplify" this into `PAID_ONLY_TOOLS`** — that would refuse a paid caller where the tools are
correct, and would hide the real axis behind a proxy for it. Spec'd (582 tests / 573 pass / 0 fail).

**Why the session-id fix was NOT the first move, so it is not re-attempted blindly.** `webrainTool(name,
accessMode, args)` receives **no tenant identity**, so `Mcp-Session-Id` cannot be derived without threading a
uid through every call site. And a session id **without worker affinity is worse than nothing** for these two
tools: `acquireWorkerTarget` leases per CALL, so a pinned session that lands on a different worker reads a
blank page — a silent wrong answer replacing a leak. Session id **and** affinity ship together or not at all,
and both belong with the pool (`06`). This also makes `docs/roadmap/README.md`'s "one-page answer" premise
("`extract`/`pdf` cannot work on a shared pool, so there is nothing to share") **true rather than assumed**.

**The VAULT tools are refused until the per-machine join exists (2026-10-04).** `webrain_profiles`,
`webrain_login`, `webrain_launch` and `webrain_session` are `VAULT_TOOLS`, and `needsCallerOwnWorker()`
refuses them for every non-admin tier **before** a worker is acquired. The reason is a SECOND axis, and it is
deliberately not the `leased` one: webrain's vault is **process-global**
(`ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md:111`), and the pool REUSES a worker across tenants, so a profile
written on a pooled worker outlives the lease that wrote it and is readable by whoever leases that worker
next. A pooled lease is exclusive *for the call*; what persists here is the *process*. So `SHARED_UNSAFE`
(needs a worker nobody is in) and `VAULT_TOOLS` (needs one that outlives my visit) are two predicates, and
neither implies the other. **The join EXISTS now (2026-10-16), and it deliberately does NOT satisfy this
predicate.** `acquireWorkerTarget` takes a caller's own machine as its FIRST source -- an `OwnMachine`
resolved by `ownBrowserMachine(uid)` from their live lease -- ahead of the pool and the single
`WEBRAIN_MCP_URL`. What that join offers is a machine for the DURATION of a session, and these four write to
`profiles_dir()` expecting the state to still be there afterwards, which no ephemeral machine provides (see
the profiles note below: no volume, and Fly resets the root filesystem). So they stay refused, and
`needsCallerOwnWorker` is what keeps the "run it on my machine" route from quietly writing a customer's
credentials into a platform worker. These four are **not routed** today (only `scripts/webrain-smoke.ts`
probes them), so this is latent rather than live: the guard exists so the first `/api/browser/profiles` route
fails closed instead of writing a customer's credentials into a platform worker. Admin is exempt, matching
the allowlist's own decision. Spec'd (586 tests / 0 fail).

**Profiles are NOT durable, and the landing page says they are (verified 2026-10-04).** Three facts, and they
compound: the vault is process-global (above); `BuildConfigMap` sets no `mounts`, so a session machine has
**no volume** (`deploy/browser-session/Dockerfile:47`); and Fly **resets a stopped machine's root filesystem**
(same comment), while suspending idle machines is the reaper's whole job on a 15-minute clock. So a profile
lives only as long as one un-suspended machine. ~~yet `src/assets/i18n/en.json:401` advertises *"Persistent
stealth browser profiles with an encrypted credential vault, native login…"*. That is a published claim the
platform cannot honour, which makes the storage work a CORRECTNESS item rather than a feature.~~
**CORRECTED 2026-10-16: the copy no longer claims persistence.** It was fixed in all five locales by
`cc2fcbe` ("describe the profile directory instead of promising persistence"), and `A8` now states that
credentials are held *"for the duration of the session rather than saved as a permanent browser profile"*.
So the published copy and the platform agree, and what remains is the storage work itself — a FEATURE gap
rather than a false claim. One over-claim in that copy did survive and was fixed separately (`c15c0ab`):
`A3` advertised "our browser pool", and there is no pool. The shape to
build is the one BYO storage already uses: blob encrypted under a per-tenant data key in the tenant's bucket
via `resolveBlobStore`, and the **key** (never the blob) in Secret Manager. Secret Manager is the wrong home
for the blob itself: thousands of per-tenant cookie jars, every read billed and audited, size-capped. Do NOT
build a profiles UI before the vault can outlive a machine — it would only make the loss harder to see. Detail
and the option table are in `docs/roadmap/06-browser-sourcing-options.md`.

**Browser-worker pool — wired 2026-10-03.** A second list in the existing `WEBRAIN_CONFIG` document
(`workers`), not a new service. Select → plan → claim → release lives in `domain/webrain-workers.domain.ts`
plus `infrastructure/webrain-worker-{lease,acquire}.ts`, hooked in `webrain-mcp.ts`. Two properties carry
the weight: `use-single` is reachable **only** with no pool, so a busy pool cannot degrade into the shared
worker; and the lease **fails closed** — the no-op Redis stub answers `"OK"` to `set`, so a real holder
**string** is required. `webrainHealth` must **not** acquire (a probe would exhaust the pool while
reporting healthy). Behaviour is unchanged with no pool. **Not verified against a live engine** — that
needs Redis plus a real worker. Detail, including why the lease covers browserless tools too, is in `06`.

**The credit ledger is RUNTIME VERIFIED (2026-10-03) — it is no longer "never executed".** The money path was
run against a real Firestore emulator (cached jar v1.22.0, local Java 23) through the REAL
`applyBillingCreditMutation`. Six checks, all passed, exit 0: grant/reserve/consume arithmetic correct; **a
meter charge with `reservedDelta: 0` — exactly what `releaseReserved: false` produces — leaves `reserved`
non-negative (8/2)**; **the CONTRAST throws**: the same charge with the DEFAULT `reservedDelta: -1` where
reserved=0 gives `Billing credit mutation would make purchased reserved credits negative`, so the flag is
LOAD-BEARING and not stylistic; and **replaying an applied `idempotencyKey` is a true no-op** (figures
unchanged, ledger count identical before and after). Re-run recipe and gotchas are in
`/memories/repo/billing-credit-runtime-verification.md`. **The layer ABOVE it is RUNTIME VERIFIED too (2026-10-03)** — `chargeSessionMeter`, which BOTH the sweep
and the close route call, against the same emulator. Seven checks, exit 0: `meterWalletFor` returns
undefined for a caller with NO billing document (an unbillable session charges nothing rather than picking
a wallet); BYO and free-tier sessions each charge 0; a **paid 16-minute session charges exactly 3 credits
(blocks 2,3,4 — block 1 rides on `machines.deploy`), 10 -> 7, with `reserved` staying 0 through the whole
charge**; **replaying it charges NOTHING more** (wallet 7, ledger 3, both unchanged, return value 0); and
`minutesBilled` lands at 16. `consumeBillingCredits` reads
`reservedDelta: args.releaseReserved === false ? 0 : -amount`, so it is the OMITTED case that defaults to
`-amount`.

**The WALLET DERIVATION is runtime-verified too (2026-10-03)** — `meterWalletFor`, the function that decides
*whether* a customer is billed at all and from which bucket, which until now was only unit-tested. Ten checks,
exit 0. The derivation is `isPaidPlan(plan) -> plan`; `free && purchasedAvailable > 0 -> credits`;
`hasGraceAccess -> grace`; else `free` — and `machineChargeFor` returns null unless the mode is `credits` or
`plan`, with bucket `credits ? purchased : included`. Three findings that are policy rather than trivia:
**a paid plan wins the bucket even when the customer also holds purchased credits** (their purchased balance
is untouched while the plan is active); **a free-plan user who bought credits IS charged per minute** from
`purchased`, so "the free tier is not metered" refers to the *included* allowance and not to purchased packs;
and **`grace` and `admin` receive a machine and are never charged** — proven by calling `machineChargeFor`
with each mode rather than inferred from its comment. Deploy price observed: `{amount: 5, action:
"machines.deploy"}`.

**And the failure mode is pinned down (2026-10-03).** `machineChargeFor` does **not** consult the balance, so
a paid plan whose included allowance is exhausted still yields a wallet and the refusal happens one layer
down: `Error: Billing credit mutation would make included balance negative` (and the `purchased` equivalent).
It does not degrade to 0, and the meter path has no insufficient-funds branch. That is fail-closed for the
money and it does **not** endanger the sweep — `sweepBrowserMeter` wraps each session in its own `try/catch`,
counts it in `failed`, and deliberately leaves `minutesBilled` unadvanced so the next run re-derives the same
keys and retries, free of double-charging because the ledger keys are deterministic. Per-session isolation
confirmed by reading the loop, not assumed.

**Still NOT covered by any harness:** the sweep's own cadence (a schedule needs a deployed scheduler), the
close-route charge, and the `state` collection-group index (the emulator does not enforce indexes, so
production can still answer `FAILED_PRECONDITION` on the first live sweep). All three harnesses live OUTSIDE
the repo in `%TEMP%\bs-verify\` because `functions` lint enforces max-len 80 + JSDoc; the run recipe is in
`/memories/repo/billing-credit-runtime-verification.md`.

**Phase 6 — frontend wiring, MEASURED (`docs/roadmap/11-frontend-wiring-and-ui.md`, 2026-10-10).** The
master list (operations, playgrounds, browsers, jobs, machines, proxies) was **already built** as routes.
The two real holes were wires, not features: `<app-ai-keys>` had **no mount point anywhere**, and the
`scrape` half of `getMySettings` (plus `setMyScrapeProvider`) had **no consumer at all**, even though
`scrapeMiddleware` already honoured the stored engine on `POST /api/crawl` and all five locales already
carried `SCRAPE_PROVIDER.*`. Both are closed: one component now renders both halves in
`settings/general`, because the server composes them into ONE callable so they cannot disagree about the
plan. Gates: app TSC 0, `bun run build` 0, suite **756 SUCCESS** (unchanged baseline).
**The transferable measurement: grep for a component's SELECTOR across `src/app/**`.** A component can
have a spec, a service, a template and five locales of translations and still be unreachable — and an
unreachable component also escapes `bun run build`, so its template may never have been compiled by ANY
gate. Mounting `app-ai-keys` was the first time its template was parsed at all.

## The execution loop

1. **Audit** — query the code graph for the affected surface. Do not guess a file.
2. **Decide** — if the change touches sourcing, pooling, or the shape of pricing, stop and
   read roadmap `06` and `07` first. Those two decisions are expensive to reverse.
3. **Implement** — smallest correct diff. One edit per file per tool block; batching edits
   to a single file has corrupted it twice in this repository.
4. **Gate** — run the gates for every repo you touched. Not a subset.
5. **Report** — state what changed, what you verified, and what you did not.

## Gates

Exact commands and the traps are in `references/ground-truth.md`. The two rules that matter
most:

- **`bun run build` is the only validator of Angular templates.** `tsc --noEmit` never parses
  templates and Karma only compiles components a spec imports, so a template syntax error in
  a component with no spec passes both gates and appears only in the build.
- **`get_errors` is not evidence.** It has reported "No errors found" on files that could not
  compile. For structural edits use `bunx tsc --noEmit -p tsconfig.app.json`.

Print `"EXIT=$LASTEXITCODE"` immediately after each command. Never read the exit code after a
pipe or a `;` chain — it belongs to the last command, not to the build.

## Pricing rules (do not improvise)

Three instruments, never mixed:

- **Entitlement** — may this principal do it (`perm(...)`, `requirePermission`)
- **Metering** — how much did it consume (credits, minutes)
- **Rate limit** — how fast (`enforceBudget`)

For anything that costs money the check order is: **customer cap → entitlement → credits →
rate limit**. The cap is checked *before* reserving. A cap applied after the charge is a
report, not a limit.

**Price the unit that costs you.** Browser time is per minute. `computeSource`
(`platform` | `byo`) decides whether compute is billable at all — charging compute on a BYO
organization double-bills a customer who already pays Fly directly.

Browser time is never free on platform compute.

## Browser sourcing in one table

| Option | Cost to us | Safety | Ship |
|---|---|---|---|
| Dedicated machine per user | machine count | safe | first — already ~80% built |
| BYO CDP (`cdp_url`) | none | theirs | early — nearly free |
| Exclusive pooled worker | machine count | safe | later — a cost optimisation, not a feature |
| Shared process | lowest | **unsafe** | never |

Engine choice: **Chrome** for SPAs, interactive challenges, and any frame. **Obscura** for
volume (JS yes, SPA no, renders in v0.2.0+ render builds, parallel tabs). **Never** route a
frame request to Lightpanda — its screenshot is a placeholder, so the failure mode is a
plausible wrong image rather than an error. Gate it in code.

**Obscura ships two builds and live view needs the RENDER one.**
`deploy/browser-session/Dockerfile` runs `webrain install obscura`, whose default package IS the
render build; the `-no-render` variants exist and serve **no frames at all**, so `--no-render` must
never be passed on the session image. That is the same class of failure as Lightpanda's placeholder
— a silent wrong answer instead of an error — which is why it is written down rather than
remembered.

## Future direction — a standalone pooling service (NOT BUILT)

Recorded 2026-10-03 at the user's request. **None of this exists yet** — it is a direction to keep
in mind, not a description of the system. The intent is a separate, independently scaled
browser-pooling service that mints **browser session profiles for every engine** (Lightpanda,
Obscura, Playwright/Chrome) instead of one container per tenant.

This is the *Exclusive pooled worker* row above becoming real. Density is the point, and the only
axis it may scale on is **workers per container — never tenants per worker**. I2 says a shared
process is unsafe, so exclusivity *is* the safety boundary: a pooled worker is leased to exactly one
session and released on every exit path, or it is not pooled at all.

Order matters — each step is inert without the one before it:

1. A per-tenant session id that outlives the container (today the session id *is* the machine name).
2. A fail-closed lease per worker — taken before the browser starts, released on teardown and on reap.
3. A queue in front of the pool, because a pool with no queue has no way to say "wait".
4. **Only then** more than one worker per container.

Playwright is the awkward engine: it needs a per-engine bundle and a Node runtime in the image. It is
also the only one here that serves frames *and* SPAs — so if frames must survive the pool, Playwright
(or Chrome) is mandatory and the Obscura render build is the volume fallback, not a replacement.

## Capacity — the Fly create ceiling (verified 2026-10-02)

Machines API limits are **per action, per machine, 1 req/s (burst 3)** — and `Create Machine` is scoped by
**APP**, which every tenant shares. So the platform can create **~1 machine/second**. The deploy path
retries a 429 twice (1s, 3s), which is safe because the machine name comes from the session id and Fly
requires a unique name per app — a retry cannot double-provision. **A sustained backlog still 429s and
returns `capacity_unavailable`: there is no queue.** Machine-scoped actions are scoped per machine, so the
reaper is not exposed. Full detail, and the `FlyRequest` status-read bug fixed alongside it, are in
`references/ground-truth.md`.

## Stop and ask before

- Writing the arachnefly ownership guard (it changes authorization in a service with live traffic)
- Creating a new project or repository
- Deploying anything
- Changing the shape of pricing, or adding an organization-scoped money path
- Forking or vendoring a browser engine

## References

- Verified anchors: `references/ground-truth.md`
- **What a session IS**: `docs/BROWSER-SESSIONS-EXPLAINED.md`
- Env & config matrix (per surface, dev vs prod, and the loader traps): `docs/ENV_CONFIG_MATRIX.md`
- Route-table diff (informational, **not** a gate): `scripts/route-parity.ts`
- Plan: `docs/roadmap/README.md`, then `01`–`07`
- Platform ADR: `docs/ADR-2026-09-PLATFORM-ARCHITECTURE.md`
- Browser ADR: `docs/ADR-2026-10-BROWSER-SESSIONS.md`
