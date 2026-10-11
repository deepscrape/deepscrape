# Pricing, the customer wallet, and acquisition

Owner-facing design for what things cost, how a customer's own budget outranks everything, and how the
same machinery becomes a marketing asset.

---

## Part A — what already exists (verified, 2026-10-01)

| Piece | Where | What it does |
|---|---|---|
| Access modes | `domain/billing.domain.ts:4` | `"free" \| "credits" \| "plan" \| "grace"` |
| Credit reservation | `app/billing-credits.ts` | `reserve` / `consume` / `release`, with an idempotency key |
| Two buckets | same | `purchased` and `included` — spent separately |
| Price per route | `domain/billing-pricing.domain.ts:119` | `resolveBillingPricingPolicy(method, path) → {credits}` |
| Usage reporting | `app/stripe.ts:1705` | `getBillingUsage` callable |
| 402 handling | frontend `paymentRequiredInterceptor` | a single global "pay up" path |
| Rate limiting | `infrastructure/upstash-limiter.ts`, `callable-limiter.ts` | Upstash fixed-window counters |

**Important naming caveat, so you do not mistake one for the other:** in this codebase the word
**"budget" already means a *rate-limit* window**, not money. `enforceBudget`, `withinNotifyBudget` and
the callable limiter's "budget" are all fixed-window counters that *fail open when Redis is unavailable*.
That is correct for a rate limit and **catastrophic for a spend cap** (see Part C).

**A customer-set spend cap EXISTS end to end (built 2026-10-04), so read this as history rather than status.**
Credits protect *us* — they run out, the caller gets a 402. The cap is what lets a customer say "stop at N
credits this month", and it is now reachable from the UI rather than only by curl. **The unit is CREDITS, not
money, and that is forced rather than chosen:** nothing in the platform converts a credit to money
(`creditPackCatalog` prices 100 credits at 1900 minor units and 500 at 7900, so the rate is 19.0 or 15.8
depending on the pack, and a credit granted by a plan has no unit price at all). The `spendCapMinor` this
document originally asked for therefore could not be honoured, and producing `spentMinor` would need lot
accounting over `credits_ledger` — an accounting feature, not this one. Credits are the unit the platform
already charges in, so the cap introduces no new concept. Built as the pure fail-closed decision (`decideSpend`),
the store and per-period counter, `GET`/`PUT /api/billing/policy`, the stop in the meter sweep, and now
`core/services/billing-policy.service.ts` plus the cap row in `settings/general`.

---

## Part B — three instruments, never mixed

| Instrument | Question | Mechanism | Failure mode if you conflate them |
|---|---|---|---|
| **Entitlement** | *may* you use this? | `POLICIES` + tier allowlists + `accessMode` | "I paid, but it says no" |
| **Metering** | *how much* did you use? | pricing policy + reserve/consume/release | you lose money on the expensive path |
| **Rate limit** | *how fast*? | Upstash fixed window | "I paid, but I am throttled" |

A rate limit is not a price. A price is not an entitlement. Most "unfair pricing" complaints are one of
these three leaking into another.

---

## Part C — the customer wallet outranks everything

This is the ask: **priority to the customer's budget.** Expressed as an authoritative check order, not as
a UI hint.

### The document

```
users/{uid}/billing/policy            (later: organizations/{orgId}/billing/policy)
  spendCapMinor      // e.g. 5000 = $50.00
  period             // "day" | "month"
  onExhaust          // "block" | "degrade"
  dailyFreeCredits   // the free allowance, reset on a daily window
  alertsAt           // [50, 80, 100] percent
```

### The check order at request time

1. **Hard cap** — if this request would exceed `spendCapMinor` for the period, **refuse** (402,
   `reason: "budget"`), *even if credits remain*.
2. **Entitlement** — is the caller allowed at their tier?
3. **Credits** — reserve, then consume or release.
4. **Rate limit** — last, and only after the price is known.

The cap is checked **before** reserving, and a reservation may never take the period past the cap. That
ordering *is* the feature; a cap applied after the charge is a report, not a limit.

### The one rule that must not be copied from the rate limiter

**The spend cap must FAIL CLOSED.** The existing fixed-window budgets deliberately *"fail open when Redis
is unavailable"* — right for a rate limit, wrong here: a Redis blip would become an unbounded invoice.
So the cap's cache lookup must treat "cannot read the counter" as **at the cap**, not as "no spend yet".
This is the highest-risk line of code in the whole pricing model.

### Alerting

50 / 80 / 100 % notifications, reusing the `alert-fanout.ts` pattern (it already has a per-(user,
category) window, so it will not spam).

### The decision is BUILT (2026-10-04) — the enforcement is not

`functions/src/domain/billing-policy.domain.ts` + 15 specs. Pure, no clock, no database — the same
shape as `browser-meter.domain.ts` and for the same reason: a mistake here is an invoice.

It settles three things the prose above left implicit:

- **"No cap" and "cannot read the counter" are different questions, and neither is a cap of zero.**
  A capless customer with an unreadable counter is ALLOWED — refusing them would take the free tier
  down on a Redis blip. A customer WITH a cap and an unreadable counter is REFUSED
  (`cap-unreadable`). That distinction is the whole of the fail-closed rule, and it is why the window
  is possibly-absent rather than defaulted to zero.
- **Landing exactly on the cap is allowed.** `>` and not `>=`, because that is what "$50" means to the
  person who typed it.
- **`onExhaust` is returned, not acted on.** This module knows the policy; only the caller knows which
  cheaper path exists to fall back to, so choosing what to drop belongs there.

Also here, because they are the same document: `periodStart` (UTC, so a DST shift cannot make one day
23 hours and the next 25) and `freeAllowanceRemaining` (Part D, clamped at zero).

**The enforcement is WIRED (2026-10-04).** `infrastructure/billing-spend.store.ts`,
`handlers/billing-policy.ts`, `GET`/`PUT /api/billing/policy` in `bff/api.ts`, the admission check in
`handlers/browser-sessions.ts`, and the counter advance in `infrastructure/browser-meter-charge.ts`.
Gates: functions TSC 0, lint 0 errors, **601 tests / 592 pass / 0 fail / 9 skipped**; bff TSC 0, tests 0.

Three things the wiring settled that the prose above did not:

- **The unit is CREDITS, and that is forced rather than chosen.** `spendCapMinor` cannot be honoured:
  nothing in the platform converts a credit to money. `creditPackCatalog` prices 100 credits at 1900
  minor units and 500 at 7900, so the rate is **19.0 or 15.8 depending on the pack**, and a credit
  granted by a *plan* has no unit price at all. Producing `spentMinor` would need lot accounting over
  `credits_ledger` — an accounting feature, not this one. Credits are already the unit the platform
  charges in, so the field is **`spendCapCredits`**. This is **not** a change to the shape of pricing:
  it is the only shape that exists.
- **Two documents, not one.** `users/{uid}/billing/policy` is the customer's and a route writes it;
  `users/{uid}/billing/spend/{periodKey}` is platform bookkeeping. Sharing one document would make
  zeroing the counter a way to defeat the cap. The counter is keyed **by period in the document id**, so
  a roll-over is a new document rather than a reset — no read-modify-write, and `FieldValue.increment`
  makes the sweep and the close route safe against each other.
- **An unreadable POLICY refuses too.** The domain's rule is about the counter; the policy read failing
  is the same question class ("is there a cap at all?") and resolves to `cap-unreadable` rather than
  "no cap", because assuming no cap on one failed read switches the cap off for everyone.

**Still outstanding for step 15:** the alert thresholds (50/80/100 %, reusing `alert-fanout.ts`), and the
meter-side **stop**. The cap is enforced at *admission* today, so a customer at their cap cannot *start* a
session; a session already running is stopped by the 20-credit ceiling, not by the cap. Refusing the
meter's charge would be strictly worse than the overspend — it would leave a running machine unpaid.

**A UI still does not belong here:** the route exists, but nothing renders it.

---

## Part D — a daily allowance for free

**STATUS 2026-10-04: the field is writable, the helper is pure and spec'd, and NOTHING ENFORCES IT — so
there is deliberately no UI, because a UI would display a number no route checks.** What exists:
`dailyFreeCredits` on `SpendPolicy` (accepted by `parsePolicy`, so `PUT /api/billing/policy` can already
set it) and `freeAllowanceRemaining(policy, usedToday)` (`billing-policy.domain.ts:155`, clamped at zero,
with specs). What is missing is **`usedToday`**: there is no counter for free calls, and
`freeAllowanceRemaining` has **no production caller** — it is reachable only from its own spec file. So
step 17 is a backend slice first: a daily window, a counter, and an admission check on the four HTTP-only
free tools (`serp`, `scrape`, `search`, `guide`). Build the UI after the number means something.

Free is a **funnel**, and it should be defined in the product, not in a support macro.

- `dailyFreeCredits` on a **daily fixed window** — cheap, and it resets without a job.
- The free tier stays **HTTP-only** (see `06`): `serp`, `scrape`, `search`, `guide`. Those cost a CPU burst
  and egress, so a daily allowance is affordable.
- **Browser time is never free** on platform compute. It costs Fly minutes; giving it away hands a
  stranger your invoice. BYO CDP is the free-adjacent path — the *user* pays their own browser.
- `extract` and `pdf` need a session, so they are never free, and the tools-panel `note` already says so
  before the call.

---

## Part E — price the unit that actually costs you

Charging credits-per-path for both a SERP call and a browser minute is how you lose money on one and
overcharge on the other. Meter the real driver:

| Feature | Unit | Real cost driver | Tier |
|---|---|---|---|
| `serp` / `search` / `scrape` | per call | CPU burst + egress | free (daily allowance) |
| `extract` / `pdf` | per call | needs a session | paid |
| Browser session, **platform compute** | **per minute started** | Fly compute (~$5.70/mo continuous at 1 GB) | paid |
| Browser session, **BYO CDP** | per minute, **platform fee only** | **no compute cost to us** | paid, cheapest |
| Live view frames | per minute viewed (fps is server-capped) | CDP screenshot CPU | paid |
| Chat AI | per 1k tokens in / out | provider tokens, *passthrough + margin* | paid |
| API requests | per call | negligible | any |

Two consequences worth wiring in:

- **`computeSource` belongs on the price** (`platform` | `byo`). With BYO compute the customer pays Fly
  directly, so charging compute is double-billing. Same field as `04-organizations-and-billing.md` — land
  them together or they will drift.
- **Duration metering is new.** `resolveBillingPricingPolicy(method, path)` is per-path and says nothing
  about *how long* a browser ran. Sessions need `minutesBilled`, which `02-machine-leasing.md` already
  puts on the session document — this is what reads it.

---

## Part E.1 — the rate, **DECIDED 2026-10-03**

Asked for a rate, the honest first answer is that **the credit unit cannot express browser time** — and that
is the finding, not an obstacle to work around.

At the 1 GB Fly price already in the table above, a machine-minute costs **$0.00013**
($5.70/mo ÷ 730 h ÷ 60). One credit is worth **€0.125–0.19** depending on pack. So a credit buys roughly
**1,000 machine-minutes — about 17 hours.** Any per-minute price in whole credits is therefore either a
~1,000× markup (at 1 credit/minute) or a fraction with nowhere to live, because credits are integers and
`resolveBillingPricingPolicy` returns an integer.

That is not a defect in the meter. It is evidence that **credits were never cost-derived**: `crawl.execute`
is 3 credits for a browser job lasting seconds, a far larger multiple of its compute than any per-minute
rate would be. Credits are a *service* unit. Deriving a browser-minute from compute cost is a category
error, so the rate has to be *chosen* on grounds that apply:

- **Scarcity, not compute.** The binding constraint is the Fly Machines API: `Create Machine` is scoped per
  **app** at ~1 request/second, shared by every tenant. Sessions are rationed because machine *creation* is
  scarce, not because a machine is expensive.
- **The session's own quantum.** The paid idle deadline is **15 minutes** (`idleDeadlineForTier("paid")`,
  `browser-session.domain.ts`) — the machine's natural unit.
- **Integers, and no double-billing.** `machines.deploy` already charges 5 credits to create a session.

**The decision:**

| Case | Rate |
|---|---|
| Platform compute, paid | **1 credit per started 5-minute block**, first block **included** in `machines.deploy` |
| Ceiling per session | **20 credits** — an abandoned session cannot run up an unbounded invoice |
| `computeSource = "byo"` | **0 credits for time** — the customer already pays Fly; minutes would double-bill |
| Free tier | **not metered in minutes.** Browser-backed calls run for seconds against the pool and draw on the credit allowance; a free tier never receives a dedicated machine |
| Live view frames | unchanged — per minute *viewed*, which is CDP CPU, not machine time |

5-minute blocks because they are integer, finer than the 15-minute idle deadline so a short session is not
overcharged by design, and they bound a full idle cycle at 3 credits. Worst case for a session created then
abandoned: **5 + 20 = 25 credits** — the 5-credit deploy charge *plus* the 20-credit metered ceiling, which are
separate budgets and not one. (An earlier draft of this line said 20, conflating them.)

**Fails closed, per I3.** If the meter cannot be read the session is treated as **at** its cap. A spend cap
that cannot read its counter is not a cap.

**The alternative, if per-minute is wanted to be meaningful:** add a sub-credit unit (milli-credits) or a
separate *browser minutes* wallet off the integer credit grid. That is a schema change to
`resolveBillingPricingPolicy` and the wallet, and it buys precision nobody has asked for — the rate above
prices the resource that actually needs rationing.

### E.1.1 — the meter that charges, **BUILT and RUNTIME-VERIFIED 2026-10-03**

**Status: built, and the money path has now actually executed.** Three harnesses against a real Firestore
emulator (cached jar v1.22.0, local Java 23) each exited 0: the ledger primitive (6 checks — the
`reservedDelta: 0` meter charge never drives `reserved` negative, the DEFAULT `-1` throws, and replaying a
key is a true no-op); the charge layer `chargeSessionMeter` + `meterWalletFor` (7 checks — a paid 16-minute
session charges exactly 3 credits with `reserved` unmoved, and a replay charges nothing more); and the wallet
derivation (10 checks — a paid plan wins the bucket over purchased credits, a free-plan user holding
purchased credits *is* charged per minute, and `grace`/`admin` are never charged at all). One behaviour worth
knowing: an exhausted wallet makes the charge **throw** (`would make included balance negative`) rather than
degrade to 0 — fail-closed for the money, and safe for the sweep because `sweepBrowserMeter` wraps each
session in its own `try/catch` and leaves the counter unadvanced so the retry is free. Recipe:
`/memories/repo/billing-credit-runtime-verification.md`; the gate-by-gate account is in
`.github/skills/browser-platform-skill/SKILL.md`.

`gfunctions/browser-meter.ts`, plus the two store functions it needed, exported from
`index.ts` and scheduled `*/5 * * * *`. The two paragraphs that follow were written while it was still unbuilt;
the obstacle they describe is now **historical** — the store gap was closed by adding
`listMeterableSessions()` and a `state` collection-group index. Read them for the traps, not for status.

**The revenue gap is CLOSED (2026-10-03).** A session that ended between two sweeps used to escape its final
block, because the sweep's query excludes `closed` and the loss was therefore permanent rather than late. The
close route now performs a final charge. The ordering is deliberate and load-bearing: it runs **after** the
machine release (so compute has already stopped) and **before** the record is marked closed, so a failed
charge leaves the session OPEN and still visible to the sweep, which retries every five minutes. That is the
same philosophy as the existing failed-release path — a retryable error beats a permanent loss — and it is
safe to repeat because every block carries a deterministic ledger key.

**The money step now lives in ONE place.** `infrastructure/browser-meter-charge.ts` holds `meterWalletFor()`
(one billing read per caller, reused across that caller's sessions by the sweep) and `chargeSessionMeter()`.
Both the sweep and the close route call them, so the two cannot drift into charging differently — and that
module is where **`releaseReserved: false`** is enforced.

**Executed at runtime against an emulator (2026-10-03).** The collection-group query ran against a real
Firestore emulator (v1.22.0, JDK 21) inside a container: four seeded sessions across three uids returned
exactly the three non-closed ones, the uid derived correctly from the document path
(`doc.ref.parent.parent.id`, since the record deliberately carries no uid), and the `closed` document was
correctly excluded. Query semantics and the uid derivation are therefore measured rather than assumed.

**What that still does NOT prove.** The emulator does not enforce collection-group indexes, so the `state`
index declaration is unproven and production can still answer `FAILED_PRECONDITION`. It stays declared but
undeployed, and the first live sweep remains the real test.

### E.2 — why the ceiling is 20 and not 15, **DECIDED 2026-10-03**

The question raised was whether the 20-credit metered ceiling should be 15. **It stays 20.** No code change:
`METER_MAX_CREDITS_PER_SESSION` is already 20.

**What the ceiling costs the customer.** 5 credits is €0.62–0.95 at pack pricing (100cr €19 → €0.19/cr;
2000cr €249 → €0.125/cr). As a share of a plan it is 0.5% of starter (1000 credits), 0.1% of pro (5000),
0.025% of enterprise (20000). Lowering the ceiling to 15 would save the customer **under one euro**, in a
case most will never reach.

**What it buys them.** Block *n* is credit *n−1*, so 20 metered credits is reached at block 21 = **105
minutes**; 15 would be reached at block 16 = **80 minutes**. The difference is **25 minutes of usable session
— a 31% cut in maximum session length — for under a euro.** That is the trade to refuse: it removes
capability and leaves almost nothing on the table. Being cheap here would be exactly the mistake worth
avoiding.

**The ceiling is unreachable by accident, which is why 20 is safe.** The paid tier is
`{dedicated: 1, byo: 3, fps: 1, idleTtlMs: 15 * 60 * 1000}`, so:

- An **abandoned** session is reaped at 15 minutes idle → 4 blocks → 3 metered + the 5-credit deploy =
  **8 credits.** It never approaches 20 on its own.
- `keepalive` pushes the idle deadline out, so the **only** path to 20 credits is ~105 minutes of
  *continuous active use*.
- `dedicated: 1` allows **one** concurrent dedicated session, so a caller cannot multiply the exposure by
  opening several.

So the ceiling has never been a cap on casual use. It is a cap on one long, actively-driven session.

**The actual finding: this instrument is doing the wrong job.** E.1 justified the ceiling as "an abandoned
session cannot run up an unbounded invoice" — but the **15-minute idle TTL already does that** (8 credits,
not 20). And it does **not** bound platform *compute*, which is what actually costs us: past block 21
`meterChargeFor` emits no further keys, so a session driven for ten hours costs the same 25 credits as one
driven for 105 minutes. **Past the ceiling the customer rides free.** A credit ceiling cannot bound compute;
only a time limit can. That is the gap, and it is worth stating plainly because the ceiling has been
described as a cost control when it is really an invoice cap.

**The free window is CLOSED (2026-10-03), by a different route than the one proposed above.** The
recommendation was a separate 120-minute lifetime with the ceiling raised to 25. That was **not** taken: a
second bound needs its own value and its own account of where that value came from, and its relationship to
the price cap then becomes a thing to keep in step. The ceiling is already the amount the customer agreed to
spend, so it is now the session's lifetime as well. `isMeterExhausted` fires once the last billable block has
finished, and the sweep moves the session's **idle deadline to now**, which is how it asks the Go reaper to
suspend the machine. No new mechanism, no new state, and no second way for a session to end.

**The exact boundary, because it is off by one from the obvious reading.** Block 21 is the last block billed
and it runs from **100 to 105 minutes**; the credit is taken the moment that block *starts*, because a
started block is a billed block. So the ceiling is reached at 101 and held until 105, and the session ends
only once block 21 is **done**. A predicate written as "no credit is due" fires at 101 and cuts off a block
the customer has already paid for. That was the first version, the spec caught it, and both sides of the
boundary are now pinned.

**What this does NOT fix.** It bounds compute for a session the sweep can see. A session record deleted out
from under a running machine, or a sweep that never runs, still strands it. That remains the reaper's job,
not the meter's.

**Built: the rate logic.** `functions/src/domain/browser-meter.domain.ts`, pinned by 32 tests in
`browser-meter.spec.ts`. Pure functions over their arguments with no clock and no database, because a mistake
here is an invoice rather than a wrong number on a chart. Exposes `billableMinutes`, `meterBlocks`,
`meterCreditsFor`, `meterChargeFor`, `isMeterBillable`, `isMeteredTier`.

Three things it settles that the rate table above left implicit:

- **The billable window ends at the idle deadline**, not at `now`. Past that deadline the machine is
  suspended, so billing it would charge for a machine that is not running. `closedAt` clamps it likewise.
- **Block *n* is credit *n−1***, so the 20-credit ceiling is reached at block 21. Capping the *block index* is
  the same statement as capping the credits, and doing it in the emitter is what stops the ledger being
  re-attempted on every later sweep once a session is at its cap.
- **A BYO session is not billable,** and the test is the absence of `machineId` rather than a new
  `computeSource` field — `§1.4` provisions no machine for BYO, so a second field could only disagree with it.

**Not built: the sweep that calls it.** It must be a scheduled **Firebase Function**, not a step in the
reaper: arachnefly's `FireAuthMiddleware` accepts only a Firebase ID token, and a cron job cannot authenticate
as the session's owner — the same Phase 0 item 4 blocker that stopped the reaper charging. Model it on
`drainDueMonitors` in `gfunctions/monitors.ts`, then export it from `index.ts`.

**The bucket derivation is RESOLVED, and needs no schema change.** An earlier note here treated "where does
the bucket come from" as an open gap. It is not: `machineChargeFor(accessMode, price)`
(`browser-session.domain.ts:558`) already returns `{action, amount, bucket}` with
`bucket = accessMode === "credits" ? "purchased" : "included"`, and returns **`null`** for every other mode.
`accessMode` is derived by the pure `getBillingAccessMode(snapshot, now)`
(`billing.domain.ts:222`). So the sweep reads `users/{uid}/billing/current`, derives the mode, and takes
`.bucket` from the *same* function the deploy route used — the rule that costs money is read, never restated.

The dependency to know about: `machineChargeFor` returns null when the deploy price is non-positive, so a
zero-priced deploy action also switches the meter off. That is fail-closed and consistent, and it is why the
sweep must pass the deploy policy rather than inventing an amount.

**The real blocker: the session store cannot be swept.** Sessions live under
**`users/{uid}/browserSessions`** — a per-user subcollection. `browser-session.store.ts` exposes
`listBrowserSessions(uid)` and `readBrowserSessionRecord(uid, id)` and nothing cross-user; there is **no
collection-group query in TypeScript at all**. A scheduled sweep therefore has no way to enumerate the open
sessions it is supposed to meter, and this — not the bucket, and not the ledger — is what stands between the
rate logic above and a charging meter.

Two ways out, and the first is cheaper: **(a)** add a collection-group read on `browserSessions` filtered to
records carrying a `machineId` and `state !== "closed"` — the same shape the Go reaper must already use,
since `firestore-indexes.spec.ts:42` carries a `["browserSessions", "idleDeadline"]` collection-group index
for it, which will likely need a sibling index for the meter's filter; or **(b)** drive the sweep per user by
enumerating users first, which trades one indexed query for an unbounded user scan and is the wrong trade at
any scale. Take (a). Note the record field is **`state`**, not `status`.

**The charge is per BLOCK, keyed — not a delta.** This is the part to get right. `consumeBillingCredits`
writes a ledger document whose id derives from `idempotencyKey`, and `applyBillingCreditMutation` returns
unchanged when that document already exists (`app/billing-credits.ts:103`). Keying the charge
`bs-meter:<sessionId>:block:<n>` therefore makes it apply **at most once, ever**: a retry, an overlapping run,
or a crash *between* the charge and the write of `minutesBilled` are all no-ops on the second attempt, and the
next sweep re-derives the same key and heals itself. Charging a delta of
`creditsOwed(now) − creditsOwed(stored)` is correct arithmetic that still double-charges in exactly that
window, because the stored counter is the thing that did not get written. That is why `meterChargeFor`
returns **keys** rather than an amount.

**Pass `releaseReserved: false`.** `consumeBillingCredits` defaults `reservedDelta` to `−amount` because it
assumes a reservation was taken earlier. A metered charge has no reservation behind it, so the default would
drive `reserved` below zero and corrupt the wallet's balance/reserved pair. Reuse the route's ledger shape
(`source: "browser-session-meter"`, `sessionId`, `metadata`, `idempotencyKey`).

**Implementation requirements, corrected:** `minutesBilled: number` **already exists** on the server-side
session record (`browser-session.domain.ts:246`) — an earlier claim in this document that neither field
existed was wrong about it, and no new counter is needed. `computeSource` still does not exist and is
derivable from `machineId` rather than needing to be added. The remaining work is therefore **one
collection-group read plus the sweep**, not a schema change.

---

## Part F — transparency is the fairness

A wallet model feels fair only when the customer can see the price **before** the charge.

- `GET /api/pricing/estimate` → what the next call costs. Cheap: `resolveBillingPricingPolicy` already
  computes it. The UI shows "this run will cost N credits" above Submit.
- `GET /api/billing/policy` → cap, period, remaining, and the reset time.
- The org admin sees the same for their members (the margin view in `04`).

---

## Part G — the same machinery is the marketing

Fair pricing *is* the acquisition story, and every item below reuses something that already exists:

1. **A genuinely useful free tier.** SERP + scrape, a daily allowance, no card. It is the funnel, and it
   needs no browser.
2. **Generate the pricing page from the policy table.** If `resolveBillingPricingPolicy` is the source of
   truth, the public page is derived from it. A hand-written page drifts from the code — the same failure
   the tools-panel descriptor table exists to prevent.
3. **Transparency as a referral driver.** Customers recommend products that do not surprise them. A
   visible cap is the single most referable property a usage-priced product has.
4. **BYO as the cheapest legitimate tier.** BYO storage, BYO CDP, BYO Fly org each remove a cost of ours;
   they attract sophisticated users, and sophisticated users bring their teams.
5. **Live view as the paid hook — with an honest reason.** Per webrain's own engine matrix, interactive
   challenges *"need the human in the headed browser."* "Watch and solve what your agent cannot" is a
   feature someone pays for, and it is true rather than decorative.
6. **Credit grants for referrals.** Grant credits through the existing reserve/consume machinery; no new
   ledger.

### Item 2 is BUILT 2026-10-03 - the page holds no numbers

The pricing surface now renders the table instead of restating it:

| Layer | File |
|---|---|
| Projection | `getPublicPricingRates()` + `getDefaultPricingRate()` in `domain/billing-pricing.domain.ts` |
| Handler | `functions/src/handlers/pricing.ts` |
| Route | `GET /api/pricing/rates` in `bff/api.ts`, gated `guard([access, pricingRates])` |
| Page | `src/app/pages/user/billing/rates/rates.component.*` (13 specs), route `billing/rates`, nav "Rates" |

**`access` and NOT `paid`.** A customer deciding whether to buy must be able to see what things cost, so
putting the price list behind payment would hide the page that answers the question. The rates are the
table's, not the caller's, so the response is the same for everyone.

**The projection drops `pattern`.** Those regexes are our internal routing
(`^/machines/machine/[^/]+/start$`) and a price list has no use for them; shipping them would publish the
route table for no benefit. It also keeps `method` OPTIONAL, because the fallback rate applies to every
method and naming one there would be a claim that is not true of DELETE.

**The page contributes only labels.** It decides no rate, no count and no price: it groups by action
prefix and names the actions it recognises. A rate added to the table therefore APPEARS without a change
here, labelled with its raw action id until someone translates it. That is the intended failure mode, and
it is strictly better than the alternative, which is a stale NUMBER beside a correct name.

**The drift is now a test, not a promise.** `billing-pricing.domain.spec.ts` (6 specs) asserts the
published set equals the charged set field by field, that nothing serialises a `pattern`, and that the
fallback IS the resolver's answer for an unlisted route. Written against invariants rather than literal
numbers, so it holds when `BILLING_PRICING_RULES_JSON` re-prices the platform.

**Both halves of Part F are BUILT (2026-10-11), and the way the first one was found is the lesson.**

`GET /api/pricing/estimate` had a handler, a domain function (`estimateBillingCost`) and a client
method (`PricingRatesService.estimate`) for a while, and **no route**. So every caller got a 404, and
the crawl panel hides that failure on purpose — the "this run will cost N" line simply never appeared
instead of reporting anything wrong. Registered now as `guard([access, pricingEstimate])`.

`access` is required rather than stylistic: the handler reads `req.accessMode`, which only
`resolveAccess` sets. Without it every caller is priced as `free`, so a paid account would be told its
next call costs nothing — the estimate would agree with a charge it does not predict.

Same species as `/api/vision`. A client method is not evidence of a route, and the base-level check in
`scripts/route-parity.ts` could not tell them apart; the method-path list it now prints can.

---

## Part H — Obscura, taken seriously

### What it actually is (corrected — see `06`)

A real third-party browser shipped as versioned GitHub release assets per platform, with **four build
variants**: default, `-stealth`, `-no-render`, `-no-render-stealth`. It renders in v0.2.0+ render builds
(**and does PDF**), and it batches with **parallel tabs** — where Lightpanda is sequential. It is not
Chrome: no full layout parity, so no Material/SPA, and no interactive challenges.

### Should we build our own Obscura pooling for shared users?

**Yes as a shape, no as a first move, and never the browser itself.**

- **Building the browser: no.** Obscura is someone else's project; we consume its binaries. Writing a
  browser engine is Lightpanda's entire company. *Build the scheduler, not the browser.*
- **"Pool" must mean a pool of exclusive single-tenant workers, routed by our gateway** (`06`). A pool of
  browsers behind one webrain process is the leak, no matter how the browsers are arranged.
- **Obscura's real value is density, not licensing.** An exclusive worker costs about what its browser
  costs. Lightpanda is ~123 MB against Chrome's ~300–500 MB, so a light engine means several times more
  workers per machine — which is exactly what mitigates Fly's **undisclosed** scaling limits. That is the
  honest argument for Obscura: *more tenants per machine*, not a cheaper licence.
- **Obscura also unlocks frames on the free-adjacent path** (render builds, simple JS pages only), which
  Lightpanda cannot ever do because its screenshot is a placeholder.

### But do not build it yet — here is the trigger

The free tier works **today with no browser at all**: `fallback_chain` tries HTTP engines first and the
browser is an optional last resort. So there is nothing to fix until there is something broken.

**Build the Obscura pool when the metric says so:** a measurable share of free-user `serp`/`scrape` calls
return empty or degraded because the page needed JS. Until that number exists, the pool is capital and
complexity spent on a hypothesis. When it does exist, this is a *capacity* purchase with a known density
target — and it lands behind step 6 of the master sequence, not before step 2.

**Cheapest thing that might fix it first:** a paid render/SERP provider on the HTTP path. webrain already
does exactly this — `fallback_chain` calls `serpapi_google` *"before spending a browser render on a walled
IP"*. Same instinct, one config, no fleet.

### The trigger cannot fire yet — the signal exists, off the free path (verified 2026-10-02)

"Build it when the metric says so" requires a metric, and there is not one. Three verified facts:

1. **webrain already computes it — and the platform now reads it.** `needs_js` and `visible_chars` are set
   at `webrain-mcp/src/lib.rs:242-243` for the plain-HTTP fetch. The heuristic is `probe_needs_js`
   (**`webrain-mcp/src/tools.rs:646`**, not `tools.rs`): true if the HTML contains any of
   `"enable javascript"`, `"javascript is required"`, `"javascript is disabled"`, `"enable js"` — **or** if
   `visible_text_len(html) < 100 && contains("<html")`. It does **not** require script tags; the source
   comment says they "often sit past the 3000-char text cap, so don't require them". Purpose, per the
   field's own comment: *"probe whether the raw HTML is a JS shell so the LLM can upgrade to the browser
   instead of scraping an empty page."*
2. **It reaches a free caller.** `webrain_scrape` is `POST /api/scrape`, which **is** in
   `SHARED_POOL_TOOLS`, and a live call against a running engine returns
   `{"result":{"needs_js":false,"visible_chars":425}}`. An earlier version of this section said the signal
   was "emitted only there", on `fetch_http` — a tool in *neither* tool set. **That was wrong**, and it
   inverted the conclusion: the trigger was already on the free path, not stranded off it.
3. **The platform reads it, as of 2026-10-03.** `webrainPayloadSignals`
   (`functions/src/domain/webrain-signals.domain.ts`) parses `result.needs_js` and `result.visible_chars`
   and surfaces both on `WebrainToolResult`. **Absent stays absent**: a tool that never reports the flag
   answers `undefined`, never `false`, because `false` would assert that a static page fetched cleanly.
4. **What remains is the *block* gap, not the trigger.** `probe_needs_js` detects JS **shells**, not
   **blocks**: a Cloudflare deny page ("Error 1020", `cf-error-code`) has ample visible text and none of
   the four markers, so it reports `needs_js: false` and the fetch looks clean — the fetch returns the
   block page's prose as if it were content. `detect_antibot(title, text)` would catch it and needs **no
   browser at all** (pure string matching — its own comment says "No HTML/network"), but all three of its
   call sites are in the browser path (`cdp.rs:1486`, `cdp.rs:2396`, `browser.rs:411`), never in `tools.rs`.

So the trigger is observable and read. What is still missing is any way to tell a **blocked** page from a
successful fetch. **The first task is no longer "make the trigger observable" — it is closing the block
gap**, cheapest first:

- **Emit `challenge` and `chrome_error` beside `needs_js`** at `lib.rs:243`. Both detectors already exist,
  are already `pub`, and take the title/text that fetch already produced. `crippled` is the one that cannot
  join them — it consumes an interactive-element count, so it genuinely needs a browser. Do **not** port the
  marker list to TypeScript and match it against `text`: `__cf_chl`, `challenge-platform`, `cf-error-code`,
  `h-captcha` and `g-recaptcha` live in attributes, classes and URLs, so they do not survive into *visible*
  text, and a platform-side reimplementation would match nothing while appearing to work.
- **Or have the serp/scrape path report why it degraded** — a small webrain change, because
  `fallback_chain` already knows whether it fell back and whether the result was empty. That is the
  engine reporting on itself, which does *not* couple it to the platform: the desktop binary stays
  standalone.

Until one of those lands, the pool is capital and complexity spent on a hypothesis.

### The shape, when it is built — so it is not re-litigated

An objection to most of the framing, recorded because the framing is intuitive and wrong:

- **"Shared pool for many free users" is the phrase to refuse.** A pool means a pool of **exclusive
  single-tenant workers routed by our gateway** — `uid → worker` is ours. A pool of browsers behind one
  webrain process is the leak however the browsers are arranged, because `session_id` is caller-named
  and enumerable. And free is the **least** trustworthy population to pool for: highest volume, most
  adversarial, least accountability. Pooling is a privilege of a trusted tier, not a subsidy for an
  untrusted one. If free is pooled, routing must be wholly ours and no browser may ever serve two tenants.
- **A new Rust/Go/Bun pooling service is the opposite of minimising sources.** arachnefly already owns
  the Fly client, machine lifecycle, the ownership middleware, the reaper and the cron. The reaper set
  the precedent — it was moved *into* arachnefly precisely so the platform would not grow one service
  per concern. Pooling belongs there.
- **No pooling API in webrain.** webrain has no notion of a pool, and adding one would couple the engine
  to the platform, against the rule that the desktop binary must never depend on platform auth, platform
  secrets, or a platform-only code path. The pool is a routing concept; it lives in the router.
- **One engine, not three.** Pooling Chrome, Obscura *and* Lightpanda triples image count, warm capacity
  and the decision surface. Free needs **extraction, not rendering** — rendering is where the paid value
  is (frames, screenshots, SPAs, challenges). Lightpanda is the free engine: ~123 MB, JS yes, instant
  start, and **never a frame**, because its screenshot is a placeholder and the failure mode is a
  plausible wrong image rather than an error. Escalation to Obscura or Chrome is a paid path.
- **The pool's real function is the create ceiling, not memory.** Fly allows about one `Create Machine`
  per second per **app**, shared by every tenant, and session machines are created on demand. A warm pool
  serves requests without paying that limit — which means **paying for idle machines**. That is the
  trade. It is a capacity purchase with a density target, not a containerisation win.

