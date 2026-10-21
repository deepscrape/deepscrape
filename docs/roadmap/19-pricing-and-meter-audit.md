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

**FIXED** — see Part 16. The placeholder is gone, the tier is sales-led, and `unlimited` is
an access mode the billing table refuses to charge.

`billingPlanCatalog` gives `enterprise.prices.payAsYouGo` amount `0` with no
`stripePriceId`, and no such price exists in either Stripe account. Checkout refuses it
(`stripe.ts:2013` throws when the resolved id is missing), so it is not purchasable — but
if the client renders every interval from the catalog it displays a €0.00 Enterprise
option. `free`/`trial` have the same zero entries but are not offered for sale.

### D6. Price fallbacks in code are archived TEST-mode ids

**FIXED 2026-10-20.** Every fallback in `billingPlanCatalog` and `creditPackCatalog` now
names the price id that is *currently active* in the test account — the `price_1UHr…` plan
generation and the `price_1USYn…` credit generation, all re-read from the Stripe API in
this session. The fallbacks stay TEST-mode on purpose: `createCheckoutSession` resolves by
`lookup_key` first, and a missing env var should fail loudly in dev rather than quietly
charge a live price. The neighbouring comment's "as verified" date was corrected to match.

Related, same defect class: `functions/.env.local` still lists the archived `price_1T7Z…`
generation on lines 34–44. Those prices are `active: false`, so a local checkout built from
that file fails with "price is inactive". Repoint at the `price_1UHr…` ids.

### D7. `validateStripeCatalog` is a callable, never scheduled

**ADDRESSED — `checkStripeCatalogHealth`** (`stripe.ts`, `onSchedule` hourly). It walks the
sellable catalog, asks Stripe whether each `lookup_key` resolves, and records a
`stripe_catalog_incomplete` incident in `billing_incidents` with a 24-hour cooldown. That is
the automatic detection this entry asked for; the admin-only `validateStripeCatalog` stays as
the deeper, on-demand audit.

What the scheduled check deliberately does **not** do: amount, currency and interval drift.
It answers only "would a checkout succeed", which is the question that stayed silent while
production had no catalog. Drift is still caught only when someone runs the callable — worth
closing if the catalog changes often, but it is no longer the silent-failure class.

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

Credits: **retiered and applied 2026-10-20** — 100 = €1.50, 500 = €6.00, 2000 = €20.00
(see Part 8). New ids: live `price_1USZ4w…` / `price_1USZ55…` / `price_1USZ5C…`,
test `price_1USYnO…` / `price_1USYnZ…6vkd` / `price_1USYnZ…vGPp`. The superseded
€19/€79/€249 prices are archived in test and still active in live until the production env
is repointed.

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

- ~~No Stripe object was created, updated, or archived.~~ **False since 2026-10-20.** The
  retier created three credit prices in each account, transferred the `ds_credits_*` lookup
  keys to them, and archived the test-mode predecessors. Superseded by Part 8.
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

---

## Part 8 — The retier applied, and which of these numbers will go stale

### 8.1 What was changed, and in what order

| step | state |
|---|---|
| `creditPackCatalog` amounts → 150 / 600 / 2000 | code, committed in working tree |
| `CUSTOM_CREDIT_UNIT_AMOUNT_EUR` default 19 → 1 | code |
| Fallbacks repointed to active test ids (D6) | code |
| Test account: 3 new prices, keys transferred, 3 old archived | done |
| Live account: 3 new prices, keys transferred | done |
| Live account: 3 old prices archived | **deliberately not yet** |

Archiving live is last on purpose. `createCheckoutSession` charges the id in
`STRIPE_PRICE_CREDITS_*`, not the lookup key, so archiving before the production env points
at the new ids would break live checkout between the two steps. The credits product has
`default_price: null`, so nothing else blocks the archive.

**A trap worth naming:** the live ids are `price_1USZ4w…`, `price_1USZ55…`, `price_1USZ5C…`.
The test ids are `price_1USYnO…`, `price_1USYnZ…`, `price_1USYnZ…`. Stripe ids do not cross
modes — putting a `price_1USYn…` id in the production env fails at checkout creation.

### 8.2 Measured latency (2026-10-20, one workstation in the EU)

`GET /status` on the deployed BFF, no auth, no database, no browser:

| measurement | value |
|---|---|
| cold (first request) | 664 ms |
| warm n=40, min | 327 ms |
| warm p50 | **356 ms** |
| warm p90 | 927 ms |
| warm max | 1,433 ms |

Decomposed with curl (5 fresh connections): DNS 7–10 ms, TCP connect 28–47 ms (Google edge),
TLS 130–740 ms, and `ttfb − tls` **250–510 ms** — the edge→`us-central1` backhaul plus the
handler. `GET /` on the CDN-served site in the same era had min 152 ms / p50 423 ms.

**Reading:** the handler is a rounding error. The latency is distance to `us-central1` and a
slow TLS path. That is a placement problem, not an application problem.

**Limits of this measurement, stated plainly:** one workstation, one region, a health
endpoint. It does **not** measure machine provisioning, a browser step, or page load. Those
still need a real session and a p50/p95 of `POST /navigate`.

### 8.3 Which inputs are volatile, and by how much

| input | value used | sensitivity | what moves it |
|---|---|---|---|
| Fly RAM | $6.00/GB/mo | **dominant** — 1.5 GB extra is 67% of the machine | Fly list change |
| Fly 2× shared CPU preset | $4.39/mo | secondary | Fly list change |
| Fly egress | $0.02/GB NA/EU · $0.04 APAC · $0.12 Africa/India | small per session (~$0.00024 for 12 MB) | region of the machine |
| Cloud Run | $0.000024/vCPU-s | min-instance floor only | GCP list change |
| Firestore | $0.03/100k reads, $0.18/100k writes | ~$0.0003/session | essentially stable |
| Upstash | per-command | negligible at this volume | plan change |
| **EUR/USD** | costs in USD, prices in EUR | **entire margin** | FX |

The last row is the one nobody budgets for: every bill is USD and every price is EUR, so a
10% currency move changes gross margin 10% with no change in cost or price.

### 8.4 What survives a cloud price change, and what does not

**Survives** — these are properties of the product, not of a price list:

1. The **unit**: machine-minutes for sessions, credits for actions. Fly can double RAM and
   the machine-minute is still the cost driver.
2. The **credit ratios**: 1 browser step, 2 image work, 3 batch, 5 unbounded payload,
   10 site walk. They follow work performed.
3. The **ordering rule**: pack ≥ starter rate, and pack ≤ ~1.5× starter. A pack is "no
   commitment", which is worth a premium and not a multiple.
4. Failed requests are free (`requirePaidAccess` releases the reservation).

**Does not survive** — anything expressed as an absolute €/credit:

- €0.010–0.015 per credit is derived from today's $6.00/GB Fly RAM. It is a *conclusion*,
  not a fact. Re-derive it when the input moves rather than editing the conclusion.

### 8.5 Is region-based pricing necessary?

**Not yet, and not for the reason usually given.** The cost delta between regions is real
but small: egress at $0.12/GB instead of $0.02/GB adds ~$0.0012 to a 12 MB session against
$0.0015 of machine time. Even in the worst region, egress stays under the dominant driver,
so a regional price multiplier would be charging for a cost that is not there.

What *is* regional is **latency** — measured above at 250–510 ms of backhaul to
`us-central1` for an EU client. So the correct first move is regional *placement*
(`BROWSER_MACHINE_REGION` is already a variable and currently pinned to `iad`), and a
regional *price* only if an egress-heavy region becomes a large share of sessions.

### 8.6 What should be added so this stays true

- Record the cost basis beside the credit: `{region, flyMachineHourUSD, egressUSDperGB,
  measuredAt}`, and re-derive €/credit when it moves. Today the derivation lives in a code
  comment, which is where a number goes to quietly become wrong.
- Assert the ordering rule in a spec (`pack ≥ starter`, `pack ≤ 1.5 × starter`) so the next
  retier cannot recreate the 76× spread.
- A scheduled catalog check (D7) so a lookup key that drifts is detected without a human
  reading the dashboard.

---

## Part 9 — The live webhook pins no API version

Found while checking a different question: were live webhooks even arriving?

| | live | test |
|---|---|---|
| endpoint | `we_1UHngB…` | `we_1T7adu…` |
| status | enabled | enabled |
| url | `stripewebhook-…run.app` | `stripewebhooktest-…run.app` |
| `checkout.session.completed` | subscribed | subscribed |
| events subscribed | 21 | 21 |
| **`api_version`** | **`null`** | `2023-10-16` |

**Both endpoints are correctly registered.** Seven days of Cloud Run logs show **zero**
deliveries to `stripewebhook` against eight for `stripewebhooktest`, which means no live
sales — not a broken endpoint. That hypothesis is closed.

**The defect is the last row.** `api_version: null` makes live deliver whatever the
account's default version is, and Stripe advances that default silently. So the two
endpoints can send *different payload shapes for the same event*, and the difference is
invisible until money moves.

Two sites read a field that moved between versions (`invoice.subscription` →
`invoice.parent.subscription_details.subscription`):

- `invoice.paid` — had a fallback to the stored `billing.subscriptionId`, so renewal credits
  would degrade rather than vanish.
- `invoice.upcoming` — **no fallback**, and `break`s when the id is missing. Renewal-warning
  alerts would have stopped in live while still firing in test: no error, no log.

**Fix applied 2026-10-20.** `getInvoiceSubscriptionId` reads both shapes (string or expanded
object, legacy or nested) and returns null rather than inventing an id; both branches use it.
Six tests pin the four shapes plus the both-present and neither-present cases. tsc 0, lint 0
errors, 866 tests / 857 pass / 0 fail.

**Pinning is IMPOSSIBLE, and this section originally said to do it. Corrected 2026-10-20**
against Stripe's own object reference: `api_version` is *"The API version that events are
rendered as for this webhook endpoint. **You can't change this value after you create the
endpoint.**"* The MCP call that failed with `Received unknown parameter: api_version` was not
a tool-schema gap, as this section first claimed — the field is immutable. The only way to
change it is to create a NEW endpoint and move the signing secret, which would resubscribe
nothing but would require re-pointing the dashboard config.

So the code fix is not a workaround for a pin that was skipped: **it is the only remedy that
exists.** That also raises the stakes on it, and the same page confirms why — the current
Invoice object's attribute list carries `parent` and **no `subscription` at all**. The field
this code used to read is not merely moved for old versions, it is absent in the version the
unpinned live endpoint renders.


---

## Part 10 — Unknown `/api/*` answered 200 with the SPA shell

Found while chasing the latency numbers, when the request mix in Cloud Run logs turned out to
be mostly scanner probes.

**Not a leak.** `/.env` and every dotfile probe answered 404: the `MISSING` guard in
`bff/server.ts` covers probe shapes and dotfile paths, and its comment explains why the
extensionless ones had to be added (a 200 tells a scanner to keep going).

**But two things answered 200 with the 86 KB shell:** extensionless probes such as
`/userfiles?path=../../.env`, and — the real defect — **any unregistered `/api/*` path**. A
client asking for JSON received HTML with a success status, so a typo'd endpoint looked like
it worked.

The suite was green throughout because `api.spec.ts` asserts the 404 against the **api
sub-app**, which does 404 correctly; the root catch-all wins for paths that group never
claimed. A test of the part, passing while the whole misbehaved.

**Fix applied 2026-10-20.** The catch-all answers `/api` and `/api/*` with `404
application/json` before serving the shell. Deep links are untouched — extensionless page
paths still get the shell, and `server.spec.ts` keeps asserting that for `/admin/settings`.
75 BFF tests pass, `tsc` clean.

Left alone deliberately: extensionless probes outside `/api` still receive the shell. They are
indistinguishable from a legitimate client-side deep link, and nothing is disclosed by a
landing page that is public anyway.

---

## Part 11 — The usage page now shows what each meter cost

**The gap.** The usage page showed totals — usage-to-date, credits available, credits used,
invoiced, paid — and a Stripe breakdown of invoice lines underneath. What it never said was
*which capability consumed the credits*. "You used 4,200 credits" is not an answer a customer
can act on; "3,900 of them were `crawl.execute`" is.

**Built 2026-10-20.**

- `summarizeMeteredConsumes` (`functions/src/app/stripe.ts`) — one pass over the existing
  `consume` ledger rows, returning the in-range total plus a per-capability breakdown. Pure
  and exported, because the callable cannot be tested without Firestore and this number is
  money.
- `getBillingUsage` returns it as `usage.metered`, and `creditsUsedInRange` now comes from the
  same pass, so the card and the table cannot disagree.
- `BillingUsageMeter` in `billing.interface.ts`, optional on the stats type so an older payload
  still parses.
- A "Metered usage" card on `usage.component.html`: capability, events, credits, and a share
  bar, using the existing card styling. Six labels across all five locales.

**Three decisions worth stating:**

1. **The key is `reason`, not `source`.** `reason` is the pricing policy's own action name,
   written at charge time — the same string `defaultPricingRules` charges on. `source` is the
   fallback for older rows, and a row with neither lands in `unknown` rather than being
   dropped, because a breakdown that does not sum to its own total is worse than an unnamed
   bucket.
2. **Magnitudes.** The ledger stores `consume` deltas as negative; the report takes the
   absolute value. Without that every meter would read negative.
3. **No € column.** A single euro-per-credit figure would be wrong for any account that mixes
   a plan with packs, since the rate differs per instrument. Credits are the honest unit here;
   the rates page already maps credits to actions.

**Not done in Part 11, done in Part 12:** the four `SESSION_TOOLS` and the 5-minute block are
metered by the session sweep, which writes its own ledger rows under `reason: "meter:block"`.
Part 11 shipped that line without a way to tell one machine from another; Part 12 records the
machine id on every metered block and counts the distinct machines in the breakdown.

**Gates:** functions `tsc` 0, lint 0 errors, 865 tests / 857 pass / 0 fail (8 new, pinning the
window, the grouping, the fallbacks, the ordering and the empty case); app `tsc` 0;
`bun run build` 0 with 14 prerendered routes; all five locale files parse.


---

## Part 12 — Session-meter rows now name the machine, and have a name at all

**What was wrong.** Two things, and the second was worse than the first.

1. Every metered block is written with `reason: "meter:block"`. That string is identical for
   every block of every session, so the Part 11 breakdown folded an entire account's browser
   time into one anonymous line. It could say browser time cost 47 credits and nothing about
   where the 47 were spent.
2. The ledger recorded `sessionId` but **no machine id**, so there was nothing to join on even
   if the page had wanted to. That is not a display gap — the fact was never written down.

**Fixed.**

- `machineId` is now a first-class field on `BillingCreditMetadata`, and `chargeSessionMeter`
  writes `record.machineId` on every block. It is guaranteed non-empty by the time the loop
  runs: `isMeterBillable` already returns false for a session with no machine and for a BYO
  session, and a charge that is not billable never reaches the ledger write.
- `MeteredConsumeRow` reads it, and `MeteredUsageTotal` gains `machines` — the count of
  **distinct** non-blank ids behind that key, not a row count. Four blocks on one machine is
  `machines: 1`; four blocks on two machines is `machines: 2`.
- The usage card renders "N machines" under the capability name, and only when N > 0.
- `meter:block` finally has a label. It is not a pricing action, so `ACTION_LABELS` cannot
  name it; `LEDGER_REASON_LABELS` in `usage.component.ts` maps it to "Browser session time".
  Left unmapped it rendered as the raw identifier on the largest line of a browser-heavy
  account, which is the one row a customer most needs to read.

**Two honest limits.**

1. **History cannot be backfilled.** Rows written before this change have no machine id and
   will report `machines: 0` forever. The page shows the count only when positive, so those
   rows are quiet rather than wrong.
2. **`0` is not "one machine".** A request-priced capability (`crawl.execute`) carries no
   machine id, because the charge is for a request rather than a lease. Reporting `1` would
   assert something the ledger never said.

**Gates:** functions `tsc` 0; 19/19 across `stripe-metered-usage.spec.ts` and
`stripe-subscription-period.spec.ts`, including three new cases for the distinct count, the
zero case and blank ids.

---

## Part 13 — D2 and D4, closed

### D2 — CLOSED by the retier, and D1 was the real cause

The 19–25× gap was a ratio between two numbers that both moved. Recomputing against the
applied pack prices:

| Purchase | Price | Credits | € per credit | vs starter PAYG |
|---|---|---|---|---|
| starter PAYG | €0.99 | 100 | €0.0099 | — |
| pro PAYG | €1.99 | 500 | €0.0040 | — |
| pack 100 | €1.50 | 100 | €0.0150 | 1.5× |
| pack 500 | €6.00 | 500 | €0.0120 | 3.0× |
| pack 2000 | €20.00 | 2000 | €0.0100 | 2.5× |

The multiple is now 1.5–3× rather than 19–25×, and that residue is the correct shape: a pack
is a no-commitment top-up and should cost more per credit than a subscription, but not 25×.

**The defect was never really the ratio.** It was D1 — `payAsYouGo` granting a permanent plan
on a one-time payment, which made the €1.99 purchase both the cheapest credits *and* a
permanent Pro subscription. D1's 3-day window (`b00ea20`) removed the arbitrage; the retier
removed the absurdity. Neither is left to review.

### D4 — CLOSED, not a defect: the two routes buy different things

The 300× figure compares two routes that look alike and are not:

- `GET /api/browser/session/:id/frame` is a live view of the caller's **own leased machine**.
  That machine is already paid for by the session meter, so the frame itself is free. Charging
  again would bill the same machine twice.
- `POST /api/observe` takes an ad-hoc screenshot on a **pool worker**: a browser the caller has
  not leased, whose CDP CPU the meter never sees. One credit is the only price it can have.

This is now stated in the pricing table itself rather than here alone, because the reasoning
belongs beside the numbers.

**What is left is a caller-side choice, not a leak.** Polling `observe` as a video feed costs
300 credits over the window that a lease would cost 1. That is expensive *for the caller* and
correctly priced *for the platform* — each call spends real pool CPU. It is worth a rate-limit
if anyone is observed doing it; it is not worth a price change.

---

## Part 14 — `batch` is capped, not unbounded; and the price belongs to the unlimited review

**The premise was wrong and the audit should say so.** The concern was "`batch` is a flat 3
credits for an unbounded URL list". The list is bounded: `MAX_TARGETS = 50`
(`url-guard.domain.ts`), enforced by `targetListFrom` for `batch`, `download` and `crawl`
alike, and a list over the cap is refused whole rather than truncated. `concurrency` is
separately capped at 8.

**The real open question** is that a request costs the same whether it carries 1 target or 50,
so a 50-target batch is 0.06 credits per URL against a 3-credit single crawl. That is a
pricing-model decision, and the code currently documents flat-per-request as deliberate:
`estimateBillingCost` has no `count` input precisely because multiplying it would quote a price
the platform does not charge.

**Deliberately left alone.** Charging per URL now would work directly against the
enterprise/unlimited tier under review: an unlimited plan is how a flat per-request price
stays honest at scale. Changing the multiplier first would mean charging twice for the same
policy shift. The decision is recorded here with the numbers so it can be settled in that
review rather than by accident in this one.

---

## Part 15 — BYO credentials are not blocked on storage; the pattern already exists twice

The earlier note said the per-tenant Fly credential was blocked because "no per-tenant
credential store exists anywhere in code". That was wrong, and the correction matters because
it changes the size of the remaining job from "invent a secret store" to "copy a pattern".

**What already exists.**

- `byobSecretId` — one Secret Manager secret per caller for their own bucket (Tigris).
- `byo-egress.domain.ts` — one Secret Manager secret per caller for their own proxy pool:
  - `egressSecretId(uid)` → `egress-byo-<uid>`, so the caller's identity IS the namespace:
    there is no list to enumerate and no way to read a pool without knowing whose it is.
  - The Firestore document holds **one** field, `secretPath`, and nothing else. Presence
    means "this caller has their own exits"; absence means "use the platform pool". Two states
    that cannot disagree the way a `mode` plus a `count` can.
  - Nothing in the domain module emits a credential: every export validates one, serialises
    one into the secret, or projects one down to a masked host through the masker the admin
    surface already uses — one masking rule rather than two that drift.

**So the Fly token has a home.** A `flySecretId(uid)` → `fly-byo-<uid>` following
`egressSecretId` verbatim, a Firestore pointer with the same one-field shape, and the token
read at the single chokepoint (`callArachnefly`) rather than at any of its callers.

**Why it is still not written, and what it needs first.**

1. **A refusal contract.** An unresolvable BYO credential must refuse at the *caller* and never
   fall back to platform compute. Falling back silently would double-bill a tenant for machines
   in their own organization — the exact failure `isMeterBillable` was changed to prevent on
   the charging side. Deciding what status a caller sees (409? 402? 422?) is a product decision,
   not a code one, because it is the message a tenant reads when their own org is misconfigured.
2. **An input surface.** Somewhere a tenant pastes a Fly token and some code validates it
   against Fly's API before storing it. That surface does not exist, and inventing it without
   the plan review would be guessing at which tier is allowed to use it.
3. **It belongs to the unlimited-tier review.** Running machines in the tenant's own Fly org is
   the mechanism an unlimited plan needs; pricing and access for it is the same conversation as
   the enterprise PAYG question, so it is scheduled with it rather than before it.

**What is already safe.** The double-bill path is closed today: `isMeterBillable` returns false
for `computeSource: "byo"`, so a BYO session is never charged the platform's meter, and
`chargeSessionMeter` returns before writing any ledger row.

---

## Part 16 — D5 applied: Enterprise is sales-led and unlimited

### The decision

Enterprise has **no self-serve pay-as-you-go**, is bought through sales, and is provisioned as
**unlimited usage under a negotiated agreement**. Subscription, support and SLA are the
product; the meter is not.

The reason is not squeamishness about metering. A metered option next to a term contract
competes with our own sales team: a procurement group that can buy usage one month at a time
will never sign an annual commitment. Every platform that sells enterprise — Datadog,
Snowflake, Sentry, Vercel, Spider — hides the meter behind "Contact sales" for exactly this
reason. Enterprise revenue is a contract, not a run rate of credits.

### What changed

| Layer | Change |
|---|---|
| Catalog type | `prices` is `Partial<Record<BillingInterval, BillingPriceConfig>>`; `salesLed` and `unlimited` flags added |
| Enterprise entry | `payAsYouGo` **removed** (not zeroed); `salesLed: true`, `unlimited: true`; monthly/quarterly/annually kept as anchors |
| `createCheckoutSession` | refuses a sales-led tier and refuses an interval the plan does not sell |
| `inferPayAsYouGoPlanFromPayment` | skips a plan with no pay-as-you-go price |
| `getBillingAccessMode` | returns `unlimited` when the flag is set **and the plan is still valid** |
| `validateStripeCatalog` / `checkStripeCatalogHealth` | walk only the intervals a plan lists |
| Plans page | "Custom" headline, "Contact sales" action that submits the existing `submitEnterprisePlanRequest`, "Unlimited usage…" line |
| Plan-details page | lists only the intervals the plan sells |
| Public pricing page | Enterprise card shows `Custom` + "Contact sales" + an unlimited bullet |
| `submitEnterprisePlanRequest` | records which surface asked (`billing_plans` vs `service_onboarding`) |

**Removing the key, not zeroing it, is the fix.** `buildBillingPriceConfig("enterprise",
"payAsYouGo", 0)` existed only to satisfy `Record<BillingInterval, …>`, and the client
faithfully rendered that placeholder as a clickable EUR0.00 option.

### Why `unlimited` cannot become free product

It refines the validity verdict rather than replacing it:

```ts
if (isPaidPlan(billing?.plan) && !isPaygWindowClosed(billing, now)) {
  return billing?.unlimited === true ? "unlimited" : "plan"
}
```

The lapsed-plan test runs first, so a flag left on a cancelled account grants nothing. And the
unmetered part is not the flag: it is that `isChargeableAccessMode` names only `credits` and
`plan`, so every charging path — `requirePaidAccess`, the cost estimate, `machineChargeFor`,
the session meter — already declines to bill an `unlimited` caller without knowing the flag
exists.

### Deal shapes this enables (sales, not self-serve)

All three are the same mechanism — a term subscription at the Enterprise tier plus
`unlimited: true` — differing in commitment and service, never in price-per-credit:

1. **Committed annual.** 12-month prepaid term, seat or usage floor, unlimited crawling under
   fair use, 99.9% uptime SLA, named support, quarterly business review. Discount lives in the
   term length, not the meter.
2. **Annual + dedicated capacity.** As above plus reserved machine pool in the tenant's own Fly
   organisation (the BYO credential work in Part 15), so their compute is theirs and ours is
   not in the loop. Highest margin for us, strongest data story for them.
3. **Pilot → convert.** 30–60 day fixed-fee pilot with a defined success metric, converting to
   (1). Counted as a trial in the CRM, never as PAYG, so it cannot seed the habits D1 and D2
   were about.

### What is deliberately not built yet

**There is no admin surface to grant `unlimited`.** An operator sets `billing.unlimited` on the
user's billing document today; a proper toggle belongs on the admin billing screen, with an
audit entry naming who granted it and until when. Until it exists, an unlimited deal is a
Firestore write — which is acceptable for the first handful of contracts and not for the
twentieth.








