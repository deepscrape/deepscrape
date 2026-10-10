# Phase 8 — the runbook, the storage fixes, and one storage contract

Status: created 2026-10-10. Branch `next`. Companion to `12-production-harmony.md`.

This file answers three things the owner asked for in one pass:

- **A** — how to test and run every service, dev and prod, as commands.
- **B** — the six storage defects: verified, and what was fixed.
- **C** — the storage consolidation decision, and what remains (Phase 4).

---

## Part A — running everything

Prerequisites: Bun, Node 22 + npm 11, Python 3.11 + `uv`, Go, Rust ≥ 1.85, Docker, `firebase-tools`,
`gcloud`, `flyctl`, a JDK (Firestore emulator). `dotenvx` comes via `bunx`, not a global install.

### Command matrix

| Service | Dev | Test / gates | Production |
|---|---|---|---|
| **Angular app** (repo root) | `bun run start` — runs `prbuild:dev` (dotenvx + `.env.dev` → `environment.ts`) then `ng serve` | `bunx tsc --noEmit -p tsconfig.app.json` · `bun run build` · `bun run test:ci` | `bun run build` (production config) |
| **Firebase Functions** (`functions/`) | `npm run serve` — builds, then `firebase emulators:start --config ../firebase.dev.json` (functions, hosting ×3, pubsub, firestore, auth, storage, eventarc, tasks) | `npm run lint` · `npm run test` | `npm run deploy` |
| **BFF, Elysia** (`bff/`) | `bun run bff:dev` (root) = `bun --watch bff/server.ts` | `cd bff && bun run typecheck` · `bun run test:bff` | `cd bff && bun run deploy:cloud` (build → push → `gcloud run deploy`) |
| **BFF, containerised** | `cd bff && bun run docker:local` (port **8099** → 8080) | — | image pushed to Artifact Registry by `deploy:cloud` |
| **arachnefly** (Go) | `air` (`air.toml` → `go run main.go`) | `gofmt -l .` · `go build ./...` · `go vet ./...` · `go test ./...` | `flyctl deploy` (`fly.toml`) |
| **webrain** (Rust) | `cargo run --release --bin webrain mcp --http 9223` | `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace` | `flyctl deploy -c deploy/webrain-engine/fly.toml` (config lives in the **deepscrape** repo) |
| **webrain, container** | `docker build -f docker/Dockerfile -t webrain .` → `docker run -p 9223:9223 webrain mcp --http 9223` | — | `registry.fly.io/deepscrape-webrain:<tag>` |
| **crawlagent** (Python, frozen) | `uvicorn server:app --reload --port 8000` | `ruff check .` · `pytest` | `flyctl deploy` (`fly.toml`) / `docker compose up` |
| **The whole backend** | `npm run deploy:all` = build → functions → bff → hosting | — | plus `npm run deploy:indexes`, `npm run deploy:rules` |
| **Per-domain hosting** | — | — | `npm run deploy:hosting:marketing` · `:dashboard` · `:console` |

### Traps that cost time

- **`bun run test:ci` is the headless one.** `ng test` alone watches forever.
- **`bun run build` is the ONLY validator of Angular templates.** `tsc` never parses them and
  Karma compiles only what a spec imports.
- **`WEBRAIN_MCP_URL` has no default** — deliberate and correct, so a new provider cannot inherit
  "some host is assumed". **The token's two names are CONSOLIDATED (2026-10-10).** It used to be
  `WEBRAIN_MCP_TOKEN` in the BFF and `WEBRAIN_HTTP_TOKEN` on the engine — one value, two names, two
  stores, where a mismatch is a 401 on every call that presents as "search is broken". The platform
  now reads the **engine's** name first:
  `getConfigValue("WEBRAIN_HTTP_TOKEN") || getConfigValue("WEBRAIN_MCP_TOKEN")` in
  `functions/src/config/env.ts`, with the same precedence in `webrain-config.store.ts`'s direct
  `process.env` read (that site bypasses `env`, so it needed the change separately or a deployment
  setting only the engine name would authenticate in one place and be ignored in the other).
  One value, one name to rotate — the same precedence `AWS_*` gets over `TIGRIS_*` in the same file,
  for the same reason. The legacy alias is kept as a fallback so an existing deployment does not 401
  on the next release. Gates: functions TSC 0 / lint 0 errors / tests 0.
- **`BROWSER_MACHINE_IMAGE` must be a registry reference, never a local tag** — locally it stays
  empty and a dedicated session is refused, which is correct rather than broken.
- **Emulators:** `environment.emulators = true` in `environment.ts` gates the local Firestore/
  Functions wiring, and it is browser-only.
- **`run-server.sh` starts Xvfb and then exits.** Its final line —
  `# exec uvicorn server:app --host 0.0.0.0 --port 8000 …` — is **commented out**, so the script
  launches a virtual display and returns. Verify against the image's `CMD`/`supervisord.conf`
  before changing it; a blind uncomment could double-start the server.

---

## Part B — the six storage defects

Verified in source on 2026-10-10. Line numbers are from `crawlagent/storage.py` before the fix.

| # | Defect | Verdict | What was done |
|---|---|---|---|
| 1 | Object metadata lies about the payload — zstd bytes stamped `text/markdown`, no `ContentEncoding` | **real, and worse than reported** | **fixed.** Compressed objects now carry `ContentType: application/zstd` + `ContentEncoding: zstd`; uncompressed ones carry `text/markdown` and no encoding header. Both `put_object` and `create_multipart_upload` |
| 2 | `AWS_REGION` never read | **real** | **fixed.** `TIGRIS_REGION = os.getenv("AWS_REGION") or primary_config.get("region", "auto")`, matching the endpoint's own pattern |
| 3 | Credentials default to `None` → boto3's credential chain | **real** | **fixed.** `get_s3_client()` raises a named `RuntimeError` before creating a client instead of signing with whatever the chain found |
| 4 | Malformed rate-limit Redis URI + duplicate YAML keys | **real, and unread** | **fixed.** `storage_uri` deleted (nothing reads it, and it could never resolve), duplicate `ssl_*` keys collapsed |
| 5 | Credential names diverge between services | fixed on our side; **half-fixed here** | **completed.** `TIGRIS_ACCESS_KEY`/`TIGRIS_SECRET_KEY` now fall back to `TIGRIS_*` after `AWS_*`, so either name configures both services |
| 6 | Stale doc anchor (`env.ts:227`) | already fixed | nothing to do |

### Two additional defects found while verifying

- **Defect 1 has a second half the table missed: every small file failed to download.**
  Compression is conditional (`COMPRESSION_MIN_SIZE = 1024`), but `download_file_decompressed`
  zstd-decompressed **unconditionally** — so any object under 1 KB raised on read. The download path
  now branches on `ContentEncoding`, with a zstd magic-byte fallback for objects written before the
  metadata existed.
- **`@retry_on_failure` on `upload_compressed_file` is inert.** The function catches every exception
  and returns `None`, so nothing is ever raised for the decorator to retry. It reads as three
  attempts and is one. **Not changed** — making it raise would change the caller's contract, and
  that is a decision rather than a fix.

### The damage that made #1 matter

`get_presigned_url()` is a **browser-facing** path, and it signs the *stored* object. With
`ContentType: text/markdown` on zstd bytes, a client that opened the URL received binary labelled as
markdown — a silent wrong answer, in the same class as the Lightpanda placeholder screenshot the
skill warns about.

**Gates:** `python -m py_compile storage.py` → **0**; `yaml.safe_load('config.yml')` parses, with
`storage_uri` gone and the TLS keys at 4 instead of 8 duplicated lines.

---

## Part C — one storage contract

**The decision: the platform's storage module is the contract, and crawlagent conforms. Do not build
a third service.**

The ask was to consolidate every storage system into one service. The evidence says the
consolidation already happened *at the contract level*, and building a service would add a hop
without removing a dependency:

- **One credential, one name.** `functions/src/config/env.ts` reads `AWS_*` first and falls back to
  `TIGRIS_*`; after defect 5's fix, `crawlagent/storage.py` does the same. One secret, one rotation.
- **One endpoint, one region.** Both read `AWS_ENDPOINT_URL_S3` and `AWS_REGION` first.
- **One bucket.** A single private bucket reached only through short-lived presigned URLs — never the
  public asset CDN, which would outrank `domain/storage-scope.domain.ts` in bucket policy.
- **One client-facing surface.** `/api/storage/*` in `bff/api.ts`, resolved by `resolveBlobStore`
  (platform bucket or the tenant's own, via `s3-blob-store.ts`). crawlagent's blob routes are its
  own and stay internal.

So a "storage service" would be a third copy of an already-shared contract, reached over a network
hop, with the same three names to keep in step. **YAGNI.**

**What would change that:** a second consumer that cannot read S3, or a tenant-scoping rule the
bucket policy cannot express. Neither exists today.

### The migration order, if consolidation is ever wanted

1. Point `crawlagent` writes at the platform's prefix in the same bucket (no code change beyond a
   key prefix — the client is the same SDK).
2. Move reads behind `/api/storage/*` so the client has one surface.
3. Only then consider a service, and only if step 2 needs a transform the BFF cannot do.

**Do not reorder it.** Step 1 without step 2 leaves two writers and one reader.

---

## Part D — what must transfer out of crawlagent, and what must not

Audited 2026-10-10, frontend down. crawlagent is LEGACY ("do not push to it"), yet it is still a live
env default in two places **and** the host of the frontend's only live channel.

### The transfer table

| What crawlagent provides | Consumer today | Transfers to | Why |
|---|---|---|---|
| **Task-status websocket** (`/api/v1/ws/task/status`, `/ws/events`) | the Angular app, **directly** | **webrain, via the BFF — and the routes ALREADY EXIST** | the only remaining unguarded channel |
| crawl4ai HTTP crawl (`/crawl`) | `API_CRAWL4AI_URL` → the frozen `crawl4ai` provider | **stays, frozen** | a supported frozen provider is not a migration |
| Browser pool (`/contexts/*`, `/janitor/*`, `/displays`, `/display_metrics`, `/memory_stats`) | nothing in the platform | **nowhere — do not promote** | draft, and its shared-process model is exactly what I2 forbids |
| Its own blob/storage routes | crawlagent's own API | **stays internal** | Part C: one contract, no third service |
| celery / backup tasks | crawlagent itself | **stays** | not platform-facing |

### The one thing that must transfer is a FRONTEND change

`src/app/core/services/websocket.service.ts` dials
`wss://agent.deepscrape.dev/api/v1/ws/task/status` with the Firebase ID token **in the query string**.
It is the only surface in the platform that bypasses the BFF.

**The transfer target is already built.** `bff/api.ts` already serves four guarded routes for exactly
this data:

| Route | Handler | Gate |
|---|---|---|
| `GET /api/job/stream/status/:taskId` | `webrainJobs.getTaskStatus` | `paid` + `perm('crawl','execute')` |
| `GET /api/crawl/stream/job/status/:taskId` | `webrainJobs.getTaskStatus` | same |
| `GET /api/job/stream/:taskId` | `webrainJobs.streamTaskResults` | same |
| `GET /api/crawl/stream/job/:taskId` | `webrainJobs.streamTaskResults` | same |

So this is **not "build a `/ws` on the BFF"**. The capability already exists over HTTP streaming; the
work is **repoint the client at the routes that already serve the same data, then delete the direct
socket**. That also retires the query-string token exposure, because a BFF call carries the token in
the normal `Authorization` header.

**Correction to §10 of `12-service-orchestration-and-layer-inventory.md`:** that section ranked "the
BFF serves no `/ws`, so it is a build not a redirect" as 🔴. That is wrong. It is a *client* change
against existing routes. The 🔴 belongs to the **direct external dependency** — no guard, no
entitlement, no metering, against a legacy service — and that is unchanged.

**Before repointing:** confirm the content type of `webrainJobs.streamTaskResults`, since a browser
cannot consume a JSON envelope the way the socket consumed per-task frames. If it is a single-result
stream rather than a multiplexed status feed, poll `getTaskStatus` per task id instead — that is
still a client change, not a new route.

**Order matters: repoint first, delete the socket second.** Deleting first loses task progress with
no replacement, and it does so **silently** — the Operations rows simply stop updating.


---

## Part D — what remains

Unchanged from `12-production-harmony.md` §6, with Phase 4 now the only feature block:

| # | Item | Kind |
|---|---|---|
| 1 | Profiles durability claim (`en.json:401`) | correctness |
| 2 | Deploy the two collection-group indexes | deployment |
| 3 | Correct the ADR evidence (`ADR-2026-10-BROWSER-SESSIONS.md:64`) | doc |
| 4 | Owner sign-off: fleet lifecycle actions, session reclaim | decision |
| 5 | `GET /api/pricing/estimate` | feature, small |
| 6 | `TransactionsComponent` — wire or delete | product decision |
| 7 | **Phase 4 — BYO Fly org + `computeSource`** | **feature** |

**Phase 4 is one pattern three times, and storage is the reference implementation.** A customer can
bring their own bucket, their own browser, and their own compute; each is the same five moves — the
credential goes to Secret Manager, Firestore holds only `{secretPath, …non-secret config}`, a
resolver picks platform-or-tenant (`resolveBlobStore` → `resolveFlyTenant`), it **fails closed**, and
the public shape has **no field a credential could occupy**.

The one thing that must not split: **`computeSource` (`platform` \| `byo`) has to land in the same
commit as `resolveFlyTenant`.** A BYO organization pays Fly directly, so charging platform compute on
top of that double-bills them; a `computeSource` added later means the two drift while both report
success. Per the skill's pricing rules the field belongs on the price, next to `machines.deploy`, and
`meterWalletFor` already derives BYO from `machineId` absence — so the resolver and the meter must
agree about which one is authoritative.

---

## Not verified

- crawlagent was **not run**. `py_compile` proves syntax and no more; the repository was already
  exercised only as "a draft pool, not a production dependency", and no S3/AWS call was made.
- The rate-limiter fix removes a value nothing read. If some deployment *was* reading
  `rate_limiting.storage_uri` out-of-tree, it now needs a TCP URI in the `redis:` block.
- No other service was built or gated in this pass. Their last green runs are in the skill.
