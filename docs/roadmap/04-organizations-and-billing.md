# Phase 4 — organizations, BYO infrastructure, and their own costs

Depends on: Phase 0, Phase 1. Independent of Phases 2–3.

This is the **reseller / MSP** phase: a customer brings their own infrastructure, and their admins price
their own members.

---

## The insight that makes this cheap

What you described is the **third instance of one pattern this repository already ships twice**.

| Capability | BYO form | Status | Reference implementation |
|---|---|---|---|
| Object storage | their S3-compatible bucket | **shipped** | `s3-blob-store.ts` + `resolveBlobStore` |
| Browser | their CDP endpoint (`wss://`) | Phase 3, designed | `cdp_url` on their own machine |
| **Compute** | **their Fly organization + deploy token** | **this phase** | copy the storage one |

So this is not new architecture. It is the same five moves, applied a third time:

1. the credential goes to **Secret Manager** (`upsertSecretValue`), never Firestore;
2. Firestore holds only `{secretPath, …non-secret config}`;
3. a **resolver** picks platform-or-tenant — `resolveBlobStore(uid, scope)` becomes `resolveFlyTenant(uid)`;
4. **fail closed**: an incomplete tenant config refuses, it never silently falls back to the platform's;
5. the public projection has **no field a credential could occupy**.

If you find yourself inventing a different shape for Fly, stop and re-read `storage-settings.store.ts`.

---

## 4.0 BYO Fly organization

### What changes in arachnefly

Today there is **one** global Fly identity for every call:

- `flyApp` — package-level variable, `main.go:33`
- `flyApiUrl` — package-level variable, `main.go:34`
- `FLY_APP`, `FLY_API_TOKEN` — process env (`.env`, `fly.toml:14`, `Makefile:set-fly-api-token`)

So the change is: replace the two globals with a **resolved per-request tenant context**.

```go
type FlyTenant struct {
    App      string
    APIToken string
    Region   string
}
// resolveFlyTenant(uid) -> ours by default, theirs when configured
```

Every handler already receives the caller's uid (after Phase 0.1 it *must*). That uid is the input to the
resolver — exactly as `uid` is the input to `resolveBlobStore` today.

### Security, and it is the hard part here

A Fly token is far more dangerous than a bucket key. It creates and destroys machines.

1. **Ask for a deploy token, not an org token.** `fly tokens create deploy -a <app>` is app-scoped. A
   personal or org token lets a compromised platform destroy unrelated apps in their org. If the UI only
   accepts a deploy token, that is the whole mitigation — state the required scope, and reject anything
   else where you can detect it.
2. **Never fall back to our org.** A missing or revoked tenant token must refuse. Falling back would
   create *their* machines on *our* bill — the same class of bug `resolveBlobStore` refuses when it
   returns `null` instead of substituting the platform bucket.
3. **The blast-radius sentence belongs in the UI**, in plain words, before the field:
   *"This token can create and destroy machines in the app you name. It cannot reach other apps in your
   organization."*
4. **Rotation** uses the same purge discipline as BYOK storage: `upsertSecretValue` to rotate,
   `purgeSecretAndAllRevisions` to clear.
5. **Phase 0.1 matters more, not less.** You are now acting inside a third party's org, so a missing
   ownership check means one tenant could drive another tenant's machines *in their own account*.

### Resolved 2026-10-16 - not a discrepancy: the two claims are different HOPS

`FireAuthMiddleware` (`arachnefly/interfaces/controller/middleware.go:12-44`) calls
`firebaseAuth.VerifyIDToken(...)` and puts `decodedToken.UID` into `c.Locals("userID")`. So
`machines.ts` forwarding `req.authToken` is **correct**: arachnefly authenticates as the CALLER,
and the ownership guard depends on that uid being a real Firebase uid.

The ADR's server-held-secret claims are about a DIFFERENT hop -- the crawl4ai/webrain worker,
where a relayed end-user token is a verified **401** and `CRAWL4AI_API_KEY` is required. Both
documents are right about their own hop; reading them as one global claim was the error.

| Hop | Credential |
|---|---|
| browser -> BFF | the caller's Firebase ID token |
| BFF -> arachnefly | the caller's Firebase ID token (verified; yields the uid) |
| arachnefly -> machine MCP | the MACHINE's own `WEBRAIN_HTTP_TOKEN` |
| BFF/functions -> webrain engine | server-held `WEBRAIN_MCP_TOKEN` |

**This is what makes 4.0b possible.** arachnefly already resolves a per-request uid, so
`resolveFlyTenant(uid)` has an authoritative input. A server-held platform identity would have
made per-tenant resolution impossible.

---

## 4.1 What exists today (verified, not assumed)

| Thing | State |
|---|---|
| Org membership + roles | **exists** — `owner/admin/member/viewer`, `memberships/{userId}_{orgId}`, `ORGANIZATION_ROLE_INVITE_CAP` |
| Org routes | **exists** — `/orgs`, `/orgs/:orgId`, `/orgs/:orgId/members`, `/orgs/:orgId/invitations`, `/orgs/invitations/me` |
| Org-scoped URLs | **exists** — `host-routing.policy.ts`, `orgScopedUrl`, `CONSOLE_ORIGIN` |
| Authz org roles | **exists** — `resolveEffectiveRoles(subject, {orgId, ownerId})` at `authz.domain.ts:144`, so `canPerform` already understands an org role |
| **Org billing** | **does not exist** — every write is `users/{uid}/billing/current` (14 sites in `stripe.ts`, plus `syncaiapi.ts:185,225`). No `organizations/{orgId}/billing` anywhere. |
| **Org pricing** | **does not exist** — `resolveBillingPricingPolicy(method, path)` (`billing-pricing.domain.ts:119`) is global; one price list for everyone |
| Access modes | `"free" \| "credits" \| "plan" \| "grace"` (`billing.domain.ts:4`) |

The good news: the **authz seam is already there**. `data.orgId` flows into role resolution, so
"org admin may read org machines" is expressible today without touching the permission model. What is
missing is billing, pricing, and org-owned resources.

---

## 4.2 Org billing resolver

Billing is per-uid. Add an org document and a resolver that prefers it in an org context:

```
organizations/{orgId}/billing/current        // same BillingSnapshot shape
```

`resolveBillingSubject({uid, orgId?})` → `{billingPath, accessMode, priceList}`.

Rules to pin with tests:

- org context + org billing exists → **org billing wins**;
- org context + no org billing → fall back to the user's, and say so in the log (a silent fallback here is
  how a customer gets billed twice);
- no org context → user billing, unchanged.

Reuse `getBillingAccessMode` unchanged; it takes a snapshot, not a path.

## 4.3 Prices the org sets — "their own costs"

This is the actual ask. `resolveBillingPricingPolicy` gains an optional org parameter:

```ts
resolveBillingPricingPolicy(method, path, {orgPriceList?})
```

- **Platform default** when the org sets nothing — no behaviour change for existing customers.
- An org admin edits a price list on the org document: per-path credit costs, and platform fees.
- The **compute source** must be on the price, because the margin differs:

| `computeSource` | Who pays Fly | What we may charge |
|---|---|---|
| `platform` | us | compute + platform |
| `byo` | them | **platform only** — charging compute here is double-billing |

That single field is the difference between a correct invoice and a chargeback. Add it to the same commit
as the BYO Fly resolver, or they will drift.

## 4.4 Org credit pool + margin

- `organizations/{orgId}/credits` — we sell credits to the org; the org allocates to members.
- Member consumption debits the org pool; the org admin sees a **margin view**: consumption at *their*
  prices minus what they owe us.
- Reuse `reserveBillingCredits` / `consumeBillingCredits` / `releaseBillingCredits` with the org path and
  the same idempotency-key discipline (`<subject>:<method>:<path>:<bucket>`) the crawl path uses.
  **Double-crediting is the failure mode**; the idempotency key is the only thing preventing it.

## 4.5 Nested organizations (last, and only on demand)

`memberships/{userId}_{orgId}` is flat. Parenting needs a `parentId` plus a resolver that walks up.

**Cap the depth at 2.** Unbounded nesting makes every billing question recursive and every quota question
ambiguous, and I have not seen a customer need more than agency→client.

---

## Phases and order

| # | Work | Why this order |
|---|---|---|
| 4.0a | Resolve the token discrepancy above | blocks everything |
| 4.0b | `resolveFlyTenant` + deploy-token field + Secret Manager | the BYO premise |
| 4.0c | `computeSource` on the price | before any invoice is issued |
| 4.1 | Org billing doc + resolver | billing correctness |
| 4.2 | Org price list override | the "own costs" ask |
| 4.3 | Org credit pool + margin view | what makes it a reseller product |
| 4.4 | Nested orgs | only when asked |

## Acceptance criteria

- [ ] A BYO tenant with an incomplete config is **refused**, and no machine is created in our org
      (assert the Fly stub was never called with our token)
- [ ] A revoked/blank tenant token refuses; it never falls back to the platform identity
- [ ] No Fly token ever appears in a response shape — assert on the public type, as
      `StorageSettingsPublic` does
- [ ] `computeSource: "byo"` produces a bill with **zero** compute line and a platform line
- [ ] Org context with org billing present does **not** touch the user's billing document
- [ ] Org context with no org billing falls back and logs it
- [ ] Two identical consume calls debit once (idempotency)
- [ ] `resolveEffectiveRoles` org path has a spec proving an org admin reaches org resources and a member
      does not
- [ ] Gates: functions `tsc`/`lint`/`test`, bff `tsc`/`test`, app `tsc` + `build` + `ng test --watch=false`
