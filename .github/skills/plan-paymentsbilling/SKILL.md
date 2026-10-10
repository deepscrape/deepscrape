---
name: plan-paymentsbilling
description: plan-paymentsBilling
disable-model-invocation: true
---
## Plan: Billing and Entitlements (Implemented Baseline + Hardening)

This prompt is updated to the **current implementation state** in this repository. The system already runs a Firebase Functions-first Stripe integration with hybrid monetization (subscriptions + credit packs), Firestore user billing state, Angular billing UI orchestration, and layered paywall controls.

Use this plan to close gaps, remove legacy drift, and harden enforcement.

---

## Current State (as implemented)

### 1) Firebase Functions billing surface exists and is exported
- Implemented in [functions/src/app/stripe.ts](functions/src/app/stripe.ts) and exported in [functions/src/index.ts](functions/src/index.ts):
  - `newStripeCustomer`
  - `createPaymentIntent`
  - `createSetupIntent`
  - `startSubscription` (legacy flow)
  - `getBillingCatalog`
  - `validateStripeCatalog`
  - `getMyEntitlements`
  - `startTrial`
  - `createCheckoutSession`
  - `createBillingPortalSession`
  - `verifyCheckoutSession`
  - `stripeWebhook`
  - `updateUsage`
  - `grantPromotionalCredits`
  - `expireTrialsToFree`

### 2) Catalog and tiering exist (but server-hardcoded)
- `billingPlanCatalog` and `creditPackCatalog` are defined in [functions/src/app/stripe.ts](functions/src/app/stripe.ts).
- Active tiers: `free`, `trial`, `starter`, `pro`, `enterprise`.
- Intervals: `payAsYouGo`, `monthly`, `quarterly`, `annually`.
- Stripe price IDs are environment-backed but currently resolved in Functions code, not Firestore catalog docs.

### 3) Entitlement model exists in Firestore
- Canonical user entitlement snapshot stored at `users/{uid}/billing/current`.
- Includes: plan, status, subscriptionId, planInterval, grace/trial fields, credits, features.
- Credit ledger writes exist at `users/{uid}/credits_ledger` for checkout credits/promotional credits.

### 4) Webhook + idempotency already exists
- `stripeWebhook` validates Stripe signature and persists event markers in `stripe_events/{eventId}`.
- Duplicate events are skipped via `.create()` guard on event doc.
- Handles key lifecycle events (`checkout.session.completed`, invoice events, payment intent succeeded, subscription created/updated/deleted).

### 5) Angular billing orchestration is already live
- Main service: [src/app/core/services/billing.service.ts](src/app/core/services/billing.service.ts).
  - Loads catalog via `getBillingCatalog` callable.
  - Loads entitlements via callable + Firestore stream merge.
  - Opens checkout/portal, starts trial, verifies checkout session.
- Dynamic pricing UI implemented in [src/app/pages/user/billing/plans/plans.component.ts](src/app/pages/user/billing/plans/plans.component.ts) and [src/app/pages/user/billing/plans/plans.component.html](src/app/pages/user/billing/plans/plans.component.html).

### 6) Layered paywall already exists
- Route-level guard: [src/app/core/guards/paywall.guard.ts](src/app/core/guards/paywall.guard.ts).
- Guard applied on protected routes in [src/app/routes/user/main.route.ts](src/app/routes/user/main.route.ts) and [src/app/routes/user/billing.route.ts](src/app/routes/user/billing.route.ts) (`passes`).
- API-level redirect on 402: [src/app/core/interceptors/payment-required.interceptor.ts](src/app/core/interceptors/payment-required.interceptor.ts).
- Backend paid-access checks for API routes: [functions/src/infrastructure/syncaiapi.ts](functions/src/infrastructure/syncaiapi.ts).

---

## Gaps / Risks to Resolve

1. **Legacy flow drift still exists**
   - [src/app/core/components/payment/payment.component.ts](src/app/core/components/payment/payment.component.ts) still uses SetupIntent + `startSubscription` with hardcoded `price`.
   - This diverges from the newer Checkout Session flow used in billing pages.

2. **Catalog source-of-truth mismatch**
   - Current UI is dynamic via callable, but catalog data is still hardcoded in Functions, not Firestore docs.
   - Plan updates still require backend deploys.

3. **Enforcement is broad but not yet normalized everywhere**
   - API and some routes are guarded, but entitlement checks should be explicitly audited across all billing-sensitive callables/handlers and scraping entrypoints.

4. **Usage-to-credit lifecycle needs stronger accounting guarantees**
   - Alerting and usage metering exist, but explicit reserve/consume/release semantics are not uniformly enforced for all execution paths.

5. **Test coverage for billing contracts/webhook behavior is not yet explicit in repo-level workflow**
   - Needs dedicated callable contract tests + webhook idempotency and replay tests.

---

## Updated Implementation Plan

1. **Unify payment entrypoints and retire legacy drift**
   - Deprecate/contain old SetupIntent + direct subscription flow in [src/app/core/components/payment/payment.component.ts](src/app/core/components/payment/payment.component.ts).
   - Standardize on Checkout Session (`createCheckoutSession`) + success verification (`verifyCheckoutSession`) for plans and credit packs.
   - Keep backward compatibility for existing route `billing/paymentintent` until migration is complete.

2. **Centralize callable contract types shared by Angular + Functions**
   - Define explicit request/response DTOs for:
     - `getBillingCatalog`, `getMyEntitlements`
     - `createCheckoutSession`, `createBillingPortalSession`
     - `verifyCheckoutSession`, `startTrial`
   - Remove `any` payload drift from billing call sites.

3. **Move catalog content to Firestore (config-driven), keep Stripe IDs server-protected**
   - Introduce Firestore billing catalog docs for publish-safe plan metadata (labels, feature descriptions, display ordering, marketing copy).
   - Keep Stripe price mapping and validation server-side in Functions.
   - Add fallback to current in-code catalog during migration window.

4. **Harden webhook processing and reconciliation**
   - Preserve event-id idempotency and add replay-safe reconciliation pass for missed webhook scenarios.
   - Ensure metadata/customer-resolution paths are deterministic for every event type.
   - Verify no duplicate credit grants and no incorrect plan downgrades/upgrades.

5. **Strengthen entitlement + usage enforcement contract**
   - Audit all scrape-triggering and billing-sensitive APIs/callables for server-side checks (not just UI/route).
   - Standardize `402 payment_required` response schema across handlers.
   - Add explicit credit accounting semantics (reserve/consume/release) where long-running jobs are involved.

6. **Keep current pricing UX, continue dynamic rendering**
   - Preserve existing layout/interaction in plans pages.
   - Continue loading plan/pack options from billing service; replace only data source internals, not UX surface.

7. **Tier matrix alignment review (Crawl4AI capability mapping)**
   - Confirm tier feature keys in catalog (`features`) map cleanly to actual backend capability gates.
   - Document which gates are marketing-only vs enforced-in-code.

8. **Rollout strategy**
   - Phase A: contract typing + legacy flow convergence.
   - Phase B: Firestore catalog migration behind fallback.
   - Phase C: enforcement/accounting hardening + test suite.

---

## Verification Checklist

- Callable contract tests for all billing functions (auth, validation, happy/error paths).
- Webhook idempotency tests: duplicate event replay does not duplicate credits or state transitions.
- Manual flows:
  - start trial
  - plan checkout success/cancel
  - credit pack purchase
  - billing portal
  - subscription fail/recover
  - trial expiry scheduler
- Paywall tests:
  - route guard coverage (`crawlpack`, `operations`, `billing/passes`)
  - API 402 redirect interceptor behavior
  - backend `payment_required` responses on protected endpoints
- Build/test validation for Angular app + Firebase Functions.

---

## Decisions (updated)

- Monetization model: **Hybrid** (subscription + credit packs) — already implemented.
- Entitlement store: **Firestore** (`users/{uid}/billing/current` + ledger collections).
- Catalog delivery today: **Functions callable**; target state: **Firestore-driven config with Functions mapping**.
- Enforcement scope: **Route + action/UI + API/callable/server checks**.
- Public plan set: **Free, Trial, Starter, Pro, Enterprise**.
- Stripe toolchain note: use existing Firebase Functions + Stripe SDK integration pattern in this repo.
