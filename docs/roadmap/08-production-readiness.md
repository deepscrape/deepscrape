# Phase 3 — production readiness

**Goal:** a paying customer can lease a browser, watch it, drive it, and be billed correctly,
with no surface claiming more than the platform delivers.

Written 2026-10-10 from a measured audit of all four codebases. Nothing here is built unless
it says so. Ordered by what blocks a paying customer, not by what is interesting.

## What the audit measured

Run `bunx tsx scripts/route-parity.ts`. That harness is cited by the skill and **did not
exist**; it was rebuilt on 2026-10-10 (informational, not a gate).

| | |
|---|---|
| BFF routes | 56 |
| client roots | 18 |
| client calls with no route | **0** |
| routes with no client | **8** — all explained |

The eight: three `/api/job/*` paths are built by `crawlapi.service.ts` with
`replace('/crawl', '/job')`; `/api/search`, `/api/extract` and `/api/pdf` are reached as
`API_BASE_URL + path` with a variable; `/api/jobs/crawl/worker` and `/api/jobs/crawl/failed`
are webrain→platform callbacks that no browser calls.

**So the frontend↔BFF wiring is closed.** No orphan route, no client call to a route that no
longer exists. The remaining work is *product completeness*, not wiring — which is why the
rest of this document is short.

The first run of that harness reported 29 routes with no client, because it read only
`API_BASE_URL` and missed the `core/variables/` constants that *are* the paths —
`API_ARACHNEFLY_URL` is `/api/machines` despite its name, and `API_ORGANIZATIONS` is
`/api/orgs`. Corrected in the same file. Recorded rather than quietly dropped, because a
harness that cries wolf gets ignored.

## The three services, as measured

| Repo | Shape | Surface |
|---|---|---|
| arachnefly | Go/Fiber, 1039 nodes | **13 routes**: `deploy`, `execute-task`, `machine/:id`, `proxy/:id`, `waitforstate/:id`, `start`/`suspend`/`stop`, `DELETE`, `check-image`, `metricsgraph`, `user/:id`, `GET /` |
| webrain | Rust, crates `core`, `mcp`, `cli`, `vision` | MCP over HTTP, gated by `bearer_allows`; vault, vision index, and the three engines |
| deepscrape | Angular + Bun/Elysia BFF + Functions | 56 BFF routes, 18 client roots, 37 outbound HTTP call edges |

Two facts this **confirms rather than assumes**:

- **`POST /machine/mcp/:id` is absent from arachnefly's 13 routes.** The frame route cannot
  be built on anything present. The blocker is real, not a reading error.
- arachnefly's reaper (`infrastructure/reaper.Reap` + `domain.DecideReap`) carries its own
  tests (`TestReapSuspendsBeforeClosing`, `TestReapKeepsGoingWhenOneSessionFails`), so the
  lease backstop is not where the risk is.

## 3.0 Two decisions block a shipped feature — owner, not engineering

Everything else in the live-view chain exists. The frame component is built, `frameUrl()` is
built, the panel mounts it on demand. What is missing is a route that anyone can be
authorized to call, and one number.

1. ~~Authorize `POST /machine/mcp/:id` in arachnefly~~ — **BUILT 2026-10-10.** `HandleContainerMCP`
   sits beside the proxy route behind the SAME `MachineOwnershipMiddleware`, forwards to
   `http://<id>.vm.<app>.internal:11235/mcp` with the path **included in the address**, and returns
   the machine's reply **verbatim**. Gates: gofmt/build/vet/test all 0, every package ok; arachnefly is
   now **14 routes**. **One correction to the plan as first written here:** it said to copy
   `c.Response().Body()` into `Data`. That would have kept the bytes and lost the Content-Type, because
   `MakeAPICallback` calls `c.Type("json")` before it serialises — so a PNG would have arrived labelled
   `application/json`. The route is therefore registered **without** the wrapper and writes the
   response directly. It still bypasses `decideWebrainTool`'s tier allowlist, which remains defensible
   only because the machine is leased to exactly one tenant — I2 satisfied by the lease.
2. **The fps cap.** A.3's "paid 1–2 fps" is a range, and A.2 rule 2 requires one number
   because it is a billing control. Recommendation, unchanged: **paid 2, admin 4, free
   none** — the top of the stated range, as one named constant.

## 3.1 Delete the dead upload constant (verified 2026-10-10)

`API_ARACHNEFLY_UPLOAD_URL` (`core/variables/deployment.var.ts:26`) is dead three ways:

```ts
export const API_ARACHNEFLY_UPLOAD_URL = environment.production || environment.emulators
  ? '/upload/machines' : '/upload/machines'
```

Both branches are the **same string**, so the ternary reads as a decision and makes none. The
constant appears exactly once in the tree — an **unused import** in `deployment.service.ts:5`.
And no BFF route or Hosting rewrite matches `/upload/machines`, so it is not merely unused, it
is unreachable. Delete the constant and the import. Five minutes, zero risk.

## 3.2 `GET /api/pricing/estimate` — CLOSED 2026-10-11

Roadmap `07` Part F. The handler (`handlers/pricing.ts`), the domain function
(`estimateBillingCost`) and the client method (`PricingRatesService.estimate`) all already
existed, and the route was never registered — so `app-crawl`'s price line got a 404 on every
load and hid it, because that subscription fails silently by design. Registered now as
`guard([access, pricingEstimate])`; same shape as `/api/vision`.

Two things to carry forward:

- **`access` is required, not stylistic.** The handler reads `req.accessMode`, which only
  `resolveAccess` sets. Drop it and every caller is priced as `free`, so a paid account is
  told its next call costs nothing.
- **The route inventory in `bff/api.spec.ts` had no pricing route at all.** Both are in it
  now. A route absent from that list is a route nothing checks is registered.

The general failure — a client method whose route was never registered — is what the third
list in `scripts/route-parity.ts` now enumerates, with a printed denominator so a detector
that enumerates nothing cannot pass for a clean tree.

## 3.3 Profiles durability is a correctness bug, not a feature

`src/assets/i18n/en.json:401` advertises persistent stealth profiles. Three facts compound
against it: the vault is process-global; `BuildConfigMap` sets no `mounts`, so a session
machine has **no volume**; and Fly resets a stopped machine's root filesystem while the reaper
suspends idle machines on a 15-minute clock. So a profile cannot outlive one un-suspended
machine — a **published claim the platform cannot honour**. Do not build a profiles UI before
the vault can outlive a machine; that would only make the loss harder to see.

## 3.4 The two undeployed collection-group indexes

The `state` index (meter sweep) and the `idleDeadline` index (reaper) are declared and
**undeployed**. The emulator does not enforce indexes, so the runtime verification proves
query *semantics*, not index presence, and production can still answer
`FAILED_PRECONDITION`. The first live sweep is the real test. Deploy them before it runs
against paying customers.

## 3.5 Frontend surfaces still unbuilt

From the owner's list, the two remaining items:

- **Playgrounds** — `RUN_SURFACE_REQUIREMENTS` is the contract and already covers all seven
  modes. Note the trap: a mode id lives in **four** places (`PLAYGROUND_MODES`, the
  requirements record, the template `@if` arm, and the `ngOnInit` accept-list) and only the
  first three are compile-checked.
- **The rest of the UI** — not yet enumerated. Method, not guesswork: components with no
  importer escape `bun run build` entirely, so an unreferenced surface can be broken and
  green. Enumerate before building.

## 3.6 Deletion candidates

- `CRAWL_PROVIDERS` (`core/types/crawl.interface.ts:526`) — **verified dead 2026-10-10**;
  exported and never consumed.
- `crawlagent` — the LEGACY org. Do not push to it. `CheckOrCreateApp` hard-codes
  `org_slug: "softmind"` for production.
- The crawl4ai "browser pool" service the owner describes as a draft: keep the *contract* the
  backend and frontend already speak (`/api/crawl`, `/api/seeder`, `/api/job/*`), and do not
  take its internals as a design. `SCRAPE_PROVIDER` already chooses the engine server-side.

## Order

1. **3.0** — the two decisions (blocks a paying feature; only the owner can take them)
2. **3.1** — the deletion (five minutes, zero risk)
3. **3.3** — the correctness claim (we advertise what we cannot deliver)
4. **3.4** — the indexes, before the first live sweep
5. **3.2**, **3.5** — purchase-path and surface completeness
