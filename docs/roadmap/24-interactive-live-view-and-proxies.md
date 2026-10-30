# 24 — Interactive live view, frame encoding, and proxy identity

Status: **§1 applied 2026-10-29**, §2 and §3 still proposed. Written after the
question "why is the live view 1 fps, and can it be 30".

Three changes are bundled because they are one problem: a viewer cannot *drive* a
browser it sees once a second, and the reason is bandwidth, and the fix for
bandwidth is the same decision that decides what a proxy binds to.

| # | Change | Blocks | Services | State |
|---|---|---|---|---|
| 1 | Lossy frame encoding (WebP/JPEG) | everything below | functions only | **done** |
| 2 | Push transport (WebSocket) instead of poll | latency, fps ceiling | webrain, arachnefly, BFF, app | proposed |
| 3 | Proxy bound to an identity profile at session creation | product correctness | webrain, arachnefly, functions, app | proposed |

---

## 1. The measured bottleneck is frame SIZE, not frame rate — APPLIED

Facts, read from source rather than assumed:

- The live view is `GET /api/browser/session/:id/frame` →
  `observeMachineFrame` → `tools/call webrain_observe {what: "screenshot"}`.
- That call sent **no format and no quality**, and `OBSERVE_ARGS` in
  `handlers/webrain-tools.ts` had no such argument either, so every frame was a
  **PNG**.
- The route already said it: *"The frame's size is the one number that decides
  whether 1 fps is affordable: it is billed twice (machine→BFF, BFF→browser) at
  roughly $0.14/GB together"* — and warns above 200 kB.

The correction that made this cheap: `webrain_observe(what=screenshot)` **folds**
to `webrain_screenshot` (`map_surface`), and `webrain_screenshot` has read
`format` and `quality` all along — `screenshot_fmt(full, format, quality)`,
`png|jpeg|webp|avif`, mime mapping, `bytes` in the reply. Nothing had to change in
Rust. Two things blocked it: our allowlist, and our request body.

### What was changed

| file | change |
|---|---|
| `handlers/webrain-tools.ts` | `OBSERVE_ARGS` gains `format`, `quality` |
| `infrastructure/browser-session.provisioner.ts` | `OBSERVE_FRAME_BODY` asks for `webp` at quality 70 |
| `domain/browser-session.domain.ts` | `sniffImageType(bytes)` |
| `handlers/browser-sessions.ts` | the route types the response from the **bytes**, not from the reported mime |

The sniff is not paranoia. `BrowserBackend::screenshot_fmt` has a default
implementation that **ignores the requested format** and calls `screenshot()`, so a
backend with no lossy encoder answers with PNG while still reporting `image/webp` —
and a PNG served as `image/webp` is a black live view with a 200 in the log.

### 1a. Perceived latency, which the cap cannot fix while it is 1 fps — APPLIED

At one frame a second the picture is stale for most of a second after a click, and
a stale picture with no marker reads as "my click did nothing" — so the user clicks
again, and `runTool` drops the second click without a word. `browser-frame` now
carries an `awaitingFrame` state: set when an action is accepted, cleared by the
frame that shows its result, and cleared on failure so it never promises a frame
that is not coming. A click while one is already in flight is dropped at the source
rather than silently.

**Still to do, and it needs two measurements, not a guess:** raise
`SESSION_CAPS[tier].fps`. The cap is still 1 (paid) / 4 (admin).
- **Size** — the route warns above 200 kB; watch that stop firing at 1080p.
- **Round trip** — the route now also logs `in <ms>` when a capture takes over
  500 ms. A poll can never run faster than one capture, so `1000 / frameMs` is the
  real ceiling whatever the cap says; if that number is the smaller one, the answer
  is §2, not a bigger integer.

### Where `webp` is verified to exist, and what is not verified

- `screenshot_fmt` entered the tree in commit `805a429`, which *is* v0.12.1
  (`Cargo.toml version = "0.12.1"`), and `webrain_screenshot` reads `format` and
  `quality` from it.
- `deploy/browser-session/Dockerfile` builds `FROM ${WEBRAIN_IMAGE}`, so the
  engine inside a session machine is exactly that image — no second build path.
- **Not verified:** whether a *running* machine was created from the image that
  carries it. That depends on `BROWSER_MACHINE_IMAGE`, which is a secret and is not
  read here. If it points at an older tag, frames stay PNG and the only symptom is
  a frame that never got smaller — the sniff keeps them renderable either way.

---

## 2. Push transport (WebSocket) — for a *terminal-grade* interactive session

Polling cannot go much past a few fps no matter how small a frame is: each poll is
a whole request through four hops, and `interval()` schedules the next only after
the previous was issued, so latency stacks.

Target design:

```
webrain (Rust)                arachnefly (Go)             BFF (Elysia)         app
  CDP screencast ──ws──▶ /machine/proxy/:id ──ws──▶ /api/session/:id/stream ──ws──▶ <img>/canvas
  Page.startScreencast     hijack + relay           WS route, ticket auth      decode + paint
  ack every frame          ownership middleware      forward the caller token   input events back
```

Four contracts, each a place this can fail silently:

1. **webrain** — `Page.startScreencast` **does not exist in webrain at all**: a search
   for `screencast` across the whole Rust repo returns zero matches. Not a stub, not a
   disabled flag — the engine has no streaming capture path, only on-demand
   `Page.captureScreenshot`. This section is therefore new code in `cdp.rs`, not a
   wiring job. It must also emit `Page.screencastFrameAck`, or Chrome stops sending
   after the first frame; forgetting the ack looks exactly like "Chrome ignored us".
2. **arachnefly** — Fiber's reverse proxy must pass the upgrade, and **nothing in
   arachnefly handles one today**: a search for `Upgrade` / `Hijack` / `WebSocket`
   across the Go repo returns one Dockerfile hit and nothing else. It must keep
   `MachineOwnershipMiddleware`: today the ws path is an authenticated HTTP POST,
   and a socket that skips the ownership check is a cross-tenant live view of
   somebody else's screen.
3. **BFF** — Cloud Run supports WebSocket but the request budget is 60 minutes and
   the instance must not be killed mid-stream. A *ticket* (short-lived, single-use,
   minted by the existing authenticated frame route) authenticates the upgrade:
   a browser cannot send `Authorization` on a WebSocket, and putting the ID token
   in the query string writes it into every access log.
4. **app** — the input path must go back over the same socket. Today clicks are
   `POST /session/:id/tool` with an element index; at 30 fps a click must be
   optimistic against the newest painted frame, or the user clicks a picture of
   where the page *was*.

Keep the poll route. It is the fallback for a blocked upgrade, an older client and
the admin console, and it is the only thing that works through a corporate proxy
that strips `Upgrade`.

**Acceptance:** p50 frame-to-paint under 150 ms on a local machine; no change to
the poll route's behaviour; `frameTooSoon` still enforced per tier so a socket
cannot be opened to bypass the cap.

**Not worth doing until §1 ships.** A 30 fps PNG stream is ~30× today's egress.

---

## 3. Proxies belong to an identity profile, not to a request

This is the part the current model gets wrong, and it is worth stating plainly.

What exists today:

- A **platform pool** (`setWebrainProxies`, platform-admin only) and a **caller's own
  pool** (`users/{uid}/egress/settings`, edited in General settings).
- The caller's pool is applied **per crawl request**, resolved through
  `resolveEgress` before a worker is taken.
- Browser sessions deliberately refuse caller egress: *"Egress is platform-owned on
  every path"* (`handlers/browser-sessions.ts`), with specs asserting `proxy` is
  never forwarded on `webrain_tools` / `serp`.

That last rule is **right for stateless pooled calls** — otherwise a caller picks
the platform's exit IP and we eat the reputation cost. It is **wrong for a session
on the caller's own machine**, and every comparable product works the other way:

| | stateless crawl | interactive session |
|---|---|---|
| proxy chosen | per request, from a pool | **once, at session creation** |
| stickiness | rotation is fine | **sticky for the session's life** |
| boundary | request | identity profile |

Why sticky matters: a mid-session exit-IP change breaks cookie-bound logins,
re-triggers bot checks, and is itself a fraud signal. Round-robin across a pool is
what you do between *sessions*, never inside one.

### webrain already rotates — and that is the defect

`webrain-core/src/proxy.rs` holds a real pool: `ProxyPool::parse` (comma/newline
separated), `from_env` (one env var), `acquire()` (round-robin cursor), a `dead`
map with `mark_dead`, and a time-aware `next_at`. It is a **process-global
singleton** (`static POOL: OnceLock`).

So rotation is implemented and stickiness is not. `acquire()` hands out the next
proxy **per call**, which means two requests in one browser session can leave from
two different countries. For a crawl that is the feature; for an interactive login
it is the bug. Nothing records which proxy a session got, so nothing can pin it.

**Identity profile** — the tuple a session should be created from:

```
profile = { fingerprint (browser kind, viewport, UA override, locale, timezone),
            proxy (one entry from the caller's own pool),
            state (cookies/storage, i.e. a vault entry) }
```

The platform already stores two of the three: browser profiles
(`users/{uid}/browser/*`) and vault entries (`users/{uid}/vault/*`). The proxy is
the missing third, and it is missing because it never had a home — the pool is a
flat list with no identity attached.

### Smallest correct shape

1. The pool entry gains an `id` and an optional `label`. The wire shape is already
   a list of entries; this is additive.
2. `BrowserSessionCreateRequest` gains `egressId?: string`, validated against the
   caller's OWN pool — never the platform pool, and never a URL. A URL is a
   credential; an id is a reference the server resolves, exactly like
   `cdpSecretPath` is resolved today.
3. The session record stores `egressId` at creation and never re-resolves it (same
   rule as `computeSource` and `orgId`: a later read of the pool would describe a
   proxy the machine is not using).
4. webrain: the launcher **already** takes a proxy — `launch_chrome_opt(service,
   profile, port, headed, proxy, guest)` bakes `--proxy-server={p}` — but only the
   `guest` variant is given one (`launch_chrome_guest`), and the persistent-profile
   `launch_chrome` passes `None`. So the change is narrower than "Rust needs a
   proxy": bind the existing parameter on the persistent path and expose it on the
   MCP surface. A `webrain-core/src/proxy.rs` module also exists; read it before
   assuming what is missing.
5. arachnefly must pass a proxy **id** through to machine provisioning — it has no
   such field today.
6. The UI: one "identity" section in the session create form — profile, proxy,
   vault entry — replacing today's scattered controls.

**Do not** add a per-request proxy to `/api/scrape`, `/api/serp` or the session
tool route. The specs that refuse it are load-bearing.

---

## Order of work

1. §1 format + quality — the smallest change that makes the feature real.
2. Re-measure, then raise `SESSION_CAPS.fps` on evidence.
3. §3 egress id on the session record + webrain launch proxy (sticky identity).
4. §2 WebSocket, once frames are small and a profile can pin its exit.

## Out of scope

- A proxy **health/rotation** subsystem (latency probes, automatic failover). Only
  worth building once a proxy can be attached to a session at all.
- Per-org proxy pools. The pool is per-caller today; when an org pays for a
  session, the org is the natural owner, but that is a billing-model question, not
  a transport one.
