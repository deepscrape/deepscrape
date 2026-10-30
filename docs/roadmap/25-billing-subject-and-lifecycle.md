# Phase 25 — the billing subject, and the three deletions

Status: **blueprint**. Sections marked *shipped* are in the tree and gated. Everything
else is a decision with a recommendation, not a task list to start blindly.

Depends on: 04 (organizations and BYO), 19 (pricing and meter audit), 20 (must-fix ledger).

---

## 1. The model — three nouns, one payer

| Noun | What it is | Money it can hold |
|---|---|---|
| **Account** | a Firebase Auth user (`users/{uid}`) | `users/{uid}/billing/current` — a personal wallet, and optionally a personal subscription |
| **Workspace** | `organizations/{orgId}` + `memberships/{uid}_{orgId}` | `orgs/{orgId}/billing/current` — a shared wallet. No plan today. |
| **Billing subject** | *whichever of the two the API will charge* | resolved per request, never stored on the request |

There is no fourth noun. A "workspace" and an "org" are the same document; the UI
calls it a workspace and the data layer calls it an org. Anything that needs a
sub-workspace gets another org, because quota, deletion and the ledger are already
org-shaped.

### The rule (shipped, one place)

```
resolveSpend(uid, orgId):
  orgWallet = resolveOrgWallet(uid, orgId)        // membership + spending role + wallet non-free
  orgWallet ? org pays : person pays
```

`resolvePayerOrg` refuses a non-member, and `orgRoleMaySpend` refuses a role that may
not spend, so a caller cannot nominate somebody else's workspace to pay.

### 1.1 What the workspace is **today** — verified, and it is not a data partition

The ask is "a workspace scopes the data, and billing is a breakdown per workspace".
The second half is already true. The first half is **not**, and this is the one place
where the model as built disagrees with the model as described.

| Axis | Scoped by | Evidence |
|---|---|---|
| URL and routing | **org** | `/{orgId}/…`, `orgScopedUrl`, `orgScopeGuard` |
| Membership and roles | **org** | `memberships/{uid}_{orgId}` |
| Money: wallet, ledger, balance | **org** (`orgs/{orgId}/billing/current`, `orgs/{orgId}/credits_ledger`) | `billingDocPath` |
| Cost attribution per event / action / feature | **org** — every ledger row carries the pricing action in `reason` (`crawl.execute`, `machines.deploy`, `meter:block`, `ai.*.chat`) plus `machineId` | `summarizeMeteredConsumes` |
| Operations, crawl packs, browser profiles, storage, machines | **uid only** | `users/{uid}/operations`, `/crawlpack`, `/browser`; `listBrowserSessions(uid)` |

So a workspace today buys and pays for **people and money**, not for shared objects. A
member's operations and crawl packs are theirs, in every workspace they open.

**The fork — do not build both:**

| Option | What it means | Cost |
|---|---|---|
| **A. Workspace = shared money and people** (what exists, declared honestly) | data stays personal; sharing is explicit and later (invite a member to a pack/operation) | ~0 now; one sentence in the UI |
| **B. Workspace = data partition** | every user-owned collection gains `orgId`; queries, rules and indexes all change; "my work follows me" stops being true, and leaving a workspace changes what you can see | a migration across ~10 collections, plus a new privacy question (who owns an operation created by a member?) |

Recommendation: **A now, B only with a named customer requirement.** A is a sentence; B
is a data migration that cannot be undone quietly. The reply to "where do I see the
team's operations" is "you don't yet — that is B", not a re-keying nobody asked for.

**DECIDED 2026-10-30 (owner): shared operations / crawl packs / profiles ARE wanted, and
the migration is deferred.** So the target is **B**, but nothing is re-keyed yet. Until
the migration lands:
- the product must not imply shared objects (no "team workspace" copy on a page whose
  contents are still personal);
- new collections added from now on should be born with an `orgId` field so the future
  migration touches fewer shapes — that is the only preparation worth paying for today;
- the two questions B raises (who owns an operation a member created; what a member sees
  after leaving) must be answered before the first collection is re-keyed, not after.


### 1.2 The report that answers "what did this workspace cost" reads the wrong ledger

`getBillingUsage` hard-codes `users/{userId}/credits_ledger`. There is no `orgId`, so the
one screen built for cost history shows the **personal** wallet even while the workspace
pays. The aggregation that would make it a real breakdown already exists and already
groups by the pricing action, by day, and by machine — it is pointed at one of the two
ledgers.

**This is step 0**, ahead of org checkout: a workspace whose spend cannot be seen is a
workspace nobody will fund twice.

### The defect this phase fixes (shipped 2026-10-30)

The API charged the workspace while the client was told the *person* was free, so
`paywallGuard` bounced a funded member to `/billing/plans`. Two answers to one
question. Now:

- `getMyEntitlements` accepts `{orgId}`, resolves it through `resolveOrgWallet`, and
  returns the **paying** wallet plus `payerOrgId`. Membership is checked server-side;
  the org id is caller-supplied and never trusted.
- `BillingService.billing$` takes `AuthzService.activeOrgId$` as a source, passes it,
  and caches **per wallet** (`uid:orgId`) so switching workspace cannot show the other
  workspace's balance.

Gates: functions `tsc` 0 / lint 0 errors / **1049 tests, 0 fail**; app `tsc` 0;
`billing.service.spec` 8/8 including "asks about the active workspace and caches per
wallet".

---

## 2. Recommendation — org plans, and why they are a different product

Two shapes, not one shared shape.

| | Personal plan (**shipped**) | Workspace plan (**recommended, not built**) |
|---|---|---|
| Stripe customer | the person | the organization |
| Where the plan lives | `users/{uid}/billing/current` | `organizations/{orgId}` → mirrored to `orgs/{orgId}/billing/current` |
| Who pays | that person | the workspace wallet, for every member with a spending role |
| Seats | n/a | members with `orgRoleMaySpend`, counted at renewal |
| Cancellation | that person loses their plan | the workspace reverts to credits/free; members' personal wallets untouched |

**Why not seats on a personal plan.** Billing a team from one employee's card means the
workspace's money is controlled by whoever holds the card, leaves with them, and cannot
be seen by the org owner. That is the support ticket that turns into churn.

**Why the resolver already supports it.** `resolveSpend` prefers the org when its wallet
is non-free. Add a plan to the org snapshot and the same four access modes apply —
`getBillingAccessMode` takes a snapshot, not a path, so nothing in the pricing layer
changes.

Delta to implement, in this order:

1. `organizations/{orgId}` gains `{stripeCustomerId, subscriptionId, plan, planInterval, seats}`;
   `stripe_customers/{customerId}` → `{kind: "user"|"org", id}` is the reverse index the
   webhooks already need (`resolveUidByStripeCustomer` is the user-only version of it).
2. `createCheckoutSession` gains `{orgId}` with the *same* ownership check as
   `deleteOrganization` (owner or platform admin — buying for a workspace is an owner act).
3. `customer.subscription.*` and `invoice.*` resolve their subject through the reverse
   index instead of assuming `users/{uid}`.
4. `getMyEntitlements` already prefers the org wallet; a workspace plan makes that wallet
   carry `plan`, so no further client change.
5. A workspace with a plan must **not** silently debit personal credits: the resolver
   already guarantees this (org non-free → org pays).

**What NOT to build:** org price lists (§4.3 of roadmap 04). A per-tenant price list
means a per-tenant invoice, dunning and tax story. Charge the platform list price to the
org wallet; if a reseller needs margins, sell them credits at a discount — which the
transfer function already models.

---

## 3. The three deletions are not the same thing

Verified in source on 2026-10-30.

### 3.1 Account deletion — `performAccountDeletion` / `purgeDeletedAccounts`

| Step | What happens |
|---|---|
| money **first** | `cancelStripeBilling(uid)` — cancels the subscription before the door is locked, so a deleted customer is never billed again |
| door | Auth disabled, email rewritten, refresh tokens revoked, Redis tombstone |
| blockers | already deleted; **last platform admin**; **sole owner of a shared org** (transfer ownership first) |
| grace | `purgeAfter` derived from the actor (self vs admin) |
| purge (03:30 UTC) | recursive delete of subcollections — the **wallet and ledger go with them**; Stripe customer deleted; blobs, secrets; orgs deleted or **transferred to an heir**; Auth record deleted; audit keeps the fact, not the person |

**Gaps**

| # | Gap | Recommendation |
|---|---|---|
| D1 | Purchased credit balance is **destroyed with no record**. The audit keeps orgs and machines but not "this account forfeited N purchased credits". | ~~Recommendation~~ **SHIPPED 2026-10-30**: the purge reads the wallet **before** the subcollection sweep and writes `creditsForfeited: {purchased, included}` onto the audit document. `creditsAtDeletion` is recorded separately at scheduling, because the grace window is long enough to spend the difference. |
| D2 | Self-service deletion is allowed with a large unused prepaid balance, silently. | **SHIPPED 2026-10-30**: `requiresForfeitAcknowledgement` (pure, 4 spec cases) refuses a self-service erasure when `purchased > 0` until `forfeitCredits: true` arrives; the danger zone lists the forfeiture as step 4 before the code step, and the client acknowledges on confirm. An **admin** erasure never asks — the actor is not the person losing the balance, and the audit records it either way. |
| D3 | Cancellation is immediate, unused period is not refunded. | Policy, not code. State it in Terms and at the cancel button ("access ends now; no pro-rata refund"). |

### 3.2 Organization deletion — `ReverseAPIProxy.deleteOrganization`

| Rule | Verified behaviour |
|---|---|
| who | **owner** or platform admin. An org admin with `organization.manage` is refused: *"the capability to rename is not the capability to destroy"* |
| credits | **409 `org_has_credits`** — "This organization holds N credits. Spend them before deleting it." A platform admin may force, and the forfeiture is logged at `CRITICAL` |
| cascade | org + memberships deleted; `users/{uid}.defaultOrgId` repointed to the next owned org |
| gap | There is **no way to get the balance back** — the only exit is "spend them" or "admin force". | Offer **"return the remaining balance to me"** in the delete flow. `transferCreditsToOrganization` already moves credits between the two wallets; this is a button over an existing transaction, not new ledger work. |
| gap | Deletion is hard and immediate; a mis-click destroys a workspace with all its memberships. | 7-day soft delete (`deletedAt`, hidden from the switcher, restorable by the owner) before the cascade. Only if workspaces start holding things members cannot lose — today they hold only a balance, which is protected by the 409. |

### 3.3 Workspace "deactivation" — does not exist

There is no suspend, no archive, no transfer of an org to another owner beyond
`transferOwnership`. Recommendation: **do not invent one**. If "archive a workspace" is
asked for, it is `deleteOrganization` plus the credit-return flow above; a third state
means a third set of rules about who may spend from a suspended wallet.

---

## 4. Refunds — what exists, and the two things that are policy

**Implemented and verified in source:**

- `charge.refunded` records an incident **and takes the credits back**:
  `computeRefundCreditReversal` + `applyBillingCreditMutation`, keyed `refund:{chargeId}`
  so a replay reverses nothing.
- Documented shortcut: **one reversal per charge**, so a chain of partial refunds
  under-recovers (it never over-debits — that is the deliberate direction).
  Upgrade to lot accounting only if partial refunds of one charge become common.
- `charge.dispute.created` records the dispute and its evidence deadline.
- Disputes do **not** claw credits back. Recommendation: on `charge.dispute.created`,
  freeze the wallet (a `hold` flag the resolver treats as non-free-but-unspendable) until
  the dispute resolves, rather than reversing on a chargeback that may be won.

**Policy decisions still required (not code):**

| Question | Recommendation | Why |
|---|---|---|
| Refund a plan mid-period? | No. Cancel now, no pro-rata. | Pro-rata refunds on a metered product invite arbitrage: consume the credits, claim the month. |
| Refund unused credit packs? | Yes, **within 14 days and only for unspent credits**, clawing back what was granted. | Consumer-law expectation in the EU (the product is priced in EUR), and the clawback code already exists. |
| Do purchased credits expire? | 365 days (`BILLING_CREDIT_EXPIRY_DAYS`), already implemented. | Unused liability must not be perpetual. Must be **shown** at purchase and in the passes list — the UI does not show an expiry date today. |
| What happens to credits on account deletion? | Forfeit, with the acknowledgement in D2. | Refunding a self-service deletion on demand turns deletion into a refund button. |

---

## 5. Structured gaps — one line each, with the recommendation

**Start order** (revised 2026-10-30 after the "cost history per workspace" correction):
`~~B16~~` → `~~B2~~` → `~~B12~~` → `~~D1~~`+`~~D2~~` → `~~B14~~` → `~~B8~~`+`~~B9~~` → `~~B4~~`.
The first three are the loop "see the workspace's spend, fund it, empty it"; `D1`/`D2` close
the account-deletion hole, where a purchased balance could be destroyed with no record and no
warning. `B3` is deliberately **not** in the list — composition covers it (see its row).
Every row of this phase is now shipped; the open items are the three "next" notes on `B4`
(seats, the workspace portal button, card-funded workspace credits).
`B17` is decided (**B**, deferred): do not touch a collection key before its two ownership
questions are answered in §1.1.

| # | Area | Gap | Recommendation | Size |
|---|---|---|---|---|
| B1 | org wallet | ~~client entitlements ignored the org wallet~~ | **shipped 2026-10-30** | — |
| B2 | org wallet | ~~no client for `POST /api/orgs/:id/credits/transfer`~~ — **shipped 2026-10-30**: `OrganizationService.fundOrganizationFromWallet` + a form under the wallet balance in the workspace tab, 7 keys × 5 locales, gated by the same roles as `orgRoleMaySpend` | next: return-balance-before-delete (B12) reuses the same method | — |
| B3 | org wallet | an org cannot be **funded by card** (`createCheckoutSession` has no `orgId`) | **DEFERRED — composition already covers it**: buy credits personally (existing checkout) then move them into the workspace (`B2`, shipped). Two clicks, zero new money paths. An org-owned Stripe customer is only genuinely needed for workspace *plans* (`B4`), where the org must be the payer of record — build it there, once, with the reverse index | — (was M) |
| B4 | plans | ~~workspace plans do not exist~~ — **shipped 2026-10-30**: `createCheckoutSession` takes `{orgId}` (owner-only, the `deleteOrganization` actor rule), mints a customer on `organizations/{orgId}.stripeCustomerId` with `metadata.orgId`, and carries that key through `subscription_data.metadata`; `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created/updated/deleted` and `checkout.session.completed` write to `orgs/{orgId}/billing/current` (already the payer wallet) and mirror scalars onto the org. Portal and resume accept `{orgId}`. Entitlements needed no change — `resolveOrgWallet` already prefers the org wallet. **No reverse index**: the org id rides the metadata Stripe already echoes back (see `stripeSubjectOrgId`) | next: count seats at renewal, surface the workspace portal button, allow card-funded workspace credits | — |
| B5 | pricing | org price-list override (roadmap 04 §4.3) | **drop it**; discount credits instead | — |
| B6 | meter | `capReached` acts on the next sweep (≤5 min) | accept; document the overspend window | — |
| B7 | meter | the "fallback to personal" is silent (roadmap 04 asked for a log) | **not a log line** — it fires on every request for every free workspace. Needs a throttled counter if it is ever wanted | S |
| B8 | refunds | ~~disputes do not freeze the wallet~~ — **shipped 2026-10-30**: `charge.dispute.created` sets `hold` on the billing document and `charge.dispute.closed` clears it, on any outcome. Read by `getBillingAccessMode`, which answers `free` for a held wallet *before* the plan test — one line, so every charging path (paid routes, browser meter, tool billing) stops at once while checkout keeps working, which is what a customer settling a chargeback needs. The 402 carries `code: "wallet_on_hold"` and the client interceptor no longer bounces that to the plans page | next: nothing; the event must be subscribed in Stripe or the case never fires (`docs/PAYMENTS_HINTS.md`) | — |
| B9 | refunds | ~~credit expiry is invisible in the UI~~ — **two gaps, not one**. Nothing ever WROTE an expiry: every grant carried `expiresAt: null`, so the 365-day sweep matched nothing and the documented policy was inert. Now purchased grants (and promotional, deliberately) carry `expiresAt = now + BILLING_CREDIT_EXPIRY_DAYS`, and `getMyEntitlements` returns `creditsExpireAt` — one single-field range query on the paying wallet's ledger, no composite index — which `/billing/passes` prints | next: the plans page can repeat it beside the pack price | — |
| B10 | deletion | purchased credits destroyed with no record (D1) | audit field at purge | S |
| B11 | deletion | no forfeit acknowledgement (D2) | one branch at scheduling | S |
| B12 | deletion | ~~org balance cannot be reclaimed before delete~~ — **shipped 2026-10-30**: `transferOrganizationCredits` takes a `direction` (`toOrg` / `fromOrg`), the route accepts `{direction}`, and the workspace tab has a Withdraw button for the owner. Deliberately one transaction, not a second function: the two directions differ only in which side is the source and the sign, and a second hand-written sign is how it gets written backwards | next: the delete confirmation can offer "withdraw, then delete" in one step | — |
| B13 | tools | `serp/scrape/search/extract/pdf/guide` charge **no credits** by design; the brake is the tier allowlist + rate limiter | keep, but it is a cost exposure: a free account can drive the shared pool. Revisit with a monthly free-call budget, not per-call credits | decision |
| B14 | config | ~~`STRIPE_PRICE_*` fall back to test-account ids~~ — **shipped 2026-10-30**: `configuredPriceId(env.STRIPE_PRICE_*, "<sandbox id>")` yields `undefined` in production, so all 11 catalog slots lose a missing env var instead of quietly substituting a test-mode price. No new refusal was needed: `createCheckoutSession` already throws without an id, the plans page already hides an unbuyable price, and the hourly `checkStripeCatalogHealth` already raises an incident reading `no price for the key and no fallback id` | next: nothing — the hourly check is the alarm | — |
| B15 | entitlements | `payerOrgId` is returned but nothing displays which wallet pays | show it once ("paid by workspace X") or delete the field | S |
| B16 | reporting | ~~`getBillingUsage` read `users/{uid}/credits_ledger` only~~ — **shipped 2026-10-30**: `{orgId}` resolved by `resolveOrgWallet`, ledger and balances read from the paying wallet, `payerOrgId` in `usage` (not rendered yet) | next: render it, or drop the field (B15) | — |
| B17 | data scope | operations, crawl packs, profiles, storage and machines are uid-scoped, so a workspace shares money and people but no objects | **B is the decided target, migration deferred** — see §1.1; new collections carry an `orgId` from day one | migration |

---

## 6. Acceptance criteria for the next slice

- [ ] A member of a workspace with purchased credits passes `paywallGuard` without a plan.
- [ ] Switching workspace re-reads entitlements; the previous workspace's balance never
      renders (pinned by the spec added in this phase).
- [ ] A non-member cannot make their own entitlements report somebody else's wallet
      (the org id is caller-supplied; `resolvePayerOrg` is the gate).
- [ ] Deleting an org that holds credits is refused with 409 unless the actor is a
      platform admin (already true — keep it pinned by a test).
- [ ] An account purge records the forfeited credit balance in `admin_audit`.
- [ ] Gates: functions `tsc`/`lint`/`test`, app `tsc` + `build` + Karma, bff `tsc`/`test`.

---

## 7. Deliberately not in this phase

- Nested organizations (roadmap 04 §4.5) — a second level makes every billing question
  recursive. Cap at 2 only when a customer asks.
- Per-org price lists, per-org tax registrations, reseller invoicing.
- Machines or blobs owned by a workspace: both are keyed by uid today, and the
  workspace buys a balance, not a fleet. If that changes it is a schema change on two
  collections, not a resolver change.
