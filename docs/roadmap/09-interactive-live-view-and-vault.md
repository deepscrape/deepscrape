# Phase 4 — interactive live view, and profiles that survive

**Goal:** a customer can watch and *drive* their leased browser, and can save a login once
and reuse it on any session they own.

Written 2026-10-10 after auditing all four services. Ordered by dependency, not by appeal.

## 4.0 The finding that reorganises this whole phase

**Frames and the vault are blocked on the SAME missing thing**, and it is not a frontend
gap. Both need a way for the platform to reach the MCP surface of **one machine the caller
owns**:

| Feature | Why it needs the per-machine join |
|---|---|
| Live frames | `webrain_observe(what="screenshot")` must run on *that* session's machine. |
| Vault profiles / logins | webrain's vault is **process-global**, so it is only safe on a machine leased to exactly one tenant. |

`POST /machine/mcp/:id` does not exist — confirmed against arachnefly's 13 routes, not
inferred. So **one route unblocks both features**, and any frontend work on either is
premature until it lands.

The shape is already determined from source (see `03` Part A):
- beside the existing proxy route, SAME `MachineOwnershipMiddleware`;
- forwards to `http://<id>.vm.<app>.internal:11235/mcp` with the path **included in `addr`**;
- reads `c.Response().Body()` into `Data` **before** returning, because `MakeAPICallback`
  overwrites the response with its envelope.

**It is an owner decision, not an implementation detail.** It lets the BFF drive arbitrary
MCP on a tenant machine, which bypasses `decideWebrainTool`'s tier allowlist. That is
defensible — I2 is satisfied by the lease rather than by the allowlist — but it is
authorization-adjacent in a service carrying live traffic, and this skill says stop and ask
for exactly that class of change.

## 4.1 Vault profiles and logins — do NOT build the UI yet

The ask is coherent: create a browser profile, save a login, then use that profile on any
session. Three independent things block it today, and only the third is a build:

1. **The backend refuses it.** `webrain_profiles` / `webrain_login` / `webrain_launch` /
   `webrain_session` are `VAULT_TOOLS`, refused for every non-admin tier by
   `needsCallerOwnWorker()` **before** a worker is acquired.
2. **The refusal is correct as things stand.** The vault is process-global and the pool
   REUSES a worker across tenants, so a profile written on a pooled worker outlives the lease
   that wrote it and is readable by whoever leases that worker next. A pooled lease is
   exclusive *for the call*; what persists is the *process*.
3. **The UI would therefore ship a lie.** This skill already states the rule: *do not build a
   profiles UI before the vault can outlive a machine — it would only make the loss harder to
   see.* The session machine has **no volume** (`BuildConfigMap` sets no `mounts`) and Fly
   resets a stopped machine's root filesystem, while the reaper suspends idle machines on a
   15-minute clock.

**So the order is: join → durability → UI.** A profile that cannot survive a suspend is a
worse product than no profile, because the customer only discovers it after trusting it.

**Durability is the second half, and the shape already exists.** Blob encrypted under a
per-tenant data key in the tenant's own bucket via `resolveBlobStore`, with the **key** —
never the blob — in Secret Manager. Secret Manager is the wrong home for the blob: thousands
of per-tenant cookie jars, every read billed and audited, size-capped. Neko's own sales
pitch for single-user "Persistent browser — own browser with persistent cookies available
anywhere" is the same requirement solved with a mounted volume, which is the alternative to
weigh.

## 4.2 Neko as a SECOND live-view transport — and it is not a rival to frames

Researched 2026-10-10 from the upstream repo. Facts, not recollection:

| | |
|---|---|
| Project | **`m1k1o/neko`** — 22.5k stars, **Apache-2.0**, active (v3.1.6 last week) |
| What it is | Go server + Vue client; streams a desktop inside a Docker container over **WebRTC** |
| Multi-tenant API | **`m1k1o/neko-rooms`** — provisions rooms over an API. This is the piece that makes it usable by a platform rather than by hand |
| Embedding | An explicit first-class use case: *"Embed anything — embed virtual browser in your web app"*, positioned as an open-source Hyperbeam alternative |
| Single-user | An explicit first-class use case: *"Personal workspace"*, *"Persistent browser"*, *"Throwaway browser"* |
| vs frames | *"Smooth video because it uses WebRTC and not images sent over WebSockets"* + audio + multi-participant control |

**Why it stays** (the owner is right, and `ADR-2026-10` was wrong to reason it away): the
existing stack already speaks its protocol. `webrtc.service.ts` and
`core/components/browser/browser.component.ts` are a working neko client with signalling,
control, clipboard and resolution components. Removing it would delete working code that
this phase needs.

**Why it cannot replace frames:**
- A frame is one PNG per poll. Neko is a **continuous media pipeline** — it encodes video
  for as long as the room is open. The platform's meter is **1 credit per started 5-minute
  block** and cannot express continuous video; a credit is ~€0.125–0.19 against a machine
  minute of $0.00013. Neko therefore belongs on a **separate, priced tier**, not on the
  existing per-minute meter.
- Neko needs STUN/TURN. That is new infrastructure, and at scale TURN is the cost.
- It is a different container (X server + browser + media), not webrain.

**I2 — the invariant that decides how it may be used.** Neko's headline feature is *multiple
people on one browser*. **We may not use it that way.** I2 makes exclusivity the safety
boundary, so the room must be **single-user and per-tenant**. The README lists single-user as
a supported mode, so this is a configuration choice rather than a fork — and it means the
"watch party" draw is precisely the feature this platform must refuse.

**Zero new frontend dependencies.** Do not vendor neko's Vue client. The Angular WebRTC
client already exists; wire it, do not re-platform it. The one real gap is that it currently
reads a global `environment.nekoUrl = wss://neko-rtc.fly.dev`, so it can only reach a fixed
external host — it needs a **per-session** endpoint, which is the same join again.

## 4.3 The ADR's premise is false and must be corrected

`ADR-2026-10-BROWSER-SESSIONS.md:64` states a sweep for
`webrtc|rtc|neko|vnc|mjpeg|sse` **returns zero** and that there is **no WebSocket server**,
concluding there is nothing to hang WebRTC signalling on. **Both halves are false:**

- `browser.component.ts` (`selector: 'app-browser'`, a neko WebRTC viewer) is **mounted on
  the dashboard** — `pages/user/dashboard/dashboard.component.html:9`. It ships on the home
  page and its spec asserts it.
- The frontend holds a live WebSocket to `wss://agent.deepscrape.dev/api/v1/ws/events`
  (`websocket.service.ts`), and `crawlagent` contains
  `crawlagent.monitoring.WebSocketManager.connect` plus `aiortc`.

The sweep must have been scoped to `functions/src/**` while the sentence claims the tree.
**The decision may still be right — frames are far cheaper — but it was justified with
evidence that is not true**, and a decision doc that misstates the tree will mislead the next
reader the same way.

## 4.4 crawlagent as the future session + live-view server (owner's direction)

`crawlagent` is the Python service (`API_CRAWL4AI_URL`, default `https://crawlagent.fly.dev`).
It is **not** just crawl4ai. Measured 2026-10-10: **74 routes**, deps `crawl4ai`, `fastapi`,
**`aiortc`**, `av`, `celery`, `apscheduler`, `firebase-admin`, `google-cloud-firestore`, and a
hotspot named **`crawlagent.monitoring.WebSocketManager.connect`**.

**That inventory means crawlagent already contains most of what a browser-session server
needs**, which is why the direction is to converge it with browser sessions and pooling rather
than stand up something new:

| Piece a session server needs | Already in crawlagent |
|---|---|
| WebSocket server for live status | `monitoring/WebSocketManager` |
| WebRTC media path | `aiortc` + `av`, `offer_stream`, `create_session`, `close_session`, `list_active_sessions` |
| Browser leasing | `/claim`, `/release/{browser_id}`, `/contexts/stats`, `/claim_context`, `/release_context/{context_id}` |
| Liveness and reclamation | `/janitor/stats`, `/janitor/force_cleanup/{container_id}`, `/displays`, `/display_metrics` |
| Crawl execution | `crawl4ai`, `event_stream`, `_crawl_stream_task_impl`, `_seeder_multi_research_task_impl` |
| Tenancy data | `firebase-admin`, `google-cloud-firestore` |

**The direction is sound and it has one hazard that decides the design.** A "pool" here is
legal one way only. crawlagent's `claim_context` / `release_context/{context_id}` model shares
**one browser process** and hands out **contexts**; contexts isolate cookies, but the process
is reachable by everyone in it. I2 says a browser reachable through a process anyone else can
reach is a cross-tenant leak **whatever the pooling arrangement is called** — so a context is
not the unit of isolation. The legal unit is **one worker per leased session**, released on
every exit path. Obscura's own guide reaches the same place from the other direction:
*"scale by adding nodes, not by allowing unlimited contexts"*, one worker per CPU core, with
sessions sticky to a worker.

So: **keep the transport, replace the broker.** The WebSocket and WebRTC paths are plumbing
worth keeping. The leasing model must become worker-per-tenant before any of it is promoted,
and the draft pool stays a draft — as instructed, and for the same reason Phase 0 existed.

**Where Obscura fits, and the one thing it solves that we have not.** `obscura.md`'s capacity
model is a template whose inputs are invented, so nothing should be sized from it — but it
names a real feature: **`--storage-dir` persistence, with sessions sticky to a worker.**
Profile durability is currently a published claim the platform cannot honour (§4.1), and it
fails for exactly one missing thing: **no volume**. `BuildConfigMap` sets no `mounts`, and Fly
resets a stopped machine's root filesystem. So there are two viable answers to §4.1, and they
share a prerequisite:

| Option | How a profile survives | Prerequisite |
|---|---|---|
| Platform-native | Blob in the tenant's bucket, key in Secret Manager | only §4.1's storage work |
| Engine-native | Engine `--storage-dir` on a mounted volume, session sticky to that machine | **a volume**, plus worker affinity |

The second is cheaper and is how Obscura and neko both already expect to work — but it makes
**session affinity mandatory**, because a profile written on machine A is invisible from
machine B. That is the same conclusion Obscura's doc reaches for its own storage, and it is a
real cost, not a footnote.

**What to improve now:** the WebSocket crawlagent already serves is the frontend's task-status
channel, and it sits **outside the BFF** — no platform guard, no entitlement and no metering is
in front of it. That is the gap worth closing first, and it is a BFF-side build (the BFF serves
no `/ws` at all today).

## 4.5 Traps and gaps carried forward

| # | Item | Status |
|---|---|---|
| 1 | `SCRAPE_PROVIDER` default is **`webrain`** while its comment promises crawl4ai | verified — comment is stale, and an unconfigured deploy now routes `/api/crawl` to webrain |
| 2 | `API_ARACHNEFLY_UPLOAD_URL` — identical ternary branches, unused import, no route or rewrite serves it | verified dead |
| 3 | `CRAWL_PROVIDERS` exported, never consumed | verified dead |
| 4 | Task websocket bypasses the BFF, on a legacy host | open |
| 5 | Neko viewer mounted on the dashboard against a fixed external host | open |
| 6 | Two collection-group indexes declared, undeployed | open |
| 7 | Graph is blind to templates — 75 `parse_partial` + 10 `parse_unusable`, all `.html`/`.scss` | known; use grep + `bun run build` there |

## 4.6 Order

1. **The join** (`POST /machine/mcp/:id`) — owner decision; unblocks frames *and* vault.
2. **Correct the ADR** and the `SCRAPE_PROVIDER` comment; delete the two dead constants.
3. **Frames end to end** — client is already built, so this is the BFF route + fps constant
   (recommended paid 2 / admin 4 / free none).
4. **Profile durability** (blob in the tenant bucket, key in Secret Manager), then the vault
   routes, **then** the UI. Neko's mounted-volume approach is the alternative to weigh here.
5. **Neko as an interactive tier** — per-session endpoint, single-user per tenant, priced
   separately; never the shared-room mode.
6. **Move the task websocket behind the BFF** so it inherits the platform's guards.
