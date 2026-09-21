# ADR 2026-09 — Search and indexing over the `easyscrape` database

Status: **Accepted** (decision taken while the requester was unavailable; revisit when a search
requirement actually exists).

## Context

The Firebase console shows the Algolia extension `algolia/firestore-algolia-search@1.3.0` installed
on `libnet-d76db`. It was asked to be re-pointed at the `easyscrape` database and extended to index
"any kind of collection we need to search".

## Findings

1. **The existing instance cannot be re-pointed.** In `extension.yaml` (v1.3.0) both relevant
   parameters are `immutable: true`:

   ```yaml
   - param: DATABASE_ID
     default: '(default)'
     immutable: true
   - param: COLLECTION_PATH
     immutable: true
   ```

   The trigger is `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${COLLECTION_PATH}/{documentID}`.
   Changing the database means uninstall + reinstall, and **one instance watches exactly one
   collection path** — N collections means N instances, N Algolia indexes and 2 functions each.

2. **The platform is being retired.** Extensions Hub states: *"Firebase Extensions will shut down
   on March 31, 2027. You will not be able to install or edit extensions after this date. We will
   share migration guidance and tools in September 2026."* Installing more instances now means
   building on something with a known expiry.

3. **Nothing consumes Algolia.** `algolia` matches nowhere in `src/` or `package.json` (only
   transitively in `package-lock.json`), and there is no search UI (no `searchQuery`, `onSearch`,
   `SearchService`, `performSearch`). The instance is console-managed — there is no `extensions`
   block in `firebase.json`, so it is neither reproducible nor reviewable from the repo.

4. **Firestore composite indexes are not search.** They serve filtered/sorted queries. Full-text
   search needs an external index fed by triggers. `firestore.indexes.json` already declares 38
   indexes for real query paths; adding speculative ones costs write amplification for nothing.

5. **The project has four databases:** `easyscrape` (nam5), `auth0` (nam5), `(default)` (eur3) and
   `supply` (eur3). Application data is in `easyscrape` — `firebase.json` pins it, the client asks
   for it explicitly, and the BFF/functions default to it.

## Decision

Search will be built on **Meilisearch, self-hosted on Fly.io**, fed from `easyscrape` by our own
Cloud Function triggers. This supersedes the "if search becomes a requirement" placeholder below.

The four findings above stand, so these parts of the original decision are kept:

- **Do not install or re-point Algolia extension instances.** The configuration surface is the
  wrong shape for "index many collections", and the platform has a shutdown date.
- **Do not add speculative Firestore indexes.** Add them when a specific query needs them.

## Index catalog

Two indexes to start. `deploy/meilisearch/setup.ts` is the executable form of this table.

| index | source | primary key | filterable |
|---|---|---|---|
| `crawlpack` | `users/{uid}/crawlpack` | `id` | `userId` |
| `operations` | `users/{uid}/operations` | `id` | `userId` |

Why these two: `crawlpack` is the product's core object, and `operations` already has a search
bar that filters only the loaded page client-side — that is the feature this makes real.

Firestore subcollections do not exist in Meilisearch, so the sync layer flattens the path and
writes an explicit `userId` on every document. Tenant isolation is a filter on that field, and
in production it must come from a **tenant token** issued server-side, never from a key shipped
to the browser. `filterableAttributes` has to contain every field a tenant filter uses.

Admin-scoped indexes (`users`, `audit_logs`, `apikeys`, `guests`) are deliberately absent: they
hold PII, so they need the admin-only key path before they are worth having.

## Scale and distribution — what the docs actually say (v1.53.2)

Three levels, in the order they should be reached for:

1. **Vertical — Community Edition (MIT), which is what Fly gives you.** During indexing the
   indexer takes at most 2/3 of RAM and half the CPU cores (`MEILI_MAX_INDEXING_MEMORY`,
   `MEILI_MAX_INDEXING_THREADS`), and the stated sizing rule is *"your machine should have
   enough RAM to hold the full dataset in memory during indexing"*. Exceeding it gets the
   process OOM-killed, which is the single most common self-hosting failure.
2. **Replication and sharding exist natively — but they are the only Enterprise-exclusive
   feature**, under a BUSL licence that *"cannot be freely used in production"*; self-hosting EE
   in production means contacting sales. The topology is a *network*: a `leader` coordinates
   writes and topology changes, non-leaders reject writes with `not_leader`, and any instance can
   serve searches (`useNetwork`, default `true`) which fan out and merge. Each shard is queried
   exactly once even when replicated, so replicas never duplicate results. Requires EE v1.37+
   and a master key on every instance; a master key is also a prerequisite for the network.
3. **Meilisearch Cloud** — their recommended path, with sharding/replication on Enterprise plans.

Hard limits that matter for `easyscrape` (from the "known limitations" page): 2 TiB recommended
index size (80 TiB ceiling), 20 GiB task database, 65,536 attributes per index, 4.29 billion
documents per index, primary key ≤511 bytes, a single `filterableAttributes` value ≤468 bytes,
1000 concurrent searches before 503 + `Retry-After`, 1000 results per search by default, and
**a maximum of 10 query words** — anything beyond the tenth is ignored.

Consequence: **one Fly machine with a volume is the correct starting point.** Do not design for
sharding; it costs a licence conversation. Reach for it only when a single index outgrows one
machine's RAM, and prefer splitting by index (for example per-tenant indexes) over paying for EE.

## Verified locally

`docker run -p 127.0.0.1:7700:7700 getmeili/meilisearch:latest` → **1.53.2**, then
`bun deploy/meilisearch/setup.ts` applied the catalog; re-running it is a no-op and exits 0.
Searching `"amazn"` (a deliberate typo) with `filter: userId = "user-a"` returned the sample
document, and the identical query as `user-b` returned **0 hits** — so typo tolerance is on by
default and the tenant filter isolates correctly.

### Sizing, measured rather than estimated

`deploy/meilisearch/bench-1m.ts` generates and indexes one million synthetic `operations`
documents (~500 bytes each: id, userId, status, url, a 180-character note, createdAt) inside a
container limited to **2 GB of RAM** with `MEILI_MAX_INDEXING_MEMORY=1200 Mb`:

| workload | index on disk | ingest | peak RAM | steady RAM | search |
|---|---|---|---|---|---|
| 1,000,000 docs @ 501 B | **486 MB** | 316 MB payload, 58 s to index (12,759 docs/s) | **661 MiB** | **377 MiB** | median 48 ms, p95 55 ms (filtered, limit 20) |

Typo tolerance still holds on the full index: `"produt"` returned hits filtered to a single user.
Peak was measured across a full re-index of all million documents, which a settings change
triggers; it stayed well inside the 1.2 GB indexing budget and the container was never OOM-killed.

**How many instances this needs: one.** 1M documents is 486 MB against a 2 TiB recommendation and
0.02% of the 4.29-billion-document limit, and it indexes and serves inside a 1 GB machine. Rules of
thumb from the measurement, to be re-checked as documents grow:

- Peak indexing RAM runs at roughly **1.4x the final index size**; steady-state RSS about **0.8x**.
  Size the machine above the peak, then set `MEILI_MAX_INDEXING_MEMORY` to leave the OS room.
- Disk and RAM scale close to linearly with document count, so 10M documents of this shape is
  ~5 GB on disk and wants ~8 GB of RAM, and 100M is where sharding starts to be a real
  conversation rather than a licence one.
- **Replication is a cost decision, not a capacity one.** Each replica is a full copy: same disk,
  same RAM, and the sync layer writes to every node. Two nodes for availability, more only for
  read throughput — and remember the 1000 concurrent search limit per instance.
- Sharding is **not** on the table at this scale.

Caveats: measured on Windows with Docker Desktop over loopback, so the 48 ms search figure
includes local HTTP overhead and is pessimistic; and the documents are synthetic, so real
`operations` shapes with large embedded crawl results will index larger and slower per document.

Not verified: an actual Firestore → Meilisearch sync, because it does not exist yet, and the
Fly.io deployment itself.

## Cost: Algolia vs Meilisearch Cloud vs self-hosted on Fly

Published prices, read 2026-09-21. **Verify before relying on them** — all three vendors change
these without notice, and the two Enterprise tiers are quote-only.

Algolia meters **searches** and **records** separately, and the two details that decide the bill
are buried in their FAQ: a search-as-you-type implementation "performs a new search request on
every keystroke", and **every pre-sort replica is a copy of the records and counts again**.

| | Algolia Grow / Grow+ | Meilisearch Cloud | Self-hosted (CE) on Fly |
|---|---|---|---|
| Free tier | 10K searches, 50K records | 14-day trial | Unlimited (MIT), you pay infra only |
| Entry price | Pay as you go, no contract | From **$20/mo**; ~**$30/mo** usage-based (100K docs + 50K searches) or **$23/mo** resource-based (0.5 vCPU / 1 GB) | **~$6.15/mo** (1 GB machine $5.70 + 3 GB volume $0.45) |
| Search overage | Grow **$0.50** / 1K, Grow+ **$1.75** / 1K | not published | n/a |
| Record overage | **$0.40** / 1K records/mo (both) | n/a | n/a |
| Replication | No SKU: implicit infra, but replicas multiply the record bill; 99.99% SLA needs Elevate (annual, quote) | **Enterprise only** | Free in CE by writing the same documents to N nodes yourself |
| Sharding | No SKU; index limits rise 20 (free) → 50 (Grow/Grow+) → 1000 (Elevate) | **Enterprise only** | Free in CE by splitting tenants across instances and merging results yourself |
| Index size cap | 1 GB free, 100 GB paid | 2 TiB recommended (80 TiB ceiling) | same as Cloud (it is the same engine) |

Worked comparison at 1M records and 1M searches/month: Algolia Grow+ is about **$2,090/mo**
(900K record overage ≈ $360, plus 990K searches ≈ $1,730); Algolia Grow keyword-only ≈ **$855/mo**;
Meilisearch Cloud resource-based is **tens of dollars** on an instance sized for it; self-hosted on
Fly with 8 GB of RAM is **$42.79/mo** (`shared-cpu-4x` 8 GB) plus a 3 GB volume at **$0.45/mo**,
and roughly **$12.30/mo** for two 1 GB replicas ($5.70 each plus volumes). The crossover is early:
Algolia's model is linear in usage, self-hosting is linear in RAM.

**The replication/sharding answer, since it drove this comparison:** Meilisearch's sharding and
replication are Enterprise in *both* managed and self-hosted form. Self-hosted EE is BUSL and,
by their own words, "cannot be freely used in production" — it needs a sales conversation. But the
Enterprise feature buys **coordination, not capability**: in the Community Edition you can get the
same outcomes by hand — replicate by writing each document to N independent instances behind a
load balancer (read scaling, N× RAM), and shard by splitting tenants across instances and
fanning out/merging queries in the BFF (this is what `useNetwork` does for you). You pay in
engineering and N× hardware instead of a licence, which at this project's scale is the better
trade. Revisit EE when coordination bugs cost more than the licence.

Fly.io specifics that matter: volumes are **$0.15/GB/mo**, snapshots $0.08/GB/mo (first 10 GB
free), egress NA↔EU $0.02/GB, and `shared-cpu` 1 GB is $5.70/mo while 8 GB is $42.79/mo. Support
plans are separate ($29/mo Standard, $199/mo Premium) and are not required.

## Consequences

- Search is no longer blocked on a missing requirement; it is blocked on the sync layer, which
  is the next piece of work: `onDocumentWritten` triggers with `database: "easyscrape"` that
  flatten each source path to the index above, reusing the `alert-fanout.ts` pattern.
- The misconfigured Algolia extension instance still runs until someone removes it from the
  console. It is referenced nowhere in this repository.
- No Firestore indexes were added for this. Search does not run on Firestore.

## Bug found while auditing this

Auditing which database the app actually talks to uncovered a live mismatch, fixed in the same
change: `app.config.ts` provided `getFirestore()` **without a database id**, so the injected
`Firestore` token resolved to `(default)`. Consumers of that token were:

- `NotificationBellComponent` — listened on `users/{uid}/alerts` and `billing_incidents` in
  `(default)`, while `alert-fanout.ts` writes alerts to `easyscrape` with
  `database: DATABASE_NAME`. The bell could never fire.
- `FirestoreAnalyticsService` — read `metrics_summary`, `metrics_daily`, `metrics_range` from
  `(default)` while the rollups are written to `easyscrape`. The admin dashboard read empty.

`functions/scripts/analytics-audit-cli.ts` already documents this failure mode: *"Defaulting to
`(default)` here is what produced the past FAILED_PRECONDITION incident."* The client-side service
was never given the same treatment. The provider now asks for `easyscrape`, which fixes every
consumer at once — including `paymentmethods` and `signup`, which inject the same token.
