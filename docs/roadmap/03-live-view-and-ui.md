# Phase 2 — live view, and the UI plan

Depends on: Phase 0, Phase 1.

---

# Part A — the frame transport (backend)

## A.1 Why frames, not WebRTC

There is **no streaming transport in webrain to build on.** A sweep for `webrtc|rtc|neko|vnc|mjpeg|sse`
returns zero; the only WebSocket in the tree is the CDP *client*; and the MCP HTTP transport is one-shot
(request → `Content-Length` response → `Connection: close`), so there is no signalling path and no chunked
response. WebRTC would be a media fleet with UDP/TURN and continuous encode — a different product.

What **does** exist: `webrain_observe(what="screenshot")` → base64 PNG, and `webrain_batch(op="screenshot")`
for many URLs in parallel tabs. **Corrected 2026-10-04 — the earlier text named a tool that does not
exist.** It said `webrain_screenshot`; the binary's own tool list (the `AGENT_GUIDE` constant in
`webrain-mcp/src/tools.rs`, which enumerates 17 tools) contains **no such tool**. A screenshot is a `what`
on `webrain_observe`, in the same list as `state|a11y|semantic|html|images|console|flatten|fit|clean|
pixel|page_info|annotate|media`. `TileEngine` is real but is a *different* thing: it is the tile engine
behind `webrain_vision` (`op: index|retrieve`), a screenshot-tile vision index, not the frame path. So the
frame primitive is an **MCP tool call against a specific machine**, which is what makes this a route and
not a passthrough.

**A consequence for A.2's `image/webp`: it should be `image/png`.** The tool returns PNG, so serving webp
means putting an image codec into the Functions runtime — a new dependency bought for a content-type. Serve
the decoded `b64` as `image/png`; revisit only if a measured egress bill says otherwise.

## A.2 The endpoint

```
GET /api/browser/session/:id/frame        -> image/webp   (Cache-Control: no-store)
GET /api/browser/session/:id/frame?stream=1 -> text/event-stream   (optional, server-paced)
```

Rules that are not negotiable:

1. **Frames go through the BFF.** The client never learns the machine's address and never reaches port
   11235 — the same discipline as the storage `presign` route, where the client never constructs a bucket
   URL.
2. **The frame rate is a server-side cap, not a query parameter.** Each frame is a CDP screenshot. A
   client-chosen `fps` is a client-chosen bill.
3. **Owner-scoped.** A foreign session id answers 404 before any capture happens.
4. **`no-store`.** A cached frame of someone's logged-in page is exactly the leak Phase 0 closes.
5. **Never rasterise on the browser side.** No client-side canvas capture; the pixels come from the
   worker.

### BLOCKER, verified in source 2026-10-03 — the proxy cannot carry the token

`GET /api/machine/proxy/:id` is the path `06` names for the paid tier, and as written it **cannot**
deliver a frame. `HandleContainerProxyFiber` (arachnefly, `interfaces/handlers/fireAuth.go`, ~1090)
deletes the header before forwarding:

```go
c.Request().Header.Del("Authorization")
callerID, _ := c.Locals("userID").(string)
c.Request().Header.Set("X-Authenticated-User-Id", callerID)
```

and `deploy/browser-session/nginx.conf` answers **401** when that header is absent
(`if ($http_authorization = "") { return 401; }`). Relaxing nginx would *not* fix it: webrain enforces
`WEBRAIN_HTTP_TOKEN` itself one hop behind, and that is the real check — nginx's rule is presence only,
which its own comment says not to read as authentication.

So the token has to be re-established on the forwarding hop. That is a decision, not an implementation
detail:

| Option | Shape | Cost |
|---|---|---|
| arachnefly injects the token | reuse the Fly app secret every machine in the app already receives, so the proxy works for any path | changes authorization behaviour in a live service — **ask first** (skill rule) |
| BFF-held token, direct call | needs 6PN reach to `<machine>.vm.<app>.internal` | **not possible from Cloud Run** — ruled out |
| per-machine secret | strongest isolation; each machine holds its own token | a secret per session, plus somewhere to keep it |

### RESOLVED 2026-10-04 — the per-machine token ALREADY EXISTS

The third option reads as if it needs new machinery. It does not. **A per-machine
`WEBRAIN_HTTP_TOKEN` is already stored**, in that machine document's own `config.env` — which is
exactly why `machine.store` and the admin fleet view project seven scalar fields instead of returning
`doc.data()` (the skill's rule: *never return `doc.data()`; `config.env` holds
`WEBRAIN_HTTP_TOKEN`*). The "secret per session" option 3 asks for is already provisioned, on the
machine, in a field arachnefly already owns.

So the cheapest correct shape is a blend of options 1 and 3, and it needs no new secret store:

**arachnefly re-attaches the machine's OWN token, read from that machine's config document.**

- **Per-machine isolation** (option 3's property) instead of one app-wide secret (option 1's
  weakness).
- **No new secret store** and no session-scoped secret lifecycle to reap.
- The header it puts back is the one `HandleContainerProxyFiber` deliberately strips, so this reads
  as "restore what this hop removed" rather than a new authorization decision.
- It works for **any** path behind the proxy, which makes it the frame route, the vault/profile
  tools, and driving a session at all. **One change, three unblocked features.**

The owner check is untouched: `MachineOwnershipMiddleware` still runs first, so a token can only
ever be re-attached for a machine the caller owns.

**SHIPPED 2026-10-04, with the owner's sign-off.** `HandleContainerProxyFiber` now re-attaches the
machine's own `WEBRAIN_HTTP_TOKEN`, read from `machine["config"]["env"]` on the `GetMachineDetails`
response that handler **already fetched** — so it costs **no Firestore document read and no Fly API
request**. That matters more than it sounds: the Machines API allows one request per second per APP,
shared with Create Machine, so a read here would have competed with deploys. An absent token logs a WARN
rather than failing silently: the request still goes out and the machine refuses it with a 401, so without
that line the symptom is an unexplained refusal with nothing to correlate it to. Gates: arachnefly
`gofmt` clean, `go build ./...` 0, `go vet ./...` 0, `go test ./interfaces/handlers/...` ok.

**The blocker in the table above is therefore CLOSED.** What remains for this Part is the BFF route in
A.2 — not the transport.

**Implementation note for A.2, verified in source 2026-10-04 — the file is not what its name suggests.**
`functions/src/handlers/machines.ts` is NOT a handler table. It is the **arachnefly client**: a
`MachinesHandler` class exporting a singleton `arachnefly`, whose methods (`executeTask`, …) take
Express `(req, res, next)`. Its `executeTask` is the exact template the missing proxy method should copy:

- validate the id against `validIdPattern` **before** any network call;
- take `req.authToken` (the caller's Firebase ID token, set by BFF middleware) and send it as
  `Authorization: Bearer ${token}`;
- `fetch` the arachnefly route, then `res.writeHead(200, …)` with an explicit `Content-Length` — note its
  comment that a failure to bound the body is how a proxy becomes an open pipe;
- **never echo the upstream error body** — it carries internal service names and validation rules.

**The session→machine join stays server-side, and that is forced rather than tidy.** `machineId` is
deliberately absent from `BrowserSessionPublic`, so the frame route must resolve the session, take
`machineId` from the **record**, and call the proxy with that. The client never learns the machine's
address and never reaches port 11235 — A.2 rule 1, the same discipline as the storage `presign` route.

**Two open questions before A.2 can be written, and neither is an implementation detail:**

1. **What actually produces a frame on the machine?** The adapter's nginx serves `/` (health) and `/mcp`
   (webrain MCP); `03`'s own A.1 says the primitives are `TileEngine` → `Vec<TileShot{png_b64}>` and
   `webrain_screenshot` → `screenshot_b64`. So a frame is an **MCP tool call**, not a GET — and the
   response is base64 PNG inside JSON-RPC, while A.2 specifies `image/webp`. That conversion needs an
   image library in the Functions runtime, which is a dependency decision.
2. **A.3 says paid is "1–2" fps.** That range is not a cap. The cap is a server-side billing control
   (A.2 rule 2: "a client-chosen `fps` is a client-chosen bill"), so it has to resolve to one number per
   tier before the route is written.

**Two documents are stale on this.** `docs/ADR-2026-10-BROWSER-SESSIONS.md:83` and
`01-security-blockers.md:31` still say `X-Authenticated-User-Id` is set to the literal `"userID"`. It is
not — it carries the caller's real uid, and the source comment says why (*"a literal here is useless to
the target service, which cannot otherwise identify the caller"*). The `log.Printf` calls in the same
function still interpolate the literal string, which is cosmetic only. This is why the ADR claims are not
evidence: the code moved and the prose did not.

## A.3 Cost reality

Frames are linear in viewers × fps: **8 viewers at 10 fps is 80 CDP screenshots/second.** So:

| Tier | fps cap |
|---|---|
| free | none (no sessions) |
| paid | 1–2 |
| admin | 4 |

If you later want smooth video, that is the WebRTC ADR — and it should be justified by a user asking for
it, not by the UI looking better.

## A.4 Acceptance

- [ ] A cross-uid frame request returns 404 and the capture stub is never called
- [ ] The response carries `Cache-Control: no-store`
- [ ] Requesting 60 fps yields the server cap, not 60
- [ ] The machine's `11235` never appears in any response body or header

---

# Part B — the UI plan

> **STATUS 2026-10-03: panel BUILT; `browser-frame` is the only component left.**
>
> Built: `src/app/core/types/browser-session.interface.ts`, `core/services/browser-session.service.ts` (the
> one writer of `/api/browser/session*`), `core/components/browser-session/browser-session-chip.component.*`
> (8 specs) and `browser-session-panel.component.*` (17 specs), hosted by
> `pages/user/browser/browser-session.component.*` at route `browser`. Gates: app TSC 0, production build 0,
> panel spec 17/17 SUCCESS, full suite 685/685 SUCCESS, i18n parity 33 keys in each of the five locales, full suite 685/685 SUCCESS.
>
> **The playground `browser` mode is BUILT (2026-10-03).** `B.1` called adding a mode "one line plus an `@if`
> arm with a real component". It is more than one line, because the mode must be registered in
> `PLAYGROUND_MODES` **and** in `RUN_SURFACE_REQUIREMENTS`, which is a `Record<PlaygroundModeId, ...>`. That
> is the guard working: omitting the gate entry is a compile error, so an ungated mode is unreachable by
> accident. `paid: false` is correct for it.
>
> **A `paywallGuard` in front of the browser routes was a BUG, now fixed.** `bff/api.ts` registers all four
> session routes with `access` + `perm('crawl','execute')` and **never** `requirePaidAccess`, and
> `browser-sessions.ts` says why in its own header: a 402 would refuse a free caller before the domain could
> answer from its tier table, and free is not "not entitled" here. The handler contains no 402 at all. The
> route now uses `authzGuard` alone, mirroring the backend.
>
> Consequence worth knowing: the panel's `402 -> ERROR_PLAN` branch is currently **unreachable**, and its
> English copy ("Free plans use the shared worker, which holds no sessions") describes a policy the backend
> does not implement. That copy is wrong and is left in place only because it is dead. Reword it, or move it
> to the `extract` surface, which is where `B.5` actually asks for it.
>
> **The playground `browser` mode is BUILT (2026-10-03).** `B.1` said adding a mode is one line plus an
> `@if` arm with a real component; it is more than one line, because the mode has to be registered in
> `PLAYGROUND_MODES` **and** in `RUN_SURFACE_REQUIREMENTS`, which is a `Record<PlaygroundModeId, ...>`. That
> is the guard working: omitting the gate entry is a compile error, so an ungated mode is not reachable by
> accident. `paid: false` is correct for it.
>
> **A `paywallGuard` in front of the browser routes was a BUG, now fixed.** `bff/api.ts` registers all four
> session routes with `access` + `perm('crawl','execute')` and **never** `requirePaidAccess`, and
> `browser-sessions.ts` states why in its own header: a 402 would refuse a free caller before the domain
> could answer from its tier table, and "free is not 'not entitled'" here. The handler contains no 402 at all.
> The route therefore uses `authzGuard` alone, mirroring the backend. Consequence: the panel's `402 ->
> ERROR_PLAN` branch is currently **unreachable**, and its English copy ("Free plans use the shared worker,
> which holds no sessions") describes a policy the backend does not implement. That copy is WRONG and is
> left in place only because it is dead; reword it or move it to the `extract` surface, which is where
> `B.5` actually asks for it.
>
> **PATH CORRECTION to `B.1` below.** It says `/user/browser`. There is no `user` segment in the route tree:
> `user.route.ts` mounts `admin`, `:orgId` and `''`, and `appPageRoutes` in `user/main.route.ts` is shared by
> the bare and the org-scoped trees. The route therefore goes into `appPageRoutes` as `path: 'browser'`,
> reachable as `/browser` and `/{orgId}/browser`. It does **not** collide with `crawlpack/browser`, which is a
> child of `crawlpack` and configures the crawl engine's browser rather than leasing one. Nav entry added to
> `navigation` in `_nav.ts` beside Crawl Pack, so the route is reachable. No `firebase.json` redirect is
> needed: this is an app-origin path, not a console path.
>
> **CORRECTION to `B.6` below: do NOT add a `BROWSER.*` namespace.** One already exists and belongs to the
> REMOTE-BROWSER VIEWER (`"Start Remote Browser"`, `"Connecting..."`), whose strings describe a connection
> state. Session keys therefore live under **`BROWSER_SESSION.*`**, which also avoids `BROWSER.STATE_*`
> reading as the viewer's connection state.
>
> BUILT since this note was written: `browser-frame` (11 specs; mounted on demand from the panel and wired
> into `/browser`, the playground's `browser` mode and `/machines`), the crawl-pack tab (since DELETED and
> superseded by `/machines` in the root nav — see the table above), and the admin fleet view (12 specs, route
> `admin/machines`). `B.2`, `B.3`, `B.4`, `B.5`, `B.6`, `B.7` and `B.8` are satisfied for the panel.
>
> **The frame COMPONENT is built; `browser-frame` still cannot show anything end-to-end (2026-10-03) — it is
> a CHAIN, not a missing file.** Part A needs
> a reachable machine to screenshot; reaching one needs `BROWSER_MACHINE_IMAGE`; that image needs
> `deploy/browser-session/` built on webrain's image; and webrain's `docker/Dockerfile` did not build. That
> last link is now fixed (the runtime was musl and could not exec a glibc engine binary — measured; see the
> `BROWSER_MACHINE_IMAGE` note in the skill). Part A is therefore unblocked *in principle*, and the honest
> next step is a `docker build`, not a component.
>
> One design fact Part A cannot avoid: **the frame path on the machine does not exist yet.** `A.2` below
> assumes a URL that yields a picture. The **`Mcp-Session-Id` hazard applies directly**: without a
> per-tenant session id, a screenshot can capture another tenant's page. The design has to be shaped
> around that, not patched after it.
>
> **CORRECTED 2026-10-10 — the passage that used to sit here described a proxy that does not behave as
> written, and Part A cannot use it.** Three separate errors, each verified in source rather than inferred:
> 1. "forwards the *incoming path*" is **FALSE**. `HandleContainerProxyFiber` builds `targetAddr` as
>    scheme+host only (`http://<machineId>.vm.<app>.internal:11235`, no path) and calls `proxy.Do`. Fiber
>    v2.52.9's `doAction` runs `req.SetRequestURI(addr)`, which **REPLACES** the URI, so the machine always
>    receives `GET /`. The path the client asked for never arrives.
> 2. "`Authorization` stripped" is **STALE**. Since 2026-10-04 the handler re-attaches the machine's OWN
>    `WEBRAIN_HTTP_TOKEN`, read from the `GetMachineDetails` response it had already fetched.
> 3. "a frame is a POST to an MCP tool through a path-forwarding proxy" is therefore impossible on **both**
>    counts: the route is registered `authedApp.Get` only, and `controller.MakeAPICallback` ends in
>    `return c.Status(httpResponse.Code).JSON(httpResponse)` on the error and success paths alike, so
>    whatever `proxy.Do` wrote into `c.Response()` is **overwritten by the envelope**. The handler's closing
>    comment claiming the response "has already been written to `c.Response()`" is false:
>    `GET /api/machine/proxy/:id` is a **liveness probe answering `{status:true}`**, and nothing flows back
>    through it.
>
> So Part A needs a **new `POST /machine/mcp/:id` in arachnefly**: same `MachineOwnershipMiddleware`,
> targeting `http://<id>.vm.<app>.internal:11235/mcp` **with the path INCLUDED in `addr`** (that is what
> makes it reach `/mcp` at all), and copying `c.Response().Body()` into `Data` **before** returning, because
> `MakeAPICallback` is about to overwrite the response. Two corrections to names as well: the frame
> primitive is **`webrain_observe(what="screenshot")`**, NOT `webrain_screenshot` (absent from the binary's
> own 17-tool `AGENT_GUIDE`); and because the tool returns PNG, the route should serve **`image/png`** —
> A.2's `image/webp` would buy an image codec to satisfy a content-type.
>
> Two panel decisions worth not re-litigating:
>
> 1. **It has TWO error channels, on purpose.** The envelope reports a failure to LOAD the list; create,
>    keepalive and close report through an inline notice. Flipping the envelope to `error` on a failed
>    keepalive would hide the list, and the session that needs closing is in it. A failed close is worse than
>    a cosmetic problem: the server leaves the session OPEN when its final charge fails, so the row must stay
>    on screen and still reads as live and billing.
> 2. **It reads the HTTP status to separate 402 from 403.** A plan boundary and a permission boundary must not
>    collapse into one message, and 403 deliberately gets no upgrade framing: a viewer with no lease rights is
>    not a customer who has not paid.
>
> It offers all three `BrowserSessionKind`s because the server accepts all three and a session is not a frame.
> The Lightpanda restriction in `B.4`/the skill applies to frames, and `browser-frame` is where it gets gated.
>
> `browser-frame` needs the `A.2` endpoint, which is Part A and unbuilt, so it cannot come first. And the
> existing `browser.service.ts` / `browser.component.*` are a DIFFERENT feature (the Chrome-extension bridge
> and the crawl-pack browser config), which is why the new files are named `browser-session.*`.
>
> The client types are the PUBLIC projection only. The stored record also carries `machineId` and
> `cdpSecretPath`, and deliberately has no field here for either. There is no `getCdpUrl()` on the service
> and there must never be one.
>
> **Trap paid for here:** an UNREFERENCED component escapes `bun run build`, which can drop a component
> without ever parsing its template. The chip's spec is what forces its template to compile, so a component
> with no spec has had its template validated by nothing at all. This is the Karma trap's wider sibling.

## B.0 Read the skills first (repository rule, not a suggestion)

Before writing any component, read:

1. `.github/skills/ui-designer-skill/SKILL.md` + its `references/`
2. `.github/skills/deepscrape-theme-template-skill/SKILL.md` + `references/current-theme-map.md`

Precedence if they conflict: `current-theme-map.md` > theme skill > UI skill > references. Always prefer
the more specific token. WCAG AA contrast is a floor, not a goal.

## B.1 Where it lives — one new surface, three upgrades

| Surface | Action | Notes |
|---|---|---|
| **Playground → new `browser` mode** | add | `modes` is a `readonly [...] as const` driving tabs and labels; adding a mode is one line **plus** an `@if` arm with a real component. An `@if` with no component renders an empty pane — that is worse than no tab. |
| **Dedicated page `/user/browser`** | new | for long-lived sessions: a lease list, not a single form. Lazy via `loadComponent`. |
| **Crawl-pack tab** | **DONE, then SUPERSEDED** | Built as a crawl-pack tab, then the tab was DELETED and the surface MOVED to `/machines` in the root nav (2026-10-03). A session's machine and a crawl machine were already the same object in one collection, so the section split was the only thing keeping them apart. See `browser-platform-skill/SKILL.md` "Where we are". The action layers stay separate. |
| **Admin → machine fleet** | upgrade | `admin-webrain.component` exists; add a fleet view on the existing `adminNavigation` entry. |

## B.2 Components

```
src/app/core/components/browser-session/
  browser-session-panel.component.{ts,html,scss}   lease controls + state
  browser-frame.component.{ts,html,scss}           live view
  browser-session-chip.component.{ts,html,scss}    state at a glance
src/app/core/services/browser-session.service.ts   the one writer of /api/browser/*
src/app/core/types/browser-session.interface.ts
```

Reuse, do not rebuild:

- **`result-envelope`** for `idle | loading | ok | error` states — already the shared shape.
- **`feature-gate`** + `feature-gate.policy.ts` for the paid boundary. Keep `paid` (402) and `rbac` (403)
  as separate axes; a viewer gets no upgrade CTA.
- **`stinput`** for text inputs.
- **`storage-save-button`** as the precedent for a per-item action with its own busy state.

## B.3 Component rules (the ones this codebase enforces)

- **Standalone only**, `changeDetection: ChangeDetectionStrategy.OnPush`, `inject()` not constructor
  params.
- **Signals for local state**; a root service's `BehaviorSubject` only for shared cross-component state,
  and never mixed in one service without an explicit `toSignal()`.
- **Zoneless** — no `NgZone`, no `ChangeDetectorRef.detectChanges()`, no `ApplicationRef.tick()`.
- **A method, not a `computed`,** when the thing you read is a `FormControl` value: a `FormControl` is not
  a signal, so a `computed` caches the first value forever. This bug already shipped once in
  `tools-panel` and is pinned by a spec there — copy that pattern.
- **Import operators from sub-paths** (`rxjs/internal/...`) as the rest of the repo does.
- **Guard browser-only APIs** with `isPlatformBrowser(this.platformId)`.

## B.4 The live view specifically

```html
<img [src]="frameUrl()" alt="Live view of the browsing session" />
```

- **Poll on a timer, cancel on destroy.** `takeUntilDestroyed` or an explicit `DestroyRef` teardown; a
  leaked interval keeps capturing screenshots and billing minutes.
- **Pause when the tab is hidden** (`document.visibilityState`) — it saves money and the frames are
  useless when unseen.
- **Backoff on error**, and surface it in `result-envelope` rather than retrying forever silently.
- **Revoke object URLs** if you switch from an `<img src>` to `URL.createObjectURL`.
- **`alt` text** on the image, and a text status alongside it — the frame is not the only carrier of
  information (a screen reader must learn that a session is ready and how to close it).
- Respect `prefers-reduced-motion` — if you add a pulse/scanline effect, drop it there.

## B.5 Feedback and honesty in the UI

The panel must say three things plainly, because the backend will refuse in ways that look like bugs:

1. **"Extract needs a session"** — on the `extract` tab, before the call, for users with no session.
2. ~~**"Free plans use the shared worker, which holds no sessions"** — rather than a bare 502.~~
   **WRONG as written, corrected 2026-10-03.** It stated a policy the backend does not implement:
   nothing refuses a session because a plan is free, and the shared worker holds no sessions for
   everyone, not only for free users. The copy now says what is true — *"Browser sessions are not
   included in your current plan."* — and the `BROWSER_SESSION.ERROR_PLAN` key is **kept**, because the
   defensive 402 mapping in `browser-session-panel.component.ts` is still the right behaviour if the
   server ever begins answering 402.
3. **"Your browser credentials are stored, never shown"** — mirroring the BYOB storage copy so the
   write-only convention is consistent across the product.

### Status of the three B.1 upgrades (2026-10-03)

- **Playground `browser` mode — DONE, and it shipped with a reachability bug.** It was wired in `modes`
  (with the `RUN_SURFACE_REQUIREMENTS` entry the `Record` forces), in the template arm, and in the
  component imports — but **`browser` was missing from the accept-list in `ngOnInit`**, so
  `?mode=browser` fell through to `default` and `currentMode` was reset to `llm-scrape`. The tab looked
  selected and rendered the LLM Scrape pane. That is the failure the `modes` comment warns about ("a mode
  arm with no child renders an empty pane") arriving by a different road. Fixed, with a regression spec.
  The general lesson: **a mode id lives in four places** — `modes`, the gate `Record`, the template arm,
  and the `ngOnInit` accept-list — and only the first three are compile-checked.
- **Crawl-pack tab — the tab exists; webrain as a choice does not. note_5 answered.** `crawlpack.route.ts`
  already has a `browser` child route ("Browser Configuration" → `browser-config.component.ts`), so both
  the tab and the page are real. What is missing is webrain as an option on it: `addPackToCart` calls
  `cartService.addItemToCart({ browserProfile: profile }, 'crawl4ai')`, pinning the provider to a
  literal. **It is adaptable, not dead legacy** — `addItemToCart(item, scrapeType = 'crawl4ai')`
  (`core/services/cart.service.ts:175`) takes the provider as a *defaulted parameter*, so supporting
  webrain is a matter of passing it rather than rewriting the cart. The open question is product, not
  mechanical: whether a browser profile is priced per provider.
- **Admin → machine fleet — not built.** It needs a backend slice first: a cross-user collection-group
  read, a route in `bff/api.ts` gated `perm('platform','read')` (never `machine.read`, which is
  tenant-scoped), and an index. See `05` Part D.

## B.6 i18n

- ~~Add keys under a new `BROWSER.*` namespace.~~ **WRONG as written, corrected 2026-10-03.** A `BROWSER`
  namespace already exists and belongs to the remote-browser VIEWER (`"Start Remote Browser"`,
  `"Connecting..."`, `"Connected to remote browser"`), so a session key placed there would read as a viewer
  connection state and the two features would be impossible to separate by name. Session keys live under
  **`BROWSER_SESSION.*`** instead: `STATE_STARTING`, `STATE_READY`, `STATE_SUSPENDED`, `STATE_CLOSED`,
  `MODE_DEDICATED`, `MODE_BYO`, added to all five locales with parity checked.
- Add new session keys to **all five** locales (`en, de, el, es, fr`) in one pass.
- The verifier used this session: flatten every locale, compute the union, assert `missing=0` and
  `extra=0` per locale. 2,509 keys × 5 was the last clean baseline — keep it clean.
- **No em or en dashes** anywhere (the repo strips them; `scripts/strip-banned-dashes.mjs`).

## B.7 Navigation

- Account settings tab strip is `ACCOUNT_DATA_TABS` in `src/app/core/variables/global.var.ts`.
- Admin strip is `adminNavigation` in `src/app/_nav.ts`. A route with no nav entry is **unreachable** —
  that happened to `/admin/webrain` and was fixed; do not repeat it. Route **and** nav entry, same commit.
- Host routing is policy-driven (`host-routing.policy.ts`); a new console path may need a rule in both the
  router and `firebase.json` redirects.

## B.8 Acceptance

- [ ] `bun x tsc --noEmit -p tsconfig.app.json` → 0
- [ ] `bun run build` → 0 (the only template validator)
- [ ] `bun x ng test --watch=false` → all green, with a spec for the visibility/mode logic
- [ ] i18n parity: 0 missing, 0 extra across five locales; no banned dashes
- [ ] Every new route has a nav entry (or is deliberately deep-link-only, stated in the PR)
- [ ] The frame loop stops on destroy — assert the teardown in a spec
- [ ] Contrast checked against `current-theme-map.md`, not eyeballed

---

# B.9 The crawl-pack provider config — answered (2026-10-03)

`B.1` lists a "Crawl-pack tab" upgrade, and the open question was whether the existing crawl-pack
browser configuration can be adapted to webrain. It cannot, because the two are not the same axis —
and **the webrain side is already built**:

| Surface | What it actually is |
|---|---|
| `crawlpack/browser` → `BrowserConfigComponent` | The **crawler engine's** browser *profile*: `BrowserType` is `chromium \| firefox \| webkit`, plus cookies, headers, proxy, viewport, user agent, extra args and storage. Held in the `browserProfiles` collection (`new PackService('browserProfiles')`) and added to the **cart** (`addItemToCart(..., 'crawl4ai')`). A purchasable config artefact for a crawl job, not a lease. |
| `/api/webrain/config/*` → `WebrainConfigService` | Webrain's **own** provider config, already separate: the MCP token (write-only, minted once) and the proxy pool. Types in `core/types/webrain-config.interface.ts`; UI in `pages/admin/admin-webrain.component.ts`, mounted at `admin.route.ts:54`. |
| `SCRAPE_PROVIDER` i18n keys | The provider selector already exists and already separates the engines: `CRAWL4AI: "Crawl4AI (frozen)"`, `JINAAI`, `WEBRAIN: "WebRain (embedded)"`. |

So it is **neither adaptable nor legacy**: a browser *profile* configures the crawler's engine,
while a browser *session* leases a browser you drive. Merging them would merge two lifecycles.

**The hazard it does expose**, same class as the `idleDeadline` trap: there are now **two browser
vocabularies with nothing enforcing agreement** — `BrowserType` (`chromium|firefox|webkit`, the
crawler's engine) and `BrowserSessionKind` (`chrome|lightpanda|obscura`, a leased session). They
overlap in meaning and share no type, so `chromium` in a profile and `chrome` in a session are the
same engine written twice. Reconcile them deliberately or keep them apart deliberately, but do not
let them drift.

**Where the session surface actually belongs** is therefore not `crawlpack/browser`. The
integration points `B.1` names still stand: the playground `browser` mode, a crawl-pack tab, and
the admin fleet view — the last being the natural sibling of `admin-webrain`, not a rewrite of it.

# B.10 Creating an operation — the definition, and what was missing (2026-10-10)

`/operations` is the scheduled-job surface. Its own template copy states the contract and the
entitlement table already recorded it, but only one of the three actions had been implemented.

**The definition, as the code states it.** A job is created from a saved **CrawlPack** plus one of
three actions taken from the `operationStatus` dropdown:

| Action | `operationStatus` | Intended |
|---|---|---|
| **Save** | `CrawlOperationStatus.READY` | Record the operation only. |
| **Run** | `CrawlOperationStatus.STARTED` | Enqueue now and attach the returned task id. |
| **Schedule** | `CrawlOperationStatus.SCHEDULED` | Record with `scheduled_At` for a dispatcher. |

The enqueue surface is `POST /api/crawl/stream/job` — `CrawlAPIService.multiCrawlEnqueue(urls,
operationData, pack)` — which is exactly what `OPERATIONS_REQUIREMENT` in `feature-gate.policy.ts`
cites as its `source`. The reply's `task_id` is the mechanism, not a detail: `initOperations`
derives every row's status from `wsService.taskStatus$` by matching `op.task_id`, and opens a
websocket only for rows that carry one.

**What was missing — three links.**

1. **`crawlConfigPack` had no writer.** The picker's options were never loaded, so the template's
   `@if(!crawlConfigPack.length)` always took the empty branch and the page could never satisfy its
   own "create a pack, then Run" instruction. **Fixed:** filled by `loadCrawlPacks()` from
   `FirestoreService.loadPreviousPacks(uid)`, each option's `code` being the pack document id.
2. **Submit never enqueued.** `onPromptSubmited` fell through to `storeCrawlOperation` for *every*
   action, so **Run** and **Save** were identical: an operation was a Firestore row with no
   `task_id` — inert, displaying whatever status the form had written. **Fixed:** Run resolves the
   pack from the picker, calls `multiCrawlEnqueue`, and persists the operation carrying the
   returned `task_id`, written from `complete` so a job the server refused leaves no such row. Run
   without a pack is refused (the action dropdown stays usable even when no packs exist).
3. **Schedule still has no dispatcher.** Nothing sweeps `scheduled_At`, so a scheduled row is
   recorded and never runs. This is deliberate rather than a silent half-build — the store-only
   branch is one explicit `if` and no code pretends the row will start. Closing it needs a
   server-side scheduler and a BFF route, neither of which exists.

**Note:** this is the alternate job-creation surface. `B.1`'s frame work is untouched by it, and
A.3's fps cap and the required arachnefly `POST /machine/mcp/:id` are both **DONE** (the cap comes from
`SESSION_CAPS` via `frameIntervalMs`; the route exists).

