# Phase 1 — machine leasing (and Phase 3, BYO CDP)

Depends on: Phase 0. This is the phase that unblocks `/api/extract`, but **not** before ownership lands.

---

## The model

**Lease one dedicated machine per session. Never share a browser.** Availability comes from warm
*pre-created* machines, not from co-tenancy.

Why the word "pool" is banned here: webrain cannot distinguish callers. Its `session_id` is taken
verbatim from the request, `session(list)` enumerates every session **and its `cdp_url`**, and its only
auth is one process-wide shared secret. Two tenants on one browser means shared cookies, shared
logged-in state, and shared profile state. A pool would rebuild the exact leak Phase 0.2 closes.

### Tier model

| | dedicated machine | BYO CDP session | idle TTL | frames |
|---|---|---|---|---|
| free | 0 | 0 | — | — |
| credits / plan / grace | 1 | 3 | 15 min | 1 fps |
| admin | uncapped | uncapped | — | 4 fps |

Free gets **no browser at all** — not as a limitation but because none of its six tools need one. Its
`extract` / `pdf` stay refused, and that is honest rather than broken.

BYO CDP is refused on a shared worker because `cdp_url` is an SSRF primitive there (Phase 0.4). BYO is a
**paid-tier** feature by construction, not by policy.

---

## 1.1 The domain — pure, no Fly token, fully testable

New `functions/src/domain/browser-session.domain.ts`. Given inputs, return a decision. No I/O, no
Firestore, no clock injection beyond `now`.

```ts
export type BrowserKind = "chrome" | "lightpanda" | "obscura";
export type SessionMode = "dedicated" | "byo";

export type LeaseRequest = {
  tier: "free" | "paid" | "admin";
  mode: SessionMode;
  kind: BrowserKind;
  liveSessions: number;
  byoConfigured: boolean;
};

export type LeaseDecision =
  | {ok: true}
  | {ok: false; reason: "quota" | "byo-not-allowed" | "unsupported-kind" | "cdp-url-refused"};

export const decideLease = (request: LeaseRequest): LeaseDecision => …
export const SESSION_CAPS: Record<…, {dedicated: number; byo: number; fps: number; idleTtlMs: number}> = …
export const idleDeadlineFrom = (lastUsedAt: number, ttlMs: number): number => …
```

**Acceptance:** a table-driven spec covering — free/any → `quota`; paid dedicated at cap → `quota`; paid
BYO without configuration → `byo-not-allowed`; unknown kind → `unsupported-kind`; admin always allowed.
Pin the caps as data so changing a number is one edit and a failing test, not a hunt.

**DONE 2026-10-01** — `functions/src/domain/browser-session.domain.ts` and its spec. Two deviations
worth recording:

- `cdp-url-refused` is unreachable from the specified `LeaseRequest`, which carries no URL. Rather than
  leave a dead variant, it is produced by a companion `decideCdpUrl(raw)` that reuses `isBlockedHost`
  and `TARGET_URL_MAX_LENGTH` from `url-guard.domain.ts` and adds `ws(s)://` to the accepted schemes —
  `isSafeTargetUrl` takes `http(s)` only and would reject every real CDP endpoint.
- "admin always allowed" is read as *never refused for count*. An admin asking for BYO with no endpoint
  configured still gets `byo-not-allowed`: uncapped in number, and an endpoint that does not exist
  cannot be attached to.

## 1.2 The store — DONE

New `functions/src/infrastructure/browser-session.store.ts`.

```
users/{uid}/browserSessions/{sessionId} = {
  mode, kind, state: "starting" | "ready" | "suspended" | "closed",
  machineId,          // the arachnefly / Fly machine id, when mode === "dedicated"
  cdpSecretPath,      // Secret Manager pointer, when mode === "byo"
  createdAt, lastUsedAt, idleDeadline, minutesBilled,
}
```

The same split as BYOB storage, for the same reason: **a BYO CDP URL carries a token, so it is a
credential** and goes to Secret Manager through `upsertSecretValue`, with Firestore holding only the
pointer. Never the URL, never the token in a document.

Reuse, do not reinvent: `getSecretFromManager`, `upsertSecretValue`, `purgeSecretAndAllRevisions`,
`readStorageSettings`'s projection discipline (a public shape with no field a secret could occupy).

### What shipped

- Class file: `functions/src/domain/browser-session.domain.ts` — `SESSION_STATES`, the two record
  shapes, `toPublicSession`, `idleDeadlineForTier`, `initialStateFor`, `cdpSecretId`.
- Store: `BROWSER_SESSIONS_COLLECTION`, `parseSession`, and five operations — `createBrowserSession`,
  `readBrowserSession`, `listBrowserSessions`, `keepaliveBrowserSession`, `closeBrowserSession`.
- Gate: `TSC_EXIT=0`, `LINT_EXIT=0`, `TEST_EXIT=0` — 462 tests, 453 pass, 0 fail, 9 skipped.

### Decisions taken while implementing

- **The record also carries `tier`.** Not in the spec above, but the idle deadline and metering both
  need it and the lease that produced the session already knows it.
- **`expiresAt` and `idleDeadline` are one value, not two.** The plan used both names; the record
  keeps `idleDeadline`, and the public shape exposes it as `expiresAt`. Do not add a second field.
- **A zero idle TTL omits the deadline.** `free` and `admin` have `idleTtlMs: 0`, so
  `lastUsedAt + 0` would be a past instant and a reaper would expire those sessions at once.
  `idleDeadlineForTier` returns `undefined`, and `toPublicSession` then omits `expiresAt`.
- **The BYO secret is per user (`browser-cdp-${uid}`), not per session.** The endpoint is the
  caller's configuration; one secret per session would multiply credentials holding one value. So
  `closeBrowserSession` deliberately does **not** purge it — another session may still be attached.
  Clearing BYO config is a separate operation (§1.7).
- **`createBrowserSession` runs `decideCdpUrl` itself,** so the SSRF guard is unskippable at the
  credential boundary rather than trusting a future caller to remember it.
- **Initial state: `byo → "ready"`, `dedicated → "starting"`.** Nothing has to be provisioned for a
  BYO endpoint; a dedicated session is not serviceable until a machine exists.
- **`listBrowserSessions` omits `closed`** — deliberately the same set `decideLease` counts as
  `liveSessions`, so §1.3 can feed it straight into the decision.
- **`tier` is validated against `SESSION_CAPS` keys** via `hasOwnProperty`, so there is no second
  tier list to drift out of sync (and `constructor` is not a tier).
- **No new Firestore index.** Per-uid subcollection, single-field reads — `firestore.indexes.json`
  stays empty for this store.

### Known gaps, deliberately not built yet

- Nothing writes `machineId` or moves a session out of `starting`. The machine flow is §1.4's, and
  building it now would be speculation — `machineId` exists in the type and is unset.
- The store has no spec, matching the other four stores. The projection invariant is covered
  behaviourally in the domain spec (`toPublicSession` drops `machineId` and `cdpSecretPath`); a
  source-shape spec is worth adding when §1.3 wires the route.
- **Still true, and it is exactly why the fix below is unproven:** nothing in the suite imports the
  store.
- The operation list in *What shipped* above has since moved on: `readBrowserSession` was replaced by
  `readBrowserSessionRecord` (stored shape, for the close path) and `attachMachine` was added. Both are
  §1.4's.

### FIXED 2026-10-02 — the cap is now enforced atomically (it was a TOCTOU)

`browserSessionCreate` read the live sessions, decided, then called `createBrowserSession`, which wrote
a freshly UUID'd document — a read-then-write with nothing between them. Two concurrent POSTs both saw
the same count, both passed `decideLease`, and both wrote. The guard chain is `access` +
`perm('crawl','execute')`: there is **no idempotency key and nothing serialising a caller**, so a
double-submit was enough to exceed the cap. A tier capped at one dedicated session could hold several,
each with its own Fly machine — and what the cap failed to bound is platform compute, i.e. money.

The store now **owns** the decision and does the count and the write in **one Firestore transaction**,
reading the caller's subcollection inside it. A concurrent insert changes the result of that read, so
Firestore aborts and replays the second transaction, which then sees the first session and refuses with
`quota`.

`decideLease` moved into the store for that reason: a count read in the route and passed down was read
*before* the transaction, which is the race itself. The route's check survives as a **pre-flight** — it
preserves the order refusals are reported in, and avoids storing a BYO credential for a request that is
refused outright. Both checks return the same `decideLease` reason, so `refusalFor` maps them
identically and the caller cannot tell which answered.

`upsertSecretValue` stays **outside** the transaction deliberately: a transaction body is re-run from
the top on contention, so Secret Manager I/O inside it would run once per retry.

**Caveat, stated because it matters:** the suite is unchanged before and after (510 tests, 501 pass, 0
fail, 9 skipped), which means **no test executes this path** — the store builds the Admin SDK on load
and needs an emulator. The atomicity is argued from Firestore's documented semantics and type-checked
(`TSC_EXIT=0`), but it is **not proven**. Proving it wants the Firestore emulator, or two concurrent
POSTs against a real project.

## 1.3 Routes (BFF, Elysia)

Add to `bff/api.ts` **only**. The `syncaiapi.ts` route table is **not mounted** (see `05` Part A), so
there is no second table to update — an earlier version of this step said otherwise and was wrong.

```ts
POST /api/browser/session            { mode, kind, cdpUrl? }  -> { id, state, kind, expiresAt }
GET  /api/browser/session                                     -> { sessions: [...] }
POST /api/browser/session/:id/keepalive                       -> { id, expiresAt }
POST /api/browser/session/:id/close                           -> { id, state: "closed" }
GET  /api/browser/session/:id/frame                           -> image/webp   (Phase 2)
```

Guard: `guard([access, perm('crawl', 'execute'), …])` — `access`, not `paid`, so a free caller gets a
clear refusal from the domain rather than a generic 402. Metering is separate and explicit.

Every response is scoped to `req.user.uid`; a foreign session id answers **404, never 403**, matching the
monitors and storage routes so an id cannot be probed for existence.

### DONE 2026-10-01

Shipped `functions/src/handlers/browser-sessions.ts` and the four routes above in `bff/api.ts`, each
guarded `guard([access, perm('crawl', 'execute'), …])`. The `:id/frame` route is Phase 2 and was not built.

Decisions taken while implementing:

- **The create route re-vets the CDP URL.** The handler asks `decideLease`; the store then runs
  `decideCdpUrl` again before writing the credential. The duplication is deliberate — the guard has to
  sit at the credential boundary, where a later caller cannot skip it by forgetting to ask first.
- **`byoConfigured` is true when the body carries a `cdpUrl`.** A BYO caller configures their endpoint
  *by* this request, so a first-time caller is not refused for the very thing they are supplying.
- **Refusals map to three statuses, never 402:** `unsupported-kind` and `cdp-url-refused` → 400,
  `byo-not-allowed` → 403, `quota` → 429. The precise reason travels in `code`, so a client branches on
  a stable string instead of a status. A free caller asking for a browser gets
  `429 {code: "quota"}`, which names the actual obstacle.
- **`tier` resolves once, through the existing `webrainTierFor`** — no second mapper. It already reads
  `credits`/`plan`/`grace` as paid and defaults an unknown mode to free, which is exactly the mapping
  the domain header asks for. Resolving it twice would let the lease decision and the stored record
  disagree if the two call sites drifted.
- **Every response is `BrowserSessionPublic`**, so a response cannot carry `machineId` or
  `cdpSecretPath` even by accident — the type has no field for either.
- The four routes were added to the `api.spec.ts` route table, so each is asserted to reach the JWT
  guard; a dropped `/api` prefix or a typo'd segment fails that spec rather than shipping.

Gate: `FUNC_TSC_EXIT=0`, `FUNC_LINT_EXIT=0`, `FUNC_TEST_EXIT=0` (462 tests, 453 pass, 0 fail, 9
skipped), `BFF_TSC_EXIT=0`, `BFF_TEST_EXIT=0` (70 pass, 0 fail).

Known loose end: `readBrowserSession` is exported from the store and **nothing calls it** — the route
table above has no `GET /api/browser/session/:id`. Wire it up or delete it rather than leaving it.

### Where the request mapping lives, and why (added 2026-10-01)

The handler cannot be imported by a test: it imports the store, which builds the Admin SDK and a Secret
Manager client on load, so anything defined inside it is unreachable without an emulator — the wall
`storage.spec.ts` hit and worked around with a source-shape spec.

So the HTTP-facing half lives in the **domain**, where it is pure and therefore behavioural-testable:
`parseCreateRequest` (validates `mode` and `kind` against `BROWSER_KINDS` at runtime, folds a blank
`cdpUrl` down to absent), `refusalFor`, and the two refusal tables. `serp.ts` splits its pure mapping out
for exactly this reason and is the pattern to copy. The handler is now thin enough to read in one pass.

`browser-session-request.spec.ts` pins the parts a passing request would not reveal: that no refusal is
**402**, that an unknown engine is refused rather than cast through, and that a whitespace-only `cdpUrl`
reads as absent — which matters because `byoConfigured` is derived from it, so treating blank as
configured would move the refusal to a later and less obvious place.

Gate: `FUNC_TSC_EXIT=0`, `FUNC_LINT_EXIT=0`, `FUNC_TEST_EXIT=0` (474 tests, 465 pass, 0 fail, 9 skipped),
`BFF_TSC_EXIT=0`, `BFF_TEST_EXIT=0` (70 pass, 0 fail).

## 1.4 arachnefly is the control plane — extend it, do not replace it

| Need | Existing endpoint |
|---|---|
| create the machine | `POST /deploy` |
| start / warm | `PUT /machine/:id/start` |
| suspend on idle | `PUT /machine/:id/suspend` |
| destroy at TTL | `DELETE /machine/:id` |
| reach the container | `GET /machine/proxy/:id` |
| readiness | `GET /machine/waitforstate/:machineId` |

After Phase 0 these are owner-checked, so the leasing layer does not re-implement authorization — it
just calls them with the caller's own token. The deploy path is the one that is actually wired today,
through `deployBrowserMachine` in `infrastructure/browser-session.provisioner.ts`.

### §1.4 — DONE 2026-10-02, with the charge composed rather than inherited

The charge question below was answered the recommended way, because the alternative is a revenue hole: a
dedicated session's machine is charged at the **existing `machines.deploy` action**, read from
`resolveBillingPricingPolicy("POST", "/machines/deploy")` rather than restated, and per-minute browser time
stays §1.6's business.

What that required, since `access` bills nothing:

- `domain/browser-session.domain.ts` — `machineRequestFor`, `machineNameFor`, `BROWSER_MACHINE_SIZE`, and
  `machineChargeFor(accessMode, price)`: the money decision, pure and therefore testable.
- `infrastructure/browser-session.provisioner.ts` — `deployBrowserMachine`, the one place that talks to
  arachnefly's `POST /api/deploy`, with the caller's token relayed verbatim.
- `infrastructure/browser-session.store.ts` — `attachMachine`, which writes `machineId` and moves the
  session to `ready`.
- `handlers/browser-sessions.ts` — reserve → deploy → attach → consume, with a failure at either
  provisioning step closing the session and releasing the reservation.

The order is deliberate: **the record is written before the machine is asked for.** Doing it the other way
is exactly the failure the schema note below describes — a machine that exists with nothing pointing at it.
A `byo` session provisions nothing and is never charged.

**Machine naming is the idempotency key.** Fly requires a unique name per app, so the machine is named
`bs-<sessionId>`. A deploy retried for the same session is refused by Fly rather than creating a second VM
the platform would keep paying for, and a machine seen in the dashboard traces back to its session — which
is what the reaper's logs depend on.

**Two gaps this does not close, both honest limits rather than oversights:**

1. **A machine can still be orphaned.** arachnefly creates the Fly machine and *then* writes its own
   Firestore record; if that write fails it answers 500 with no machine id, so the machine exists and
   nothing on this side can name it. The name is derived from the session id precisely so that case is
   reconcilable by name later — but nothing reconciles it today.
2. **`BROWSER_MACHINE_IMAGE` has no default,** deliberately, matching `WEBRAIN_MCP_URL`: a new provider
   must not inherit "some image is assumed". Until it is set, a dedicated session is refused with
   `image is not configured`. **It must be set before dedicated sessions work.**

#### Closing a session releases its machine (fixed 2026-10-02)

Closing a session used to mark the record `closed` and release nothing. That was a live cost leak once
§1.4 began creating machines, and it could not be fixed from the reaper: `DecideReap` returns
`ReapReasonClosed` and deliberately does **not** reap a closed session, so the only thing that can release
that machine is the close path itself.

What close does now, in order:

1. Read the session as **stored**, not as public — `machineId` is absent from `BrowserSessionPublic`, so the
   projected read could not tell whether there was a machine to release. (`readBrowserSessionRecord`
   replaces the exported-but-unused `readBrowserSession`.)
2. If it is `dedicated`, not already closed, and has a `machineId`, **suspend** it via arachnefly
   `PUT /api/machine/:id/suspend`, with the caller's own token so the ownership middleware applies.
3. Only then mark the record closed.

**A failed release leaves the session OPEN and answers 502.** That looks like the worse outcome and is the
safer one: the session keeps its idle deadline and stays visible to the reaper, which suspends it at the
deadline instead. Marking it closed on a failed release would trade a retryable error for a permanent
leak.

**Suspend, not destroy.** arachnefly's destroy path gates on `Machine.CanDelete()` and answers 400 for a
machine still in a transition — which is exactly the state a session is in moments after opening. Suspend
has no such gate, and it stops CPU and memory billing, the dominant cost. Rootfs survives and keeps costing
a fraction; a TTL destroy sweep is the follow-on, and it needs a TTL so it cannot race a caller who
reopens.

Not covered by a test: the handler's composition itself, because the handler imports the store and so needs
an emulator. The decisions it composes (`decideLease`, `machineChargeFor`, `machineRequestFor`) and the
deploy call are all tested; the glue between them is read, not asserted.

#### The charge question, kept for the record

Two facts, both read directly from the code, and together they were a revenue hole:

1. `POST /api/machines/deploy` (`bff/api.ts:474`) is guarded `guard([paid, perm('machine','deploy'), …])`,
   and `paid` is `requirePaidAccess` — **the only middleware that charges**, via
   `resolveBillingPricingPolicy`. The table has
   `{method: "POST", pattern: "^/machines/deploy$", policy: {action: "machines.deploy", credits: 5}}`
   (`billing-pricing.domain.ts:22`). A manual deploy therefore costs **5 credits**.
2. `POST /api/browser/session` is guarded `guard([access, perm('crawl','execute'), …])`. `access` is
   `resolveAccess`, which **charges nothing** — its own doc says so.

So a session-create that called arachnefly `/deploy` would have been charged **nothing**: the 5-credit
action is skipped because the charge lives in a middleware this route does not use. Adding a pricing row
would not have fixed it either — see §1.6.

Exposure was bounded but real: `SESSION_CAPS.paid.dedicated` is **1**, so each paid caller could hold **one
Fly VM the platform never billed for**. A free caller was never exposed — `SESSION_CAPS.free.dedicated` is
0, so `decideLease` refuses `dedicated` before any deploy is attempted.

### `machine.schema.json` — validate the REQUEST, not Fly's response (verified 2026-10-01)

`DeployMachine` validates the machine map that **Fly returned** (`CreateMachine` →
`gojsonschema.Validate`), and that check sits *after* `FlyRequest` has already created the machine.
Two consequences, both verified:

- **It cannot protect anything.** The only thing a failure can do is skip the Firestore write, leaving
  a running machine on Fly with no record of it — it **orphans** the very resource it was meant to guard.
- **It does not currently run at all.** The committed schema's root keys are `["schema"]`, so every
  constraint is nested under a property that is not a JSON Schema keyword, and the loaded document has
  no validation keywords. It accepts anything. (`CreateMachine` hand-checks `machine["id"]` first —
  that is the validation that actually happens.)

So do **not** switch the schema on as-is: with the check in its current position that is a safety
downgrade, not an upgrade. The check worth having validates `machineConfig` **before** `SaveDeployment`
and `FlyRequest`, where a refusal costs nothing.

Groundwork is in place for whichever way you go: the file is tracked and no longer ignored, the loader
fatal-errors rather than degrading to an empty schema, and `scripts/gen-machine-schema` regenerates it
from Fly's live spec — `https://docs.fly.io/api/machines/openapi.json` (the old
`docs.machines.dev/swagger/doc.json` is a **404** now). The generator's output is a correct
self-contained draft-07 schema ready to adopt. Details: `references/ground-truth.md`.

**Warm capacity:** pre-create suspended machines per tier and keep them (`min_machines_running`,
`auto_stop`). Stopped machines cost **~$0.15/GB rootfs/month**, so a warm spare is nearly free; starting
one is sub-second. This is what "availability" means here — not a shared browser.

## 1.5 The reaper — required, not optional

A leased machine nobody releases burns money, and a closed tab must not be able to leak one.

### Prerequisites — re-checked 2026-10-01, two of the three are now resolved

1. ~~**No session store.**~~ **Resolved by §1.2.** `browserSessions` now exists in code:
   `functions/src/domain/browser-session.domain.ts` defines the record (`mode`, `kind`, `state`,
   `machineId`, `lastUsedAt`, `idleDeadline`) and `infrastructure/browser-session.store.ts` reads and
   writes `users/{uid}/browserSessions/{sessionId}`.

2. **The idle clock now exists — per session, which is the clock the reaper actually needs.**
   `lastUsedAt` and `idleDeadline` are epoch-millis numbers on the session record, written on create and
   pushed out by `keepaliveBrowserSession`. Two things follow that the reaper must get right:
   `idleDeadlineForTier` returns **undefined** for `free` and `admin` (`idleTtlMs: 0`), so a session with
   no deadline must be SKIPPED, not read as "expired now"; and a machine's own `updated_at` is still only
   written when a handler runs, so the session deadline is the only usable clock in either repo.

   **Answered 2026-10-01: use a collection-group query, and no new field is needed.** arachnefly already
   does exactly this in `GetAllMachinesGroupedByUser` (`interfaces/repository/firestore.go:255`):
   `fs.db.Client().CollectionGroup(domain.MachinesCollection).Documents(fs.db.Ctx())`, recovering the
   owner with `doc.Ref.Parent.Parent.ID`. The pattern, the `Client()`/`Ctx()` seam and the parent-path
   trick all already exist, so the browser reaper is the same walk over `browserSessions`. Two
   corrections to what this section previously claimed:

   - A `collectionGroup("browserSessions")` query IS required — the in-process placement does not remove
     it — so a collection-group index on `idleDeadline` must be added to `firestore.indexes.json`.
   - **`ownerUid` as a field is NOT needed.** The owner comes from the document path, and suspending needs
     only `machineId`, which the record already carries. The earlier note that the field would be required
     was wrong.

3. ~~**No service identity that can suspend.**~~ **Moot — resolved by placing the reaper in-process.**
   The identity constraint below is what rules out a Cloud Function, and it is unchanged; it simply stops
   applying once the reaper is an arachnefly `cron.AddFunc`.

### Where the reaper runs — the identity constraint

`FireAuthMiddleware` verifies a **Firebase ID token** (`interfaces/controller/middleware.go:34`,
`VerifyIDToken`); a service-account or OAuth token is rejected outright. Phase 0's ownership guard then
requires the caller's uid to equal the machine's owner. The BFF's
`PUT /api/machines/machine/:id/suspend` (`bff/api.ts:473-478`) sits behind `paid` +
`perm('machine','update')` and relays `req.authToken` verbatim (`handlers/machines.ts:442`).

So a Cloud Function on a schedule **cannot** suspend a machine through either path. It would have to
mint an ID token for the owning uid — impersonating the user, and holding that power for every user.

**Resolution: the reaper belongs inside arachnefly, not in a Cloud Function.** arachnefly already runs an
in-process cron — `synchronizer.go:34`, `cron.AddFunc("@every 1m", s.syncMachines)` — and a reaper is
another `AddFunc` beside it. In-process it is already inside the trust boundary: no HTTP hop, no token,
no `/api` route, nothing to 404, and no user impersonation. It also removes the need for the
collection-group query and its missing index described below.

An earlier version of this section specified `functions/src/gfunctions/browser-sessions.ts` with
`onSchedule("*/5 * * * *")`. That cannot work — and `monitors.ts` is not the template for it:
`monitors.ts` authenticates to **webrain** with a bearer secret (`webrainMcpToken()`), not with a user
identity, which is exactly the difference that matters here.

### Where Upstash fits — and the one place it must NOT (2026-10-01)

The platform already runs Upstash Redis (rate limits, session cache, geo cache) and QStash (crawl jobs).
Three candidates for this feature, and only two survive scrutiny:

- **Redis as the reap INDEX — no.** The obvious win is a sorted set keyed by deadline
  (`ZADD`/`ZRANGEBYSCORE`) instead of a Firestore query: O(log N), sub-millisecond, zero document reads.
  It is also exactly what **I3 forbids.** Redis is a cache; if the key is evicted or flushed, the reaper
  finds nothing and every machine runs forever — a spend control that cannot read its counter, which is
  the failure this reaper exists to prevent. `idleDeadline` is durable in Firestore, and the query only
  reads the sessions that ARE due, so it is already proportional to the work rather than to the corpus.
  **Firestore stays the authority.**
- **Redis as a reap LOCK — yes, once arachnefly runs more than one instance.** Each instance runs its own
  `cron.AddFunc`, so N instances reap N times concurrently. `SET key NX EX 50` around a pass dedupes that.
  Not needed at one instance, and `fly-autoscaler.toml` in the repo means it is needed shortly after.
  Failing to get the lock means another instance is reaping, which is safe.
- **Redis to absorb KEEPALIVES — yes, and this is the real win.** `keepaliveBrowserSession` writes to
  Firestore on every heartbeat; at a 30s interval that is a document write per session per 30s.
  Buffering the heartbeat in Redis and flushing `lastUsedAt` to Firestore periodically is the platform's
  existing pattern (hot ephemeral state in Upstash, the record in Firestore), and it fails SAFE: if Redis
  is unavailable, writes go straight back to Firestore rather than the heartbeat being lost.
  **Not built yet** — it belongs with §1.3's store once the reaper's Firestore layer exists.
- **QStash to trigger the reap — no.** QStash delivers over HTTP, and arachnefly's `/api` accepts only a
  Firebase ID token, so this reintroduces precisely the service-identity surface the in-process placement
  removed. **Upstash Box is not runtime infrastructure** and an LLM has no business in a money path.

### §1.5 — DONE 2026-10-02

The config question was answered (see below) and the remaining work landed as one atomic set:
`NewFirestore` gained `flyApp`/`flyApiUrl`; `*Firestore` implements **both** `reaper.Sessions`
(`DueSessions`) and `reaper.Releaser` (`SuspendMachine`, `CloseSession`) so the synchronizer passes one
value twice instead of wrapping it; `Synchronizer.reapIdleSessions` runs on the **existing** cron beside
`syncMachines` and logs the report; `main.go` injects the two values. Gate: gofmt clean, BUILD/VET/TEST 0.

**The switch is now thrown in source** — the next arachnefly deploy arms a job that suspends machines every
minute. It stays inert until §1.4 lands, because nothing writes `machineId` yet and every dedicated session
hits `DecideReap`'s `no-machine` branch. That is luck, not design: the moment §1.4 attaches machines, this
job starts acting, and `DueSessions` has **never executed against a real Firestore**.

Why arming it is defensible anyway: two independent gates protect a live session. The query returns only
sessions past `idleDeadline`, and `DecideReap` (8 tests) re-filters closed / byo / no-machine / no-deadline
/ live. A wrong field name makes the query match nothing — which is a money leak, never an outage. And
`SuspendMachine` refuses when `FLY_APP` is empty, so a misconfigured deploy cannot fire blank URLs at Fly.

### The config answer (kept for the record)

- `flyApiUrl` is a **constant** in `main.go:34` — `"https://api.machines.dev/v1"`.
- `flyApp` is `os.Getenv("FLY_APP")` (`main.go:45`), injected as a struct field into `AuthHandler`
  (`fireAuth.go:59`) and `Synchronizer` (`synchronizer.go:26`). The reaper follows the same pattern rather
  than reading the environment a second way.

### If a Cloud Function reaper is ever wanted anyway

It needs, in order: a `browserSessions` collection-group index for the deadline query; a store that
records `ownerUid` as a **field** (the machine document has none — the owner is only the parent path, see
ground-truth); and an explicit service-identity path in arachnefly with its own shared secret and its own
security review. Three new surfaces to serve a job a `cron.AddFunc` covers for free.

Idempotent either way: two runs over the same session must not double-bill or double-suspend.

## 1.6 Metering

Reuse the existing credit machinery — `reserveBillingCredits` / `consumeBillingCredits` /
`releaseBillingCredits` — with an idempotency key `<uid>:browser:<sessionId>:<minuteBucket>`, the same
discipline the crawl path uses.

**Do not forget the policy row — but a policy row alone will NOT make a browser route bill.**
`resolveBillingPricingPolicy(method, path)` (`functions/src/domain/billing-pricing.domain.ts:119`) is where
a path gets priced, and it ends in a **`defaultPricingPolicy`** (`api.paid.default`, 1 credit). An unlisted
route is therefore not free — it is silently mis-attributed and mis-priced. That is the smaller half of
the problem, and it is why §1.6 asks for the row plus a spec.

The larger half, **verified 2026-10-01: the charge lives in `requirePaidAccess`, not in the route.**
`bff/api.ts` contains no billing, credit or policy reference at all — the only hits are comments. The only
middleware that calls `reserveBillingCredits` is `requirePaidAccess` (`syncaiapi.ts`), and it charges only
when the resolved mode is `credits` or `plan`. `resolveAccess` — the `access` primitive §1.3's guard uses —
**charges nothing**, and says so in its own doc: *"A route that SHOULD bill a paid caller composes the
charge path explicitly rather than inheriting it from here."*

So every `access`-guarded route bills nothing today: `/monitor/*`, `/serp`, `/scrape`, `/search`,
`/extract`, `/pdf`, and now `/api/browser/session*`. Adding a pricing row will not change that, and a spec
asserting the row exists will pass while the route still charges no one — a green test over a silent
revenue hole.

A browser route that should bill therefore needs **all three**, not two:

1. the pricing row,
2. a test that fails without it,
3. an **explicit** `reserveBillingCredits` / `consumeBillingCredits` composition on the route, with the
   `<uid>:browser:<sessionId>:<minuteBucket>` idempotency key, the way the crawl path does it.

Until (3) exists, §1.3's routes are metered at nothing — which is what §1.3's header says and why it
carries no metering code, not an oversight to be fixed by editing a table.

Bill only while `state === "ready"`. A suspended machine costs rootfs, not compute.

## 1.7 BYO CDP (Phase 3, same service)

```ts
POST /api/browser/session { mode: "byo", kind, cdpUrl }
```

- The URL is validated against an allowlist of approved hosts (Phase 0.4), then stored in Secret Manager.
- `webrain_batch` / `session(op=open)` receive it on the caller's **own** machine.
- The user pays their own browser provider; we pay only the webrain call. This is the cheapest tier on the
  platform and it should be priced accordingly.

Approved-host allowlist should start with: Lightpanda Cloud (`*.cloud.lightpanda.io`), and whichever of
Browserbase / Steel / Browserless you choose to document. **Lightpanda Cloud is verified real** and hands
out `wss://` CDP endpoints with a token — `puppeteer.connect({browserWSEndpoint})` works directly, and it
can also serve Chrome on the same endpoint.

---

## What this unblocks

`/api/extract` dies today because `webrain_extract` reads the **current page of a session** and refuses
`url`, while the shared pool holds no sessions. A paid user with a leased machine has one. So:

- paid + leased → `extract` works; delete the tools-panel `note` that explains its 502;
- free → still refused, because the shared pool holds no sessions. Say that plainly rather than
  pretending the free tier has it.

## Acceptance criteria

- [ ] `decideLease` spec: every refusal reason reachable, caps pinned as data
- [ ] A cross-uid `GET /api/browser/session/:id/frame` answers **404**, and the upstream call stub is not invoked
- [ ] A BYO `cdpUrl` naming an internal address is refused and never dialled
- [ ] A CDP URL or token never appears in any response shape (assert on the type, like `StorageSettingsPublic`)
- [ ] The reaper suspends an idle session and is idempotent across two runs
- [ ] `resolveBillingPricingPolicy` has a browser row **and** a test that fails without it
- [ ] Route added to `bff/api.ts` (there is no second table — see `05` Part A)
- [ ] Gates: functions `tsc`/`lint`/`test`, bff `tsc`/`test`
