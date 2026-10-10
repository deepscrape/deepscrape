# Browser platform roadmap — index

Status: living document. Created 2026-10-01. Branch `next`.

This is the execution guide for the dedicated/shared browser platform: backend services, deployment,
admin surfaces, organizations with their own pricing, and the UI. It captures what was **verified**
rather than assumed, so you do not have to re-derive it.

Read in order. Each phase file has numbered steps, the files each step touches, and acceptance criteria
you can actually check.

| File | Phase | Blocks |
|---|---|---|
| `01-security-blockers.md` | Phase 0 | everything else |
| `02-machine-leasing.md` | Phase 1 + 3 | `/api/extract`, live view |
| `03-live-view-and-ui.md` | Phase 2 | paid upsell |
| `04-organizations-and-billing.md` | Phase 4 | BYO infrastructure + reseller pricing |
| `05-deployment-and-admin.md` | cross-cutting | shipping any of it |
| `06-browser-sourcing-options.md` | **decide first** | which sourcing model to build |
| `07-pricing-and-budgets.md` | Phase 5 — pricing | the customer wallet, free allowances, acquisition |
| `08-production-readiness.md` | Phase 3 | what remains before a paying customer can lease, watch and drive a browser |
| `09-interactive-live-view-and-vault.md` | Phase 4 | the interactive live view, and why the vault needs a volume |
| `10-refactor-priorities.md` | cross-cutting | Tier 0–4 ranking of what to refactor, cheapest first |
| `11-frontend-wiring-and-ui.md` | Phase 6 | the master list, **measured** — mostly already built; two orphaned surfaces closed |
| `12-production-harmony.md` | Phase 7 | what exists across all four repos, the service harmony contract, the WebRTC decision, and what is genuinely left |
| `13-runbook-and-storage-contract.md` | Phase 8 | dev/prod commands per service, the six storage defects fixed, and the one storage contract |
| `12-service-orchestration-and-layer-inventory.md` | Phase 7 | **the answer sheet**: what exists in all four layers, which service owns what, and the four design pieces still missing |

Companion decision record: `docs/ADR-2026-10-BROWSER-SESSIONS.md`.

---

## Master sequence — do these in order

Each step names the file carrying the detail. Do not start a step until its predecessors are green.

| # | Step | File | Why now |
|---|---|---|---|
| 1 | **Decide the sourcing model** — shared / exclusive pool / dedicated / BYO | `06` | every later step depends on it, and one combination is unusable |
| 2 | **arachnefly ownership** — compare owner uid *before* the Fly call, 403 / 404 | `01` §0.1 | a live cross-tenant hole; blocks all machine work |
| 3 | **Worker token + `NO_STATE`** — set via the Machines **Secrets** API | `01` §0.2 | an untokened worker behind a public host is an open MCP endpoint |
| 4 | **Fly service config** — drop public 6379, keep 11235 private | `01` §0.3 | one-line infra fix, removes a pivot |
| 5 | **`cdp_url` allowlist** | `01` §0.4 | BYO CDP is unsafe on a shared worker without it |
| 6 | **Bake all three browsers** — Chrome in-image, Lightpanda/Obscura pre-warmed | `06` | otherwise the first request pays the download |
| 7 | **Lease domain + store** — pure `decideLease`, Firestore sessions, CDP URL in Secret Manager | `02` §1.1–1.2 | the decision layer, testable with no Fly token |
| 8 | **Lease routes** — `bff/api.ts` only | `02` §1.3 | the `syncaiapi.ts` table is not mounted; no twin exists to update |
| 9 | **Reaper + metering** — reaper is an arachnefly `cron.AddFunc`, **not** `onSchedule`; plus the `resolveBillingPricingPolicy` row | `02` §1.5–1.6 | a scheduled function cannot authenticate as the machine's owner |
| 10 | **BYO CDP** — allowlisted hosts, credential in Secret Manager | `02` §1.7 | cheapest tier; Lightpanda Cloud is verified real |
| 11 | **Frames** — BFF endpoint, server-capped fps, **Chrome only** | `03` Part A | what makes "live view" real |
| 12 | **UI** — session panel, frame component, playground mode, 5 locales | `03` Part B | read the UI skills first |
| 13 | **Admin** — fleet view (**built 2026-10-03**, read-only), tenant config, rotate + purge | `05` Part D | route **and** nav entry, same commit |
| 14 | **BYO Fly org + org billing/pricing** — `resolveFlyTenant`, `computeSource` | `04` | turns it into a reseller product |
| 15 | **Customer spend cap** — checked *before* reserving, and it **fails closed** (**built 2026-10-04**, end to end incl. the UI) | `07` Part C | the "wallet priority" ask; the highest-risk line in pricing |
| 16 | **Duration metering** for browser minutes + `computeSource` on the price | `07` Part E | per-path pricing cannot price a minute, and BYO must not be double-billed |
| 17 | **Free daily allowance** — a daily window, HTTP tools only | `07` Part D | the funnel; browser time is never free |
| 18 | **Generate the pricing page from the policy table** (**built 2026-10-03**) | `07` Part G | a hand-written page drifts from the code |

**Steps 2–5 are security fixes and are independent of everything else. Ship them before any feature.**

**One rule that must not be copied from the rate limiter:** the existing fixed-window budgets *"fail open
when Redis is unavailable"* — correct for a rate limit, **wrong for a spend cap**. A spend cap that fails
open turns a cache blip into an unbounded invoice. It must fail closed.

---

## Phase 3 — production readiness

Steps 1–18 above are the browser-platform sequence. **Phase 3 is what remains before a paying customer
can lease, watch and drive a browser**, and it lives in
[`08-production-readiness.md`](./08-production-readiness.md) — written 2026-10-10 from a measured audit
of all four repos.

Two headline measurements, because they change what work is actually left:

- **The frontend↔BFF wiring is CLOSED.** 56 BFF routes, 18 client roots, **0** client calls with no
  route, and the 8 routes that appear client-less are each explained (3 computed paths, 3
  variable-passed paths, 2 webrain→platform callbacks). Measure with
  `bunx tsx scripts/route-parity.ts`. So what remains is **product completeness, not wiring** — which
  is why Phase 3 is short.
- **`POST /machine/mcp/:id` is confirmed absent from arachnefly's 13 routes.** Step 11's frame route
  cannot be built on anything present; adding it bypasses the webrain tier allowlist, so it is an
  owner decision rather than an implementation detail.

Order: the two owner decisions → a verified dead constant to delete → the profiles correctness claim →
the two undeployed collection-group indexes → the purchase path and the remaining surfaces.

---

## Phase 6 — frontend wiring and the remaining UI surfaces

[`11-frontend-wiring-and-ui.md`](./11-frontend-wiring-and-ui.md). Written 2026-10-10 from a
measured audit of the **master list** (operations, playgrounds, browsers, jobs, machines,
proxies, "the rest").

**The headline is that most of the list was already built**, so this phase is short. What it found
were not missing features but missing wires — two surfaces that existed in code and could not be
reached from the product:

- `<app-ai-keys>` was referenced **nowhere** outside its own file, so the BYOK surface had no
  mount point at all. A customer could not store a key from anywhere.
- The `scrape` half of `getMySettings` — and `setMyScrapeProvider` — had **no consumer**, while
  `scrapeMiddleware` already honoured the stored value on `POST /api/crawl`. A preference that
  decides which backend serves a crawl was unreachable, and `FALLBACK_PROVIDER` governed every
  account silently. All five locales already carried `SCRAPE_PROVIDER.*`.

Both are closed: the engine rows and the vendor rows now render in one component, mounted in
`settings/general`, because the server composes them into a single `getMySettings` call on purpose
— asking twice would let one half render against a plan the other had already been refused under.

**The reusable lesson is the measurement, not the fix.** A component can have a spec, a service, a
template and five locales of translations and still be unreachable; grep for the **selector**
across `src/app/**` is what finds it, and no other step in the toolchain does. The same orphan had
also never been compile-checked, because `tsc` ignores templates, Karma compiles only what a spec
imports, and the build skips what nothing references.

---

## Phase 7 — production harmony

[`12-production-harmony.md`](./12-production-harmony.md). Written 2026-10-10 from an audit of
**all four repositories** (deepscrape, arachnefly, webrain, crawlagent) plus the BFF and the
Functions layer.

**The headline: there is very little left to build.** The wiring is closed — 57 BFF routes,
18 client roots, **0** client calls with no route, **128** components and **0** orphans by
class reference. So this is a completeness phase, and what remains is a claim to honour
(the profiles copy), two undeployed indexes, one small pricing route, and three decisions —
plus Phase 4, which is the only remaining *feature* block.

It also settles the two questions that were left implicit and are worth not re-deriving:

- **What each service decides** — a table whose value is its *Never* column. Most future drift
  will be a change landing in the wrong repo.
- **The WebRTC question** — the neko viewer is unreachable and pinned to a host this repo does
  not control. The shipped live view is the **frame** transport
  (`GET /api/browser/session/:id/frame` → arachnefly `POST /machine/mcp/:id` →
  `webrain_observe(what="screenshot")`). The neko components are kept as the prototype for
  roadmap `09` and are **not** wired; delete them the day `09` picks a transport.

Dead surfaces found and removed: `CRAWL_PROVIDERS`, `API_ARACHNEFLY_UPLOAD_URL`,
`FirestoreCacheService`, the Pluto payments service, and `pages/landpage/`. Kept on purpose:
`TransactionsComponent` (a product decision) and the neko cluster.

---

## Bring your own infrastructure — one pattern, three times

A customer can bring their own bucket, their own browser, and their own compute. It is the **same five
moves** every time, and the storage implementation is the reference:

| Capability | BYO form | Status |
|---|---|---|
| Object storage | their S3-compatible bucket | **shipped** — `s3-blob-store.ts` + `resolveBlobStore` |
| Browser | their CDP endpoint (`wss://`) | Phase 3, designed — `cdp_url` |
| **Compute** | **their Fly organization + deploy token** | Phase 4 — copy the storage shape |

1. the credential goes to **Secret Manager**, never Firestore
2. Firestore holds only `{secretPath, …non-secret config}`
3. a **resolver** picks platform-or-tenant (`resolveBlobStore` → `resolveFlyTenant`)
4. **fail closed** — never silently fall back to ours
5. the public shape has **no field a credential could occupy**

If you find yourself inventing a different shape for Fly, stop and re-read `storage-settings.store.ts`.

With BYO compute the customer **pays Fly directly**, so we charge the platform layer only. A
`computeSource` field on the price (`platform` | `byo`) is what stops that becoming a double-charge —
and it must land in the same commit as the tenant resolver, or the two will drift.

---

## The one-page answer

**Do not build a browser pool.** Two facts remove the need:

1. **The free tier needs no browser at all.** Of the six shared tools, `guide` is static text, `serp` and
   `scrape` are HTTP paths, and `extract` / `pdf` already cannot work on a shared pool (`extract` needs a
   browser session, `pdf` needs a worker-side file). Only `extract` wants a browser, and it is refused.
   So there is nothing to share.
2. **Where webrain runs and where the browser runs are different questions.** webrain accepts any
   `cdp_url`, so a user can bring their own browser — Lightpanda Cloud, Browserbase, Steel, Browserless,
   or their own Chrome — and we run no browser for them at all.

So the shape is: **HTTP-only free tier → dedicated leased machine for paid → BYO CDP as the cheap
paid variant → pooling only if ever bought, never built.**

**Start here:** Phase 0 (a live cross-tenant hole), then Phase 1 (which is ~80% already built).

---

## Verified current state (2026-10-01)

| Repo | Graph | Language | Gate | Status |
|---|---|---|---|---|
| `deepscrape` | 20,033 nodes / 36,980 edges | Angular 20 + Bun/Elysia + TS functions | see below | 435 functions tests, 70 bff, 660 app |
| `webrain` | 2,546 nodes / 5,951 edges | Rust | `cargo fmt` / `clippy -D warnings` / `cargo test` — **74 tests** | green |
| `arachnefly` | 784 nodes / 1,521 edges | Go (Fiber) | `go test ./...` — **not verified this session** | no ownership check |

### Gate commands (exact, verified)

```bash
# functions
cd functions && bun x tsc --noEmit && bun run lint && bun run test

# bff
cd bff && bun x tsc --noEmit && bun test

# angular app — `bun run build` is the ONLY template validator
bun x tsc --noEmit -p tsconfig.app.json
bun run build
bun x ng test --watch=false     # `ng test` alone watches forever

# webrain
cd D:/Windows/Documents/Programming/Projects/Rust/webrain
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

### Execution traps that have cost real time

- **`cmd | Select-String; $LASTEXITCODE` reports `Select-String`'s exit code, not the command's.** Print
  `"VAR=$LASTEXITCODE"` on its own line immediately after the command, before any pipe.
- **`get_errors` / editor diagnostics are not evidence.** They reported "No errors found" on files that
  could not compile. Gate structural edits with `tsc --noEmit`, and templates with `bun run build`.
- **`bun run build` can exit 127 on Google Fonts inlining** when offline. That is network, not code;
  `ng build --configuration=development` still validates templates.
- **One edit per file per tool block.** Batching same-file edits has silently corrupted files twice.

---

## The decisions (do not re-litigate without new evidence)

1. **Ownership before pooling.** arachnefly has no owner check on any of its machine routes; a
   cross-tenant `DELETE` performs the Fly call *before* the per-uid write and then answers 500, masking
   the side effect.
2. **Lease a dedicated machine; never share one.** webrain has no caller identity — one process-wide
   shared secret, caller-supplied `session_id`, and `session(list)` enumerating every tenant's browser
   *and its `cdp_url`*. Upstream's own doc: *"Session-level isolation is therefore not a tenancy
   boundary."*
3. **Frames before WebRTC.** There is **no streaming transport in webrain** — a sweep for
   `webrtc|rtc|neko|vnc|mjpeg|sse` returns zero, the only WebSocket is the CDP *client*, and the MCP
   transport is one-shot (`Connection: close`). Neko is a media fleet, not a small extension.
4. **A caller-supplied `cdp_url` is an SSRF primitive.** It reaches a blind `GET {url}/json/version` with
   no allowlist, and a machine can reach `.vm.{app}.internal` and 6379.
5. **Warm capacity is nearly free; running capacity is not.** Fly charges stopped machines only for
   rootfs: **~$0.15/month per GB**. Started `shared-cpu-1x/1GB` is ~$5.70/month. So 100 suspended
   dedicated machines ≈ $15–30/month — which is what makes "lease, don't pool" both safe *and* cheap.

---

## Fly.io machine limits — the honest answer

**Fly publishes no per-org machine cap.** Its pricing page says only:

> *"Organizations may be subject to automated scaling limits to prevent abuse or to help with capacity
> planning. Email the address in the error message if you run into such a limit."*

Undisclosed, surfaced as a runtime error. You cannot engineer against a number, so **enforce your own
cap** in the domain layer and treat Fly's limit as headroom you may lose.

Published rates (before regional markup, `iad` baseline) that drive the design:

| Item | Price |
|---|---|
| Stopped machine, per GB rootfs / 30 days | $0.15 |
| Started `shared-cpu-1x` 512 MB | ~$3.20/month |
| Started `shared-cpu-1x` 1 GB | ~$5.70/month |
| Started `shared-cpu-2x` 2 GB | ~$11.39/month |
| Egress | $0.02/GB NA-EU · $0.04 APAC/OC/SA · **$0.12** AF/IN |
| Volume | $0.15/GB/month |
| Static egress IP | $0.005/hour (~$3.60/month) |
| Reservation blocks | **40% off** committed compute |

---

## Do not build (recorded so it is not proposed again)

- **A browser pool.** Sharing a browser across tenants reintroduces the `session(list)` leak deliberately.
  If pooling is ever needed, buy it (Browserbase / Steel / Browserless / Lightpanda Cloud).
- **WebRTC / Neko.** No transport exists to build on; it is a media-server fleet with UDP/TURN for a
  capability not yet demanded.
- **A second control plane for machines.** arachnefly already deploys, starts, suspends and stops Fly
  machines and is already proxied by the BFF with `guard([...])`. Extend it.
- **A KV/relational store for leases.** Firestore matches the existing model and needs no new
  infrastructure. The reaper is not an exception: it runs in arachnefly's existing in-process cron
  (`02` §1.5), because a scheduled function cannot present a user identity to the machine routes.
- **Any new secret manager.** `upsertSecretValue` / `purgeSecretAndAllRevisions` / `getSecretFromManager`
  already exist and are used by BYOK, BYOB storage and the webrain config.
