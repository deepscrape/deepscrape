# Pricing table and meter audit — 2026-10-20

Asked to: settle two open questions, then audit the pricing table and cost meters for
defects and align the customer-facing tables with what the platform actually does.

Every claim below was read from source or the live Stripe API in this session. Where a
number is a **proposal**, it says so; nothing here has been applied to Stripe or to the
credit table without sign-off.

---

## Part 1 — The two open questions

### 1. Meter: snapshot `computeSource` at creation, or re-resolve at charge time?

**Decision: snapshot. It is already implemented (`8c9022b3`) and should stay.**

The cost argument is not the deciding one, and it is worth writing down so nobody
re-opens the question on cost grounds:

| Approach | Extra work per sweep | Cost per 105-min session |
|---|---|---|
| Snapshot (stored on the record) | 0 reads | €0 |
| Re-resolve per sweep | 1 Firestore read + 1 Secret Manager access, per session, per 5 min | ≈ €0.00007 |

At $0.03/100k document reads and $0.03/10k secret accesses, 21 sweeps come to well under
a tenth of a cent. **Cost does not decide this.** Three things do:

1. **The machine's app is fixed at provisioning.** Re-resolving describes settings that
   may no longer describe where the running machine actually is, so the meter would price
   a machine by a fact that has stopped being true.
2. **A deleted config would invert the bill.** Re-resolve reads `undefined` → `platform`
   → we start charging for a machine in the caller's own organization. Snapshot reads the
   stored `byo` and bills nothing. Snapshot is strictly safer in the direction that
   matters (never overcharge).
3. Latency inside a scheduled sweep that already does 2 reads per caller.

### 2. Should `computeSource: "byo"` also waive the `machines.deploy` charge?

**Decision: yes, and it is implemented the same way.**

`machines.deploy` is 5 credits ≈ €0.62–0.95 depending on pack. The rate was justified in
`07` Part E.1 by **scarcity of Fly machine creation**, not by compute cost — the Machines
API allows 1 create/second **per app**, and every platform tenant shares one app.

A BYO deploy spends none of that: the machine is created in *their* app, against *their*
rate limit, billed to *their* Fly account. The platform's residual cost is one config read
and one secret access (~€0.000003), which the plan subscription covers.

Charging 5 credits there would be pure margin on a customer who already pays Fly, and it
contradicts the standing rule that compute the platform did not supply is not billable.

---

## Part 2 — The charge model as it actually is

Two independent mechanisms, and they do not overlap:

1. **Per-request credits** — `requirePaidAccess` in `infrastructure/syncaiapi.ts:287`
   resolves `resolveBillingPricingPolicy(req.method, req.path)`, reserves, and consumes.
   Routes that do **not** carry the `paid` guard are not charged at all.
2. **The session meter** — `browser-meter.domain.ts` + `gfirestore` sweep, 1 credit per
   started 5-minute block, 20-credit ceiling, first block included in `machines.deploy`.

### What is charged, per request

| Route | Action | Credits |
|---|---|---|
| `POST /api/crawl` | `crawl.execute` | **3**, regardless of URL count |
| `POST /api/anthropic/messages` | `ai.anthropic.messages` | 2 |
| `POST /api/openai/chat/completions` | `ai.openai.chat` | 2 |
| `POST /api/groq/chat/completions` | `ai.groq.chat` | 1 |
| `POST /api/machines/deploy` | `machines.deploy` | 5 |
| machine lifecycle (start/suspend/stop/read/wait/check-image) | `machines.*` | 1 each |
| `DELETE /api/machines/machine/:id` | `machines.destroy` | 2 |
| `POST /api/navigate`, `/observe`, `/vision` | `api.paid.default` | **1 (fallback)** |
| `POST /api/batch`, `/spider`, `/download`, `/watch` | `api.paid.default` | **1 (fallback)** |
| `GET /api/machines` (list) | `api.paid.default` | **1 (fallback)** |
| anything else behind `paid` | `api.paid.default` | **1** |

### What is free (no `paid` guard, so never charged)

`POST /api/scrape`, `/search`, `/extract`, `/pdf`, `/guide`, and the whole
`/api/browser/session*` surface. The session surface is metered by the 5-minute block
instead — deliberate, per `§1.2`/`§1.6`, and the reason a frame poll at 1 fps does not
cost 1 credit per frame.

---

## Part 3 — Defects found, worst first

### D1. A `payAsYouGo` purchase grants a PERMANENT plan, repeatably — revenue hole

**FIXED `b00ea20`.** The window is 3 days — 10% of a 30-day month, the same fraction
as the price and as the credit grant — written to `currentPeriodEnd` by both payment
paths and enforced by `isPaygWindowClosed`, which fails closed on a missing date.
Ten purchases for 30 days cost €19.90 against €19.99 monthly.

`payAsYouGo` is a one-time payment (`checkoutMode: "payment"`), priced at 10% of the
monthly price: starter €0.99, pro €1.99. On completion, `checkout.session.completed`
writes the plan and credits:

- `plan: "starter" | "pro"`, `status: "active"`, `planInterval: "payAsYouGo"`,
  `currentPeriodEnd: null` (`stripe.ts:2406`, `:2423`, and the legacy
  `payment_intent.succeeded` path at `:2644`).

And **nothing expires it**: `getBillingAccessMode` (`billing.domain.ts:222`) returns
`"plan"` for any paid plan with no date check at all.

So €1.99 buys Pro permanently, and can be bought again. The subscription is undercut by a
factor of ~10 with no renewal.

The pricing is internally consistent with a *duration that does not exist*: 10% of the
price for 100% of the term. The missing piece is 10% of a month.

**Proposal (needs sign-off — this changes what money buys):** give `payAsYouGo` an expiry
of 10% of a month (≈3 days), which makes 10 × €1.99 for 30 days equivalent to €19.99/month.
Implemented as a `currentPeriodEnd` written on payment plus an expiry check in
`getBillingAccessMode` (or a scheduled downgrade, which is the safer of the two).

**Not implemented.** Every candidate fix changes a customer-visible entitlement, and the
choice between "3-day window" and "no plan at all, credits only" is a product decision.

### D2. PAYG credits undercut credit packs by 19–25×

Same purchase grants `getIncludedCreditsForPlanInterval(plan, "payAsYouGo")` = 10% of the
plan's monthly allowance:

| Purchase | Price | Credits | € per credit |
|---|---|---|---|
| starter PAYG | €0.99 | 100 | **€0.0099** |
| pro PAYG | €1.99 | 500 | **€0.004** |
| pack 100 | €19.00 | 100 | €0.19 |
| pack 500 | €79.00 | 500 | €0.158 |
| pack 2000 | €249.00 | 2000 | €0.1245 |

A pack customer pays 19× more per credit than a PAYG customer, for the same credit. Packs
are the top-up product and are priced 15–48× above the subscription rate; that may be
intentional (no commitment), but combined with D1 it means the cheapest way to buy credits
is a one-time €1.99 that also grants Pro permanently.

### D3. The capacity tools are priced BELOW the cheapest tool — revenue leak

**FIXED `b00ea20`** — see Part 5 for the applied numbers. The table now names every one
of them, and a spec asserts that none resolves to `api.paid.default`.

Because they were never added to `defaultPricingRules`, they inherit
`api.paid.default` = 1 credit:

- `POST /api/spider` — crawl an entire site, unbounded page count: **1 credit**
- `POST /api/batch` — N targets in one call: **1 credit**
- `POST /api/watch` — a long-running watch: **1 credit**
- `POST /api/download` — unbounded bytes: **1 credit**

Meanwhile `POST /api/crawl` costs 3 for one request. **A full site crawl is a third of the
price of a single crawl request.** The skill also records that `download`/`watch` are kept
out of `SESSION_TOOLS` precisely because their payloads are unbounded — yet they are
routed and sold at 1 credit.

### D4. `observe` costs 1 credit per frame, while the frame route is free

`POST /api/observe` is `paid` → 1 credit per screenshot. `GET
/api/browser/session/:id/frame` is free (metered by the session). Two ways to obtain the
same kind of image, priced 300× apart in effect. On a dedicated session the meter charges
1 credit per 5 minutes; polling `observe` at 1 fps would cost 300 credits over the same
window.

### D5. Enterprise is advertised with a €0.00 pay-as-you-go option

`billingPlanCatalog` gives `enterprise.prices.payAsYouGo` amount `0` with no
`stripePriceId`, and no such price exists in either Stripe account. Checkout refuses it
(`stripe.ts:2013` throws when the resolved id is missing), so it is not purchasable — but
if the client renders every interval from the catalog it displays a €0.00 Enterprise
option. `free`/`trial` have the same zero entries but are not offered for sale.

### D6. Price fallbacks in code are archived TEST-mode ids

`functions/src/app/stripe.ts:526-561` falls back to `price_1T7Z…` ids. The live catalog was
re-priced on 2026-09-20 (`transfer_lookup_key`), so those ids are archived. Checkout
resolves by `lookup_key` first and only falls back to the id, so this is degraded rather
than broken — but the failure mode is "checkout fails" the moment a lookup_key drifts.

### D7. `validateStripeCatalog` is a callable, never scheduled

It is an `onCallv2` (`stripe.ts:~1380`), so a missing or mismatched live catalog is never
detected automatically. It already fetches prices, so asserting lookup_keys inside it is
small. **This is what would have caught the "production has no catalog" state.**

### D8. Client publishable key: prod build ships a test key (unverified this session)

Recorded 2026-09-20: `src/environments/prod.ts` and `staging.ts` held `pk_test_…` while
`environment.ts` held `pk_live_…`, so a production build (fileReplacements) would ship the
test publishable key. **Not re-verified this session** — it needs a read of the three env
files, which are generated.

---

## Part 4 — Verified state of the Stripe catalog (read-only, this session)

Both accounts are reachable and **the live catalog exists** — a correction to the earlier
note that production had no DeepScrape objects.

| | test `acct_1Qag9KFVGcR0rD8f` | live `acct_1OELbJFBBAUAyJFB` |
|---|---|---|
| active `ds_*` prices | 14 | 14 (+ "Funding", unrelated) |
| lookup_keys | `ds_<plan>_<interval>`, `ds_credits_<n>` | identical |
| currency / tax | EUR, `tax_behavior: inclusive` | EUR, `tax_behavior: inclusive` |

Plan prices (EUR, inclusive, live):

| plan | payg | monthly | quarterly | annual |
|---|---|---|---|---|
| starter | 0.99 | 9.99 | 27.99 | 99.99 |
| pro | 1.99 | 19.99 | 55.99 | 199.99 |
| enterprise | — | 49.99 | 149.99 | 499.99 |

Credits: 100 = €19, 500 = €79, 2000 = €249.

The code's amounts, caps and lookup keys agree with the accounts. **No Stripe change is
needed to make the current table truthful** — which is why nothing was written to Stripe.

---

## Part 5 — Proposed pricing components (needs sign-off)

The table should state, per capability, which instrument prices it. Proposal, deliberately
reusing existing ratios rather than inventing a new scale:

| Capability | Route | Instrument | Credits (proposed) | Basis |
|---|---|---|---|---|
| Crawl (one request, any URL count) | `POST /api/crawl` | credits | 3 | unchanged |
| Site crawl / spider | `POST /api/spider` | credits | **10** | unbounded pages; must exceed crawl |
| Batch | `POST /api/batch` | credits | **3 + 1 per extra target** | matches crawl at N=1 |
| Watch (long-running) | `POST /api/watch` | credits | **5** | unbounded duration; flat because the policy is per-path |
| Download | `POST /api/download` | credits | **5** | unbounded bytes; egress is the cost driver |
| Navigate / interact | `/api/navigate` | credits | 1 | browser step |
| Observe (screenshot) | `/api/observe` | credits | **1** | ad-hoc shot on a pool worker; the frame route is the metered path |
| Vision | `/api/vision` | credits | 2 | image work |
| AI chat | `/api/anthropic/messages` | credits | 2 | unchanged |
| Browser session time | `/api/browser/session*` | meter | 1 / 5 min, ceiling 20 | unchanged |
| Machine deploy | `/api/machines/deploy` | credits | 5 platform, **0 BYO** | implemented |
| Scrape / search / extract / pdf / guide | varies | free | 0 | unchanged |

**APPLIED 2026-10-20 (`b00ea20`, rates page in `4b80db2`).** The numbers below are what
the table now charges, and they follow the unit it already used — `crawl.execute` at 3
for one browser job — rather than a new scale:

| value | rationale |
|---|---|
| 1 | one browser step (`navigate`, `observe`) |
| 2 | image work, CPU-bound on the worker (`vision`) |
| 3 | N urls in one call (`batch`) — crawl's rate at N=1 |
| 5 | unbounded payload (`download`, `watch`) |
| 10 | a site walk (`spider`) — discovery plus N page fetches, > 3x a crawl |

`GET /machines` is an explicit **0**: one Firestore read, no browser, and the panel lists
on every open. `observe` stays paid while the frame route does not, because they are
different products — a frame is a live view of your own leased machine paid for by the
session meter; observe is an ad-hoc screenshot on a shared pool worker.

**Still open from this part:** `batch` is flat for an unbounded URL list, because
`BillingPricingPolicy` is per-path and cannot scale with a request body. Making it
scale needs a per-unit dimension on the policy, which is a schema change and deserves
its own decision.

---

## Part 6 — What this audit did NOT do

- No Stripe object was created, updated, or archived. (Still true, and still correct:
  the catalog already matches the code.)
- D8 was not re-verified.
- `batch` remains flat for an unbounded URL list.

**Corrected 2026-10-20:** an earlier version of this section said no credit cost and no
entitlement had changed. Both became false at `b00ea20` — D1's window and D3's prices are
implemented. What DID change: `defaultPricingRules` gained nine rows, `getBillingAccessMode`
now checks a payg window, and every payg payment writes `currentPeriodEnd`.

---

## Part 7 — Spider.cloud, and why its table looks so much cheaper

Asked directly, with `spider.cloud`'s own published numbers (2026-10-20).

### What Spider actually charges

| line item | rate |
|---|---|
| bandwidth | **$1 per GB** |
| compute | $0.0001 per CPU-minute |
| failed / blocked / timed-out page | **$0** |
| credits | 10,000 to the dollar |

Their own worked example: a page bills
`{compute 0.00001, file 0.00002, bytes 0.00002}` = **$0.00004**. Their crawl table:
100 pages ≈ **$0.01**, 1,000 pages ≈ **$0.10**, a 2,000-page cap ≈ **$1.00**.

Top-ups: $5 / $25 / $100 / $500 (+5%) / $2,000 (+12%), balance never expires.
Unlimited: flat-rate concurrency **from $40/mo**; the published card is **$350/mo for 25
concurrent**, with extra concurrency priced per unit (~$14). One key runs both plans.

### Why it is that low — three structural reasons, none of them a discount

1. **The unit is bytes, not requests.** A text page is ~100 KB, so the meter barely moves.
   They are charging the marginal transfer cost and taking margin on compute.
2. **No per-tenant machine.** Everything runs on a shared high-density pool. There is no
   idle browser billed by the minute, so there is nothing to amortise into the page price.
3. **Failed pages are free.** The meter only runs on work that produced something.

None of that is a pricing trick. It follows from selling **stateless fetching**.

### The comparison that matters

Spider's 100-page example costs $0.01. Our crawl is 3 credits:

| our bucket | €/credit | 3 credits | vs Spider's $0.01 |
|---|---|---|---|
| enterprise monthly | €0.0025 | €0.0075 | **~1.0×** — level |
| pro monthly | €0.004 | €0.012 | **~1.3×** — level |
| starter monthly | €0.01 | €0.030 | ~3× |
| pack 2,000 | €0.1245 | €0.37 | **~40×** |
| pack 100 | €0.19 | €0.57 | **~62×** |

**Our subscription rate is already competitive with Spider. Our pack rate is not.**

### The real defect this exposed, which has nothing to do with the competitor

One credit costs **€0.0025** to an enterprise subscriber and **€0.19** to a pack buyer —
a **76× spread on the same unit**. No table can look coherent while that is true, and no
customer comparing "cost per page" will do anything but bounce off the pack page.

The audit had already flagged the narrower version of this (D2: PAYG undercutting packs by
19–25×). The correct reading is that **the packs are the outlier**, not PAYG. A pack is
"no commitment", which justifies a modest premium over the subscription rate — not 40–76×.

### Recommendation (needs sign-off; it is a revenue decision)

Retier packs so the credit price sits **at or slightly above the starter rate**, not 19–48×
above it. A defensible ladder, keeping the same pack sizes:

| pack | now | proposed | €/credit | vs starter's €0.01 |
|---|---|---|---|---|
| 100 | €19.00 | **€1.50** | €0.015 | 1.5× |
| 500 | €79.00 | **€6.00** | €0.012 | 1.2× |
| 2,000 | €249.00 | **€20.00** | €0.010 | 1.0× |

That is a large cut in list price, so it needs the owner's call. The case for it is not
generosity: at today's pack rates a customer who compares on cost per page simply leaves,
and the credits they do not buy are worth €0 to us.

**Do NOT copy Spider's unit.** Pricing browser sessions by bytes would price the wrong
cost driver — our real cost is machine-minutes, which is why `07` Part E.1 chose 5-minute
blocks. The three things worth copying are cheap and honest:

1. Publish a **cost per page** beside the per-request price (we can derive it from `crawl`).
2. State that **failed requests are free** — `requirePaidAccess` already releases the
   reservation on failure, so this is true today and unadvertised.
3. Say plainly that packs cost a little more than a subscription, which is what makes the
   premium legible instead of looking arbitrary.

