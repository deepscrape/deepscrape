# ADR: browser sessions, live view, and worker leasing

Status: proposed. Date: 2026-10-01. Branch `next`.

Execution guide: `docs/roadmap/README.md` — numbered phases, acceptance criteria and gate commands.

Graphs consulted (all re-indexed 2026-10-01): `deepscrape` 20,033 nodes / 36,980 edges (full);
`webrain` 2,546 nodes / 5,951 edges (full); `arachnefly` 784 nodes / 1,521 edges.

## The question

Three things were asked together, and they are separable:

1. Is a **browser-session pooling backend** on Fly.io / AWS / GCP the right fix for the still-open
   `/api/extract` dead end?
2. Should users get an **end-to-end live browser** -- Neko-style WebRTC, or picture-to-picture frames?
3. How does that wire into the existing SaaS for `webrain` and `arachnefly` deploys, dedicated vs
   shared, for free and paid users?

**Answer: yes on the diagnosis, no on the first rung, and the word "pool" needs to change meaning.**

`/api/extract` is dead for a real reason: `webrain_extract` reads the **current page of a browser
session** and refuses `url`, while `webrain_session` is paid-only, so the shared pool answers
`502 -- Needs a private worker; the shared pool holds no sessions`. A session service genuinely
unblocks it. But a session service is not the thing to build first, and a *shared* pool would be a
regression rather than a feature.

## Verified state, per repository

Everything below is from the code, not from the earlier plan documents.

### `webrain` -- the pool is proxies, and there is no caller identity

- The pool whose symbols read like a browser pool (`pool_of`, `acquire`, `next_at`, `is_live_at`,
  `mark_dead_at`) is `ProxyPool`, `webrain-core/src/proxy.rs:35`:

  ```rust
  pub struct ProxyPool {
      proxies: Vec<String>,   // exit URLs: http://user:pass@host, socks5://...
      cursor: usize,
      dead: HashMap<String, Instant>,   // 120s cooldown
  }
  ```

  It rotates the **no-browser HTTP SERP path only** (`serp.rs::http_search_page`). Its own header
  comment says the browser path cannot rotate per request and that per-proxy isolation means "a pool
  of browsers handed to `webrain_batch` as `cdp_urls`". So:
- There is **no pre-warmed browser pool**. `webrain_batch` round-robins a **caller-supplied**
  `cdp_urls[]`; the caller must already own the browsers it names. Launched browsers live in a
  registry keyed `service:profile` (`store_launched` / `close_launch`), not a pool.
- **There is no caller identity at all.** The only auth is a process-wide shared secret
  (`WEBRAIN_HTTP_TOKEN`, `lib.rs:84`, and it defaults to *unset*, which means allow). Session routing
  takes the caller's `session_id` **verbatim** (`lib.rs:1236`) and `session(list)` enumerates every
  session together with its `cdp_url`. `WEBRAIN_NO_STATE` disables exactly three tools
  (`webrain_profiles`, `webrain_launch`, `webrain_login`) and is not an ownership check.
  The upstream document states the conclusion itself: *"Session-level isolation is therefore not a
  tenancy boundary ... arachnefly is."*

### `webrain` -- no streaming transport exists

- `TileEngine` (`engines.rs:17`) returns `Vec<TileShot>` where
  `TileShot { index, x, y, width, height, png_b64 }`, one `Page.captureScreenshot` clip per tile.
  `webrain_screenshot` returns `screenshot_b64` plus a file.
- A sweep for `webrtc|rtc|neko|vnc|mjpeg|sse` returns **zero**. The only WebSocket in the tree is the
  CDP *client* (`tokio-tungstenite`). The MCP HTTP transport is one-shot: request ->
  `Content-Length` response -> `Connection: close`. There is no chunked response, no SSE, and no
  WebSocket server -- so there is nothing to hang WebRTC signalling on.

  > **AMENDMENT, 2026-10-11 — this evidence is WRONG. The decision stands.**
  >
  > The sweep is true only of `webrain`'s own tree, and it was used to support a PLATFORM-scoped
  > conclusion. At platform scope it is falsified: `deepscrape` contains a complete **neko WebRTC
  > viewer** — `core/components/browser/browser.component.ts` plus the `clipboard` / `control` /
  > `resolution` components, `core/services/webrtc.service.ts` and `core/types/neko.*` — so the client
  > already holds a live WebSocket. "The only WebSocket in the tree is the CDP client" is therefore
  > false, and "there is nothing to hang WebRTC signalling on" does not follow from it.
  >
  > The **decision is unaffected**, but it is reached again from different evidence: the neko viewer is
  > **unreachable** — no route loads it and no template uses `app-browser` — because it pinned every
  > visit to a fixed external host this repo does not control, and it speaks the neko SERVER protocol,
  > which the platform does not run. It is a UI prototype, not a reusable client. The shipped live view
  > remains the PNG frame transport (`GET /api/browser/session/:id/frame`).
  >
  > The useful half survives intact and is the stronger argument: **webrain has no server-side
  > streaming transport** — no chunked response, no SSE, no WS server — so a real-time live view cannot
  > be built from webrain's side alone.
  >
  > Lesson, because this class of error repeats: a repo-scoped grep was cited for a platform-scoped
  > claim. State the SCOPE of a sweep beside the conclusion it supports.
- Remote CDP attach **is** supported and **is** unconstrained: `CdpBackend::connect_with_url` accepts
  `ws://`/`wss://` or issues a blind `GET {url}/json/version`, with no allowlist. Callers inject it via
  `session(op=open, cdp_url=...)`, `batch.cdp_urls[]`, or the `CDP_URL` env. Launched browsers bind
  loopback only; the attach side is not constrained. That is full CDP control of any browser the host
  can reach, and a blind GET SSRF.

### `arachnefly` -- no ownership check on any machine route

| Route | reads uid | compares owner | note |
|---|---|---|---|
| `POST /deploy` | yes | n/a | `clone&master_id` copies **any** machine's image + env |
| `POST /execute-task/:machine_id` | **no** | **no** | never reads a uid at all |
| `DELETE /machine/:id` | yes | **no** | Fly `DELETE` runs **before** the per-uid write |
| `PUT /machine/:id/start\|suspend\|stop` | yes | **no** | Fly call first, `UpdateMachine` after |
| `GET /machine/:id` | **no** | **no** | returns the machine and its resolved IP |
| `GET /machine/proxy/:id` | **no** | **no** | sets `X-Authenticated-User-Id: "userID"` (a literal) |

The per-user Firestore scoping is real (`users/{userID}/machines/{machineID}`) but it does **not**
gate the Fly action, and because `UpdateDocument` fails on a missing document, a cross-tenant call
performs the Fly operation and then answers `500` -- a false failure that masks the side effect. The
only registered validator is `hexadecimalan` (id *format*). **Conclusion: any authenticated user
holding a machine id can read, start, suspend, stop and delete another user's machine, run a crawl
task on it, and HTTP-proxy into its container.**

Machine shape: `POST /apps/{flyApp}/machines`; image chosen by a caller-supplied `imageOption`
(`default|clone|url|upload`) with **no registry allowlist**; caller `environmentVariables[]` copied
**verbatim**; `internal_port` = `PORT` else **11235**; Fly services expose 80 (force_https), 11235,
443, **and 6379 (Redis)**. `GET /machine/proxy/:id` proxies to
`http://{machine_id}.vm.{flyApp}.internal:11235`. Every deploy is a **new dedicated machine** -- there
is no shared or pooled mode today.

## Why the naive plan is wrong

**A shared browser pool is the one design that cannot be made safe here.** The isolation boundary is
the *machine*, and the machine is the only thing arachnefly can own. webrain cannot tell one caller
from another, so two tenants on one browser is the `session(list)` leak reintroduced on purpose --
cookies, logged-in sessions, and profile state all share a page. Pooling browsers without first
fixing identity would take an existing authorization hole and give it a UI.

**Neko/WebRTC is not the next rung.** It is a remote-desktop product: a media pipeline, continuous
encode, UDP/TURN for NAT traversal, and a signalling channel. webrain has *no* streaming transport, so
this is not "expose what exists" -- it is a new fleet with a new cost model, bought for a capability
(video-rate bidirectional interaction) that the scraping product has not asked for yet. What already
exists is the **screenshot path**, and picture-to-picture is a small extension of it.

**Provider choice is not the interesting axis.** The work is identity, leasing, and transport. Fly is
already integrated (`FlyRequest`, `BuildConfigMap`) and its machine API offers the exact primitive
needed -- per-machine `start`/`suspend`/`stop` with `auto_stop` and `min_machines_running` -- which is
"warm capacity" without a second vendor. Cloud Run cannot hold a long-lived stateful browser and has no
UDP; AWS would mean re-implementing the deployer. **Stay on Fly.** Revisit only if frames ever become
WebRTC, where TURN changes the calculus.

## Decisions

1. **Ownership before pooling.** Bind machine id -> owner uid inside arachnefly, compare *before* the
   Fly call, fail closed with 403. One choke point; the front door
   (`functions/src/handlers/machines.ts`) deliberately keeps relaying the caller's token and adding no
   second check.
2. **Lease, never share.** The unit is a **dedicated machine leased for one session**. Availability comes
   from warm *pre-created* machines (suspended, `min_machines_running` per tier), isolation from
   one-tenant-per-machine. "Pool" means "a pool of spares you lease exclusively from", not "a browser
   several users take turns on".
3. **Frames before video.** Phase 2 reuses `webrain_screenshot` / `TileEngine` and adds a transport.
   WebRTC/Neko goes to a separate ADR if and when interactive latency is a real requirement.
4. **A caller-supplied `cdp_url` is an SSRF primitive, not a parameter.** With 6379 exposed and
   `.vm.{app}.internal` reachable from a machine, an arbitrary CDP URL reaches the internal network.
   Allowlist it on the hosted path or drop it.
5. **Live view and interactive input are separate entitlements.** Watching is cheap and is a good paid
   hook; *typing into* a browser (input forwarding) is the expensive, dangerous part and stays gated.

## Architecture

```mermaid
flowchart TB
  subgraph client["Angular (zoneless)"]
    UI["browser session tab<br/>img refresh / SSE"]
  end

  subgraph bff["Bun + Elysia BFF (Cloud Run)"]
    SESS["/api/browser/*<br/>guard(jwt, perm, paid, credits)"]
    FRAME["/api/browser/:id/frame<br/>SSE or poll"]
  end

  subgraph fn["Firebase Functions"]
    DOM["browser-session.domain<br/>quota + lease state"]
  end

  subgraph go["arachnefly (Go, Fly.io)"]
    OWN["ownership guard<br/>PHASE 0"]
    DEP["POST /deploy<br/>PUT /machine/:id/start|suspend|stop"]
  end

  subgraph fly["Fly.io"]
    M1["machine (1 tenant)<br/>webrain + chrome"]
    M2["machine (1 tenant)<br/>webrain + chrome"]
  end

  UI --> SESS --> DOM
  UI --> FRAME --> SESS
  SESS -->|"lease"| DEP
  DEP --> OWN
  DEP --> M1
  DEP --> M2
  FRAME -->|"webrain_screenshot"| M1
```

Layering, and why:

- **Ownership lives in arachnefly**, not the front door. It is the only component that both knows the
  machine id and talks to Fly, and a check there covers every caller including future ones.
- **Leasing lives in `deepscrape`** (a `browser-session.domain`), because quota, tier and billing are
  already decided there. The domain is pure -- given (uid, tier, live sessions) return lease/refuse --
  so it is testable without a Fly token.
- **Frames go through the BFF**, not the browser, so the machine's `11235` port is never exposed to a
  client and a presigned-style short TTL applies, exactly like the storage `presign` route.

## Phases

**Phase 0 -- blockers. Nothing else ships first.**
- arachnefly: compare the stored owner uid against the caller's on every route that names a machine;
  move the Fly call *after* the check in `destroyMachine`/`start`/`suspend`/`stop`; return 403.
- arachnefly: fix `X-Authenticated-User-Id` (currently the literal `"userID"`).
- arachnefly: stop logging every started machine in `executeTask`.
- arachnefly: SSRF-guard `cdp_url`, or ignore it on the hosted path.

**Phase 1 -- session service (this is what unblocks `/api/extract`).**
- `browser-session.domain.ts`: pure lease decision -- max concurrent per tier, idle TTL, refuse reason.
- Routes: `POST /api/browser/session` (lease), `GET /api/browser/session` (list own), `POST
  /api/browser/session/:id/close`. Guarded like monitors (`access` + `perm`), metered like crawl
  credits per minute of browser time.
- Backed by arachnefly `POST /deploy` + `PUT /machine/:id/start`, auto-suspend on idle.
- `/api/extract` then has a session to read, so the tools-panel `note` explaining its 502 is deleted.

**Phase 2 -- live view (picture-to-picture).**
- BFF `GET /api/browser/:id/frame`: calls `webrain_screenshot` on the caller's own machine and returns
  an image (or an SSE stream of them). Short TTL, no client access to the machine.
- Angular: `BrowserSessionComponent` -- an `<img>` on a refresh loop plus a session chip. Reuse
  `result-envelope` for errors.
- Frame rate is a *cost* knob, not a UI knob: each frame is a CDP screenshot.

**Phase 3 -- interactive input (gated, paid only).**
- Forward click/type/scroll to `webrain_interact` on the caller's machine. This is the part that makes
  it "end to end"; it is also the part that can type a password into a stranger's page, so it is
  entitlement-gated and audit-logged.

**Phase 4 -- WebRTC/Neko.** Separate ADR, only on a demonstrated need. Not scheduled.

## Risks

- **Cross-tenant machine control today is a live hole**, not a future one. It is the only item here
  that is a security fix rather than a feature, and it is independent of everything else.
- Frame cost scales linearly with viewers x fps: 8 viewers at 10 fps is 80 CDP screenshots/second.
  Cap fps server-side; do not let the client choose it.
- A leased machine that is never released burns money. Idle TTL is required, not optional, and the
  lease must be released on the server even if the tab is closed.
- `webrain_extract` needs a session **and** a private worker. Phase 1 gives the first; the free tier
  still cannot use it, so the honest message stays until machines are per-tenant for every tier.

## Open questions

1. Is the live view a **paid** feature, a free acquisition hook, or absent? It is the strongest paid
   hook in the plan, but frames have a real marginal cost unlike the stateless tools.
2. Session unit: one machine per session, or one machine per **crawl-pack** (the existing project
   boundary) reused across sessions within it?
3. Who may type? Input forwarding is materially more dangerous than watching; does it need a second
   confirmation, or is `paid` enough?
4. Does the per-image contract (a deployed image listening on 11235) actually hold? Unverified in both
   repositories, and Phase 1 depends on it.
