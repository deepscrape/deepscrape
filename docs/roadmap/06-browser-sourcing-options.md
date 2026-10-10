# Browser sourcing — the two axes, the matrix, and what actually works

This file answers: *"our platform has three browser options — do they work?"*

Short answer: **two axes, not three options**, and exactly one combination is unusable.

---

## The reframe: two independent axes

Your three options are combinations of two decisions that look like one:

| Axis | Question |
|---|---|
| **A1 — where webrain runs** | one shared process, a pool of exclusive workers, or a dedicated machine? |
| **A2 — where the browser comes from** | bundled in the worker, a platform browser pool, or a caller's own CDP URL? |

They multiply. "Shared browser sessions" is A1-shared + A2-platform. "Custom CDP URLs" is A2-BYO on any
A1. "Dedicated machines with internal browsers" is A1-dedicated + A2-bundled.

---

## Axis 1 — where webrain runs

| A1 | Isolation unit | Verdict |
|---|---|---|
| a single **shared webrain process** | none | **does not work** |
| a pool of **exclusive workers**, routed by our gateway | the worker process | works |
| a **dedicated machine** per session/user | the Fly VM | works — safest |

### Why a shared webrain process cannot work

Not a policy judgement — three verified properties:

1. Session routing takes the caller's **`session_id` verbatim** (`lib.rs:1236`), and
   `webrain_session(op=list)` **enumerates every session plus its `cdp_url`** (`lib.rs:1276-1288`).
2. There is **no caller identity** — one **process-wide shared secret** (`WEBRAIN_HTTP_TOKEN`,
   `lib.rs:84`), and it defaults to *unset*, which means allow.
3. Session entries carry **no uid** (`SessionMeta { backend, cdp_url }`).

The sentence to remember: **the insecure unit is the webrain *process*, not the browser.** Adding more
browser processes behind one webrain does not help — tenant A can still name tenant B's `session_id`
and drive B's browser, cookies and all.

`WEBRAIN_NO_STATE=1` is not a fix either: it *refuses* `webrain_launch` (it is in `STATEFUL_TOOLS`), so
a shared worker **cannot start a browser at all**. It is a mitigation, not an isolation boundary.

### Why an exclusive-worker pool *does* work

Because **our gateway does the routing**. A caller never names a worker; the mapping
`uid → worker` is ours, and it is the only thing that decides where a request lands. That is the whole
difference between "shared" (unsafe) and "pool" (safe) — **not how many browsers there are, but who
chooses which one.**

The honest cost note: an exclusive worker costs the *same memory* as a dedicated browser
(Chrome ≈ 300–500 MB). The saving is **machine count** — which matters because Fly's scaling limits are
undisclosed (see `README.md`). You pay for it with weaker isolation: several tenants' workers share one
kernel, where dedicated machines give each tenant a VM.

---

## Axis 2 — where the browser comes from

| A2 | Works | Note |
|---|---|---|
| **bundled Chrome** in the worker image | yes | **the only option that renders** — required for live view |
| **bundled Lightpanda** | yes | 123 MB, instant start, ~9× faster, **no graphical rendering** |
| **bundled Obscura** | yes (installed on demand) | **verify whether it renders** — unknown to me |
| a **platform browser pool** | yes, subject to Axis 1 | never share one browser across tenants |
| a **caller's own CDP URL** | yes — cheapest for us | SSRF risk unless the worker is exclusive |

### The three browsers — webrain already covers all three

The code is there: `find_lightpanda` / `install_lightpanda` / `launch_lightpanda`, the same trio for
`obscura`, plus Chrome for Testing. The Dockerfile installs `chromium` with `apk`; Lightpanda and Obscura
install on demand into the `webrain-cache` volume (its own comment names both: *"engine cache (Chrome for
Testing / Obscura)"*).

| Browser | Memory | Renders? | Live view | Best at |
|---|---|---|---|---|
| **Chrome** | ~300–500 MB | yes | **yes — the only engine for SPAs and challenges** | complex SPAs, Material UI, interactive challenges, authenticated pages |
| **Obscura** | light | **yes — v0.2.0+ render builds** (+ PDF) | yes, for simple JS pages | JS pages, **parallel tabs** |
| **Lightpanda** | **123 MB** | **no — returns a fake placeholder PNG** | **never** | fast sequential extraction, and a real AX tree for a11y |

Source of truth for all of it: `webrain/skills/webrain/references/browser-selection.md`, which is
webrain's own engine matrix.

### CORRECTION — my earlier "Obscura unverified" was wrong

I marked Obscura's rendering as unknown. It is not. `install_obscura(force, stealth, render)` publishes
**four variants** — `""`, `-stealth`, `-no-render`, `-no-render-stealth` — so a rendering build exists,
and webrain's matrix confirms it: *"obscura … Screenshots ✅ v0.2.0+ render builds (+ PDF)"*. It is a real
third-party browser published as versioned GitHub release assets per platform, not a webrain-internal
shim.

### The trap worth wiring around

**Lightpanda's screenshot is a *fake placeholder PNG*.** Not an error — a plausible image. So a frame
endpoint that accepted `kind: "lightpanda"` would silently serve a placeholder and look broken rather
than fail loudly. **Gate frames to `chrome`, and to `obscura` only when the render build is installed** —
in code, not just in the UI copy.

### Engine choice is page-state driven — webrain's own guidance, and it should be the product's

```
STATIC + PUBLIC          -> fetch_http (no browser at all)   10-100x faster, zero memory
JAVASCRIPT + PUBLIC      -> obscura (or lightpanda)          parallel tabs; not full layout parity
COMPLEX SPA (Material)   -> real Chrome                      never obscura/lightpanda
AUTHENTICATED            -> profile + Chrome + session
PROTECTED (CF/Turnstile) -> profile + Chrome + session
PROTECTED + CHALLENGE    -> Chrome + human in the loop       <- the live-view use case
```

That last row matters commercially: webrain's doc says interactive challenges *"need the human in the
headed browser."* That is a concrete, honest, defensible paid use case for live view — a customer
watching and solving a CAPTCHA their agent cannot. It is a much better story than "it looks nice".

The golden rule from that doc is worth adopting: **never pick an engine from memory — read the
`challenge` field after `webrain_navigate` and re-evaluate.** That is also a useful product behaviour:
pick the engine per page state instead of asking the user to.

### So: the constraint, restated correctly

Live view needs a **rendering** engine. Chrome is the only one that also handles SPAs and interactive
challenges; Obscura can render simple JS pages and is lighter. Lightpanda can never serve frames. So
`kind` is not a free preference, and the frame endpoint must enforce the difference itself.

Consequence: make `kind` a **per-session parameter** (already designed as
`BrowserKind = "chrome" | "lightpanda" | "obscura"` in `02-machine-leasing.md`), but the UI must say
which kinds can show a live view. Otherwise you will get "why is my Lightpanda session blank?".

---

## The matrix — which combinations work

| webrain A1 ↓ / browser A2 → | bundled | platform pool | BYO CDP |
|---|---|---|---|
| **shared process** | **NO** | **NO** | **NO** |
| **exclusive worker pool** | yes | yes *(that is this)* | yes |
| **dedicated machine** | yes | n/a | **yes — best cost** |

Read it as: the top row is unusable for **any** browser source, because the leak is in webrain's process,
not in the browser's location. Everything on the bottom two rows works.

BYO CDP is orthogonal to the other two — it composes with either, and it is the **only** option that
removes our browser cost entirely. It is the cheapest tier you can offer and it should be priced that
way. The one rule: **`cdp_url` is an SSRF primitive on a shared worker** (no allowlist in `resolve_ws`,
blind `GET {url}/json/version`, and `.vm.{app}.internal` plus 6379 reachable). So BYO CDP belongs on an
**exclusive** worker or a dedicated machine, never on a shared one.

---

## What already works vs what to build

**Works today (verified):**
- the free tier, HTTP-only, with no browser at all (`fallback_chain` tries HTTP engines first, the
  browser last and only if `Option<&B>` is `Some`);
- per-machine browser choice — three launch paths already exist;
- machine deploy / start / suspend / stop (`arachnefly`);
- BYO CDP at the tool level (`cdp_url`, `batch.cdp_urls[]`, `CDP_URL`).

**To build:**
1. **exclusive-worker routing** — the gateway must own `uid → worker` (new; nothing does this today);
2. **`BrowserKind` per session** + caps per tier;
3. **a CDP-URL allowlist**, or BYO sits on exclusive workers only;
4. **cloud-init for the three browsers** — Chrome is in the image, Lightpanda/Obscura install on demand
   (first request pays the download; pre-warm it or the first session is slow);
5. **frames** — Chrome always; Obscura only when the render build is installed;
6. **Fly app secrets** — set `WEBRAIN_HTTP_TOKEN` per app via the Machines **Secrets** API rather than by
   hand (verified: the API has a Secrets resource).

---

## Recommendation

1. **Never ship the shared-process row.** It is the only combination that cannot be made safe, and the
   `NO_STATE` guard already refuses the browser launch it would need.
2. **Start with dedicated machines** (already ~80% built) — correct, safe, and cheap while suspended.
3. **Add the exclusive-worker pool as a cost optimisation later, not as a feature.** It buys machine count,
   not capability, and it is the one thing here that needs new infrastructure (our own router).
4. **Add BYO CDP early** — it is nearly free, webrain already accepts it, and it removes the platform's
   browser cost for the users who bring their own.
5. **Chrome for SPAs and challenges; Obscura for volume.** Obscura *does* render (v0.2.0+ render builds)
   and batches with parallel tabs, so it is the density play — not a cheaper licence.
6. **Never let a frame request reach Lightpanda.** Its screenshot is a placeholder, so the failure would be
   a plausible wrong image rather than an error. Gate it in code.
7. **Build the scheduler, never the browser.** Obscura is a third-party project; consume its releases.
8. **Do not build the Obscura pool yet.** Free works today with no browser at all. Build it when
   JS-dependent free calls measurably fail, and treat it as a capacity purchase — see `07` Part H.

---

## DECISION 2026-10-02 — the free playground is browser-backed, Obscura is the pool engine

This supersedes recommendation 8. R8 assumed the free tier had **nothing to fix**; the product decision
is that `/extract` and `/pdf` are browser-needing playground routes and must work for free users behind a
per-day limit. That is the owner's call and it is now the requirement; the rest of this file becomes
*how*, not *whether*.

### What is already true, so nothing below is speculative

- **The routes exist and free callers reach them.** `POST /api/extract` and `POST /api/pdf` are registered
  in `bff/api.ts` with `guard([access, perm('crawl','execute'), …])` — **no `paid` gate**. The tier gate
  is `decideWebrainTool` against `SHARED_POOL_TOOLS`, which already contains `webrain_extract` and
  `webrain_pdf` (alongside `scrape`/`search`/`serp`/`guide`).
- **Driving an external browser is supported and recommended by webrain itself.** Its tool docs describe
  giving "each its own browser via CDP_URL, and they run in parallel", with "one CDP_URL per subagent =
  own" for per-IP isolation (`webrain-mcp/src/tools.rs:187-197`), and the batch tool takes `cdp_urls[]`
  with round-robin plus `per_backend_concurrency` (default 4).
- **Obscura is the correct pool engine, and it is `06`'s own answer.** It renders in v0.2.0+ **render**
  builds and **does PDF**; Lightpanda can never render. Since `/pdf` is the requirement, Lightpanda cannot
  be the free default — the earlier "Lightpanda for free" reading was wrong for this route.
- **The anti-starvation cap already exists.** webrain bounds fan-out on a shared instance:
  `MAX_SHARED_CONCURRENCY = 6`, enforced only under `WEBRAIN_NO_STATE`, with the stated reason that
  "without a cap one tenant can request a thousand tabs and starve every other tenant on the box"
  (`tools.rs`). Multi-tab concurrency for pooled users is therefore already implemented *and already
  bounded* — the number is 6, not "based on resources".
- **The daily limit mechanism exists** — `07` Part D.

### The three corrections that change the design

1. **`extract` and `pdf` accept NO CDP argument.** Only two tools declare one: `webrain_session`
   (`cdp_url`) and the batch tool (`cdp_urls`). Everything else attaches through the worker's **`CDP_URL`
   environment variable**. So the pool cannot be "a browser pool webrain reaches into per request" for
   these routes. **The pool unit is a pair: one webrain worker + its own browser, addressed by that
   worker's `CDP_URL`.** A pool of browsers behind a shared worker is not expressible for `/extract` and
   `/pdf` anyway — which is lucky, because it is also the unsafe shape.
2. **Multi-tab is per-tenant only.** Tabs inside one browser process share a **cookie jar** — cookies and
   localStorage are profile-scoped, not tab-scoped. So tabs are not an isolation boundary and
   "multi-tab for many users" is the leak restated. Multi-tab *within* one tenant's job is safe and is
   what `concurrency`/`per_backend_concurrency` are for, capped at 6 on a shared instance.
3. **A shared webrain worker must never be handed CDP URLs.** `resolve_ws` has **no allowlist**
   (`webrain-core/src/backends/cdp.rs:269`) — any URL, a blind `GET /json/version`, 5s timeout. And the
   shared-instance session-enumeration leak was **real and already fixed**: `webrain_open_session`,
   `webrain_close_session` and `webrain_list_sessions` are refused under `WEBRAIN_NO_STATE`, with the
   code comment that `list` "was served on a shared worker, **enumerating every tenant's sessions**"
   (`webrain-mcp/src/lib.rs:1366-1383`). Handing a shared worker a CDP URL walks straight back toward
   that class of bug. CDP URLs come from us only, never from a request.

`WEBRAIN_NO_STATE=1` on the pool is **compatible** with this design, and that is the point: it refuses
`launch` and the session ops, not the use of a browser attached at startup via `CDP_URL`. So the pool
runs with the guard ON and keeps the enumeration closed.

### The shape to build

| Concern | Decision |
|---|---|
| Pool unit | a **pair** — webrain worker + its own browser, joined by that worker's `CDP_URL` |
| Engine | **Obscura render build** for the free pool; Chrome is the paid escalation; Lightpanda only for render-free work and **never a frame** |
| Tenancy | one tenant per unit at a time; recycle the **browser** between tenants, not the machine |
| Tabs | per tenant, ≤ 6 (webrain's own shared-instance cap) |
| Guard | `WEBRAIN_NO_STATE=1` — keeps session enumeration closed |
| Routing | ours: `uid → unit`, in **arachnefly** (it owns machine lifecycle, the ownership middleware, the reaper and the cron). Not a new service, and **no pooling API in webrain** — that would couple the engine to the platform |
| Warmth | must be **pre-warmed**: Fly allows ~1 `Create Machine`/s per app, shared by all tenants |
| Cost control | machines × uptime, so the per-day allowance is the lever, not the container size |

### Still worth doing first, for a different reason

The `needs_js` gap in `07` Part H does not disappear because the decision was made — its *purpose*
changes. It is no longer "should we", it is **"how often, and how often does Obscura fail"**: free
`/extract` on a Material SPA will fail outright, because Obscura has no full layout parity. Without that
signal the failure is silent and looks like a platform bug rather than an engine limit. `06`'s golden
rule already says the answer — read the `challenge` field after `webrain_navigate` and re-evaluate — and
the UI must then say *which* engine could not do it.

---

## DONE 2026-10-02 — the signal that decides escalation is now read

`needs_js` is built and verified, and building it corrected two of my own claims from the turn before.

**What it is.** `webrain_scrape` — which is `POST /api/scrape`, a free, live route in
`SHARED_POOL_TOOLS` — fetches over plain HTTP with **no browser** and reports whether the page turned out
to be a JavaScript shell. Verified against a running engine rather than inferred:

```
https://example.com   -> needs_js: false, visible_chars: 425
a 111-byte JS shell   -> needs_js: true,  visible_chars: 3
```

**Two corrections.** First, I claimed this was emitted only by `fetch_http`, a tool the platform does not
expose — **wrong**: `webrain_scrape` *is* that path, and it is free, so the metric was on the free path all
along. Second, the flags are nested under `result`, not at the top level, which is the part a
hand-written fixture would have got wrong.

**Where it lives.** Parsed in `domain/webrain-signals.domain.ts` — pure, so a spec can import it, the same
reason `webrain-proxy.domain.ts` exists — and surfaced on `WebrainToolResult` in
`infrastructure/webrain-mcp.ts`. **Absent stays absent**: a tool that never reports the flag answers
`undefined`, never `false`, because `false` would assert that a static page fetched cleanly, which is the
exact silent failure this exists to expose. Gate: **517 tests / 508 pass / 0 fail / 9 skipped**.

## The escalation ladder — one free request, engine chosen for it

Recorded so the next phase implements one ladder rather than inventing one:

```
free /extract or /pdf
        |
        v
browserless fetch (webrain_scrape, plain HTTP)
        |
        +-- needs_js false ----> answer; no browser spent
        |
        +-- needs_js true -----> escalate
                                   |
                                   v
                      next available browser from the pool
                      (Obscura default -> Chrome/Chromium when the
                       page needs real layout or a challenge)
```

Rules that fall out of this file and must not be improvised at the call site:

- **`needs_js` is the trigger, and it is the only signal the browserless path currently emits.**
  **CORRECTION 2026-10-03: my reason for that was wrong, and the difference is the whole point.**
  I wrote that `challenge` "is populated during a navigation, which this path never performs". It is not.
  `detect_antibot(title, text)` is a **pure string classifier** — its own doc comment says
  "*from its title+visible text ... No HTML/network*" — so it needs no browser at all. It is absent from
  the browserless path only because **nothing there calls it**: all three call sites are in the browser
  path (`cdp.rs:1486`, `cdp.rs:2396`, `browser.rs:411`), never in `webrain-mcp/src/tools.rs`.
- **So `challenge` is not a phase-2 item. It is a free-path item, and arguably the more important one.**
  `needs_js` catches a JS shell; `challenge` catches a page that **reads as success and is not**. The
  browserless tool returns `{url, status, text, needs_js}`; a Cloudflare deny page fetches as status 200
  with pages of visible text, and `probe_needs_js` returns `false` for it — because that heuristic is
  *"any of four JS phrases"* **or** *"`visible_text_len(html) < 100 && contains `<html`"*`. A deny page
  satisfies neither. Without `challenge`, the ladder has no way to tell it from real content.
- **The place to fix it is inside webrain, next to the line that already does this.** `needs_js` is set at
  `webrain-mcp/src/lib.rs:243` as `v["needs_js"] = json!(tools::probe_needs_js(&html));`. The detectors
  already exist, are already `pub`, and take the `title`/`text` that fetch already produced — so emitting
  `challenge` (and `crippled`, and `chrome_error`, which has the same shape) is a few lines in that one
  function. This is engine-reporting-on-itself, the same pattern as `needs_js`, and it does not couple the
  binary to the platform.
- **Do NOT reimplement it on the platform side from `text`.** The STRONG marker list is
  `__cf_chl`, `challenge-platform`, `cf-error-code`, `h-captcha`, `g-recaptcha` — attribute, class and URL
  fragments, none of which survive into *visible* text. Reimplemented against a lossy `text` field it would
  silently match nothing and look like it was working.
- **Escalation is a retry on a different worker, never a second engine in one process.** The pool unit is
  a pair (worker + its own browser), so "next available browser" means "next unit" — not another CDP URL
  handed to the same worker.
- **The last rung is honesty, not a better engine.** Obscura has no full layout parity and Lightpanda
  never renders, so a Material SPA or an interactive challenge must end in a named refusal that says which
  engine was tried — not an empty result.
- **Never Lightpanda for a frame**, at any rung: its screenshot is a placeholder, so the failure mode is a
  plausible wrong image rather than an error.

## HAZARD (verified 2026-10-02) — every tenant shares webrain's `default` session today

Unrelated to the pool, already true, and it raises the priority of the work above.

`webrain-mcp/src/lib.rs` resolves a call's session as:

```rust
} else {
    session_id.unwrap_or_else(|| "default".to_string())
};
```

The platform's client sends **no `Mcp-Session-Id`** — verified: that header appears nowhere in
`infrastructure/webrain-mcp.ts` — and the free tools pass no `session_id` argument either. So **every call
from every tenant resolves to the single session key `"default"`, and therefore to one `backend`.**

For stateless tools that is harmless: they take a URL and return. But `webrain_extract` is documented as
*"Structured extraction from the CURRENT page"* and `webrain_pdf(op=page)` as *"save current page as PDF"*.
Neither takes a URL. On one shared session, "the current page" is whatever the last caller left there — so
an `/api/extract` or `/api/pdf` call can return **another tenant's page**.

Two things follow:

- **This is a reason the pool is not merely nice to have.** A per-tenant worker gives each caller their own
  current page, which is what these two routes need to be correct at all — and both are already free and
  reachable.
- **A cheaper mitigation exists and should be weighed first:** send a per-tenant `Mcp-Session-Id`, derived
  from the uid with a server secret so it is unguessable and never caller-chosen. That splits the backends
  without a fleet, at the cost of `MAX_SESSIONS = 64` eviction churn — webrain evicts an arbitrary session
  when the map is full, so a caller mid-flow can lose their page.

Deliberately **not** fixed alongside the signal: it changes what every webrain call sends, so it wants its
own change and its own review.

## CONSTRAINT (verified 2026-10-03) — the pool machines must be glibc

Everything above assumes Obscura runs on the session machines. It can — but not on the base this project
had already chosen, and the failure mode is the bad kind.

Obscura's Linux release binaries are built for `x86_64-unknown-linux-gnu` on **Ubuntu 22.04**
(`.github/workflows/release.yml`), so they need **glibc ≥ 2.35**; obscura's own image runs them on
`gcr.io/distroless/cc-debian12`. The worker image in `deploy/browser-session/` was Alpine (musl). On musl,
`webrain install obscura` **succeeds** — the tarball downloads and extracts — and the binary then fails at
`exec`, because `/lib64/ld-linux-x86-64.so.2` is not there. So this would not have shown up in a build, nor
in a smoke test, nor on any page that did not need Obscura. It would have shown up the first time a live
session escalated to it — per session, in production.

- **Debian bookworm (glibc 2.36) and Ubuntu 22.04+ work. Alpine does not. Neither does bullseye (2.31).**
  Verified: `debian:bookworm-slim` installs nginx via apt and reports glibc 2.36, exit 0.
- **It is the same one-line change webrain's own Dockerfile needs**, for an unrelated reason — it pins
  `rust:1.85-alpine` against a lockfile that resolves to rustc 1.88, so it cannot build at all.
  `rust:1.88-slim-bookworm` fixes the rustc pin, the musl/glibc mismatch and `apk` in a single edit.
  **My earlier advice was `rust:1.88-alpine`, and it was wrong** for exactly this reason.
- The adapter now installs through `apt-get`, which doubles as a build-time assertion: on a musl base the
  build fails immediately rather than shipping an image that breaks one session at a time.

Two further facts from the same check, both of which support choices already made here rather than
changing them: every release tarball ships **both `obscura` and `obscura-worker`**, so the worker model the
pasted document describes is real and shipped; and untrusted page JavaScript runs **in-process through
V8**, which is why upstream runs nonroot — the strongest available argument that an isolation unit must be
a process, which is what invariant I2 already requires.

## DONE 2026-10-03 — the pool is a LIST, not a service

The free playground's browser-backed calls (`/extract`, `/pdf`) run against webrain workers over MCP, not
against a leased machine. So the pool's unit is a **worker held for one call**, and the open question was
where the worker set should live.

It already had a home, and finding it **removed a service from the plan**.
`infrastructure/webrain-config.store.ts` **is already a pool**: one runtime-readable secret
`WEBRAIN_CONFIG`, JSON `{mcpToken, proxies[]}`, TTL-cached at 30s with concurrent cold reads collapsed into
one, never fatal on a failed read, with an env fallback and a `resolvedSource` an admin route reports. Its
own docstring names the motive — *"or a proxy added to the pool"*. **So the worker pool is a second list in
that document — not a new store, a new service, or a new dependency.** Retiring a burned worker becomes the
same operation as retiring a burned proxy exit: one merge, visible within one TTL, no deploy, **and no new
lifecycle code** — arachnefly keeps owning machines, the reaper and cron.

**Built (gates: TSC 0, LINT 0, 527 tests / 518 pass / 0 fail):**

- `workers` on `WebrainConfig`, parsed by the **same** `toEntries` mapper as `proxies` (parameterised by
  labeller rather than copied), env-supplied by `WEBRAIN_WORKER_POOL`, exported as `webrainWorkerPool()`,
  and merged in `saveWebrainConfig` so a token rotation cannot silently drop the pool.
- `domain/webrain-workers.domain.ts` — `workerLabel`, `workerLeaseKey`, `selectWorker`. Import-free, for
  the same reason `webrain-proxy.domain.ts` is split out: a spec can test behaviour without dragging the
  Admin app and a Secret Manager client in at module load.
- `domain/webrain-workers.spec.ts` — 10 tests.

**The rule is the whole point.** `selectWorker(workers, busy)` returns an idle worker or a refusal —
`no_workers_configured` or `all_workers_busy` — and never "the least busy one". A refusal is a 503, not a
share. That is I2 stated as a function signature.

**Deliberately NOT built, and both are needed before this is a working pool:**

- **The lease itself.** Selection is pure; the atomic claim/release needs shared state — Upstash Redis with
  a TTL, so a crashed caller's lease self-heals instead of stranding a worker. Until then `selectWorker` is
  a rule with no enforcement: two instances can both observe the same worker idle.
- **The wiring at the call seam.** No route calls `selectWorker` yet, which is precisely why nothing
  regressed. Until a route does, a browserless fetch still answers a JS shell as though it were content.

**A bug found on the way, and it was mine.** `workerLabel` first returned an **empty** label for a
credential-shaped string: `new URL("user:pass@host")` does **not** throw — it parses as scheme `user:` with
an *empty hostname* — so a try/catch is not proof of a usable endpoint. The existing `labelFor` guards this
with `hostname || fallback`; my rewrite used a ternary on the port and dropped the guard. The spec caught
it; pinned now, including `file:///tmp/socket`.

**Why the port is load-bearing.** `labelFor` names an entry by hostname — correct for proxies, where one
host is one exit, and wrong for workers. `127.0.0.1:9223` plus `:9224` is the local case and one machine
running `--workers N` is the production one; a hostname-only key would collapse them, and two tenants would
each be told they held the same worker exclusively — a cross-tenant leak arising from a display string.

### The lease is built, and it had to fail closed

`selectWorker` decides which worker *could* serve a call. Whether one actually will has to be answered the
same way in every instance at once, so it is a single atomic command —
`infrastructure/webrain-worker-lease.ts`, `SET key holder NX EX ttl`.

**A trap would have made it fail open.** With Redis unconfigured, `app/cacheConfig.ts` substitutes a no-op
client, and that stub answers `"OK"` to `set` and a fixed `[null, "ok"]` to `eval`. A claim written against
the command's own return value therefore reports **success with no Redis at all**, hands the same worker to
every caller, and turns I2 into a comment. `isRedisEnabled` is not exported, so the defence is the
predicate: `leaseGrantedBy` requires a genuine holder **string**, and the stub's array is refused by
construction. Pinned in the spec, asymmetry included — `"OK"` *is* accepted as a token, which is precisely
why the claim goes through `eval` and must keep doing so.

**Release is conditional, and that is not decoration.** A bare `DEL` is wrong: a call can outlive its own
TTL, and by then another tenant may hold the key — deleting unconditionally would revoke *their* lease and
admit a third caller mid-call. The Lua release compares the holder first.

**Consequence, stated rather than discovered later:** with no Redis configured — local dev and the emulator
— no lease can be taken, so a pooled browser call is refused there. That is intended. A worker that cannot
be proven exclusively leased is not handed out.

Gates: **530 tests / 521 pass / 0 fail**, TSC 0, LINT 0.

**Still not built: the call-seam wiring.** No route calls `selectWorker` / `claimWorkerLease` yet, so the
pool is specified, tested and **unexercised** — exclusivity has no enforcement point. Wiring it changes how
a live free route resolves its worker URL, and it makes those routes refuse when Redis is unconfigured;
both are deliberate steps rather than side effects.

### The acquisition layer is built; one hook is left

`infrastructure/webrain-worker-acquire.ts` closes the service: `acquireWorkerTarget(singleUrl)` walks the
pool in configured order until a claim lands and returns `{url, leased, release}`. The order comes from
`planWorkerAcquisition`, in the domain so a spec asserts it, and the safety property it encodes is that
**`use-single` is reachable only when no pool is configured** — a busy pool must not degrade to the shared
single worker, because that is the sharing the pool exists to remove, and it would happen exactly when
contention is highest, presenting itself as "the pool got busy" rather than as a leak.

Gates: **535 tests / 526 pass / 0 fail**, TSC 0, LINT 0.

**The wiring is now DONE**, and the behaviour is deliberately unchanged for today's configuration: with no
pool, `planWorkerAcquisition` returns `use-single`, the target is unleased and `release` is a no-op — so a
deployment with only `WEBRAIN_MCP_URL` behaves exactly as before, and the pool activates when
`WEBRAIN_WORKER_POOL` is set.

---

## HAZARD (verified 2026-10-04) — a profile does NOT outlive its machine, so "log in once" is not buildable yet

The ask was to exploit webrain's profiles: create one, log in, reuse it. Three verified facts say that
cannot work on the current machine model, and the failure mode would be a feature that looks like it works.

1. **webrain's vault and profiles are PROCESS-GLOBAL, not per-session.** *"The unit of tenancy is the
   container, not the MCP session. webrain's vault and profiles are process-global; that is why free tenants
   get `WEBRAIN_NO_STATE=1` and paid tenants get their own container."*
   (`docs/ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md:111`). That is deliberate and correct — and it means a
   profile is scoped to exactly ONE container.
2. **There is no volume.** `BuildConfigMap` sets no `mounts` (`deploy/browser-session/Dockerfile:47`).
3. **And Fly resets a stopped machine's root filesystem to its original state** (same comment, verified
   there). The vault is not merely ephemeral, it is *erased* on stop — and stopping idle machines is the
   reaper's entire job.

So today a profile lives only as long as one un-suspended machine, against a 15-minute idle reap. A UI
offering "Create profile / Log in" that silently loses the profile when the machine is reaped is the same
class of defect as the `/api/extract` leak: it returns something plausible and wrong.

### The storage decision, which is the real blocker

| Option | Blob lives in | Key lives in | Verdict |
|---|---|---|---|
| In-container sqlite only | the container | the container | **today's state.** Dies with the machine. Acceptable ONLY if we promise *session-scoped* logins and say so in the UI |
| Fly volume | a Fly volume | the container | `BuildConfigMap` must grow `mounts`; ties a profile to one machine and one region; no BYO, no cross-region |
| **Object storage + envelope encryption** | the tenant's bucket (`resolveBlobStore`, including their own S3) | **Secret Manager**, one key per tenant | **recommended** — it is the SAME five moves BYO storage and BYO compute already use: credential in Secret Manager, non-secret config in Firestore, a resolver, fail closed, and a public shape with no field a credential could occupy |
| Secret Manager for the blob | — | — | **wrong tool.** It is for few, versioned platform secrets. A per-tenant cookie jar is thousands of secrets, every read billed and audited, and size-capped |

This is not new machinery: `resolveBlobStore` already picks platform-or-tenant storage and already refuses
to fall back silently. What is new is an envelope — the vault blob encrypted under a per-tenant data key,
and the KEY, never the blob, is what Secret Manager holds.

**Do NOT build the profiles UI before the storage decision.** A profile surface belongs beside the sessions
it serves (`/browser`, next to `browser-session-panel`), not in admin — but putting it anywhere before the
vault can outlive a machine only makes the loss harder to see.

## The webrain tool surface, catalogued (2026-10-04)

`functions/src/domain/webrain-tools.domain.ts` is the authoritative list, because the gateway allowlist IS
the tenancy boundary. Anything in neither set is refused `unknown-tool` — that is the allowlist working,
not a gap. Twenty tools in two sets:

| Tier | Tools | Why there |
|---|---|---|
| Shared (`SHARED_POOL_TOOLS`) | `guide`, `scrape`, `search`, `serp`, `extract`, `pdf` | one call, one answer, nothing held between calls |
| Paid (`PAID_ONLY_TOOLS`) | `session`, `profiles`, `launch`, `login`, `navigate`, `observe`, `interact`, `crawl`, `batch`, `vision`, `eval`, `eval_in_frame`, `download`, `watch` | three different reasons, and they must not be conflated: `session`/`profiles`/`launch`/`login` hold state ACROSS calls, so only a leased container is safe; `crawl`/`batch`/`navigate`/`interact` are not a confidentiality problem at all but a CAPACITY one; `download`/`watch` are payload-heavy, so the cost is the transfer rather than the concurrency |

`extract` and `pdf` are additionally in `SHARED_UNSAFE_TOOLS`: they read "the current page" and so need an
exclusive worker at ANY tier (see the skill). `webrainHealth` is a probe and must never acquire a worker.

## `BROWSER_MACHINE_IMAGE` — the current value points at the wrong IMAGE (2026-10-04)

`functions/.env` currently reads `BROWSER_MACHINE_IMAGE=deepscrape/webrain:latest`. Two independent faults:

1. **It names the engine, not the adapter.** Every template in the repo says
   `<registry>/<repo>/browser-session:<pinned-tag>` (`functions/.env.example:73`,
   `docs/ENV_CONFIG_MATRIX.md:213`), and the adapter's Dockerfile gives the canonical pair:
   `docker build -t browser-session:<pinned-tag> --build-arg WEBRAIN_IMAGE=<...>/webrain:<pinned-tag>`.
   `webrain` is the engine; `browser-session` is the image that adds nginx on 11235 and bakes all three
   engines. Pointing the variable at webrain's own image is the documented non-starter: it mismatches
   `BuildConfigMap` four ways (port, loopback-only bind, entrypoint `["app"]`, and it answers `/health`
   while the check is `GET /`) and it is not pullable.
2. **`:latest` is mutable, and this image IS the engine cache.** With no volume, a cold start on a floating
   tag can run a different engine than the one that was probed — and the whole musl/glibc chain was a
   runtime that fails per session AT EXEC, never at build. The Dockerfile already refuses a default for
   exactly this reason: *"a floating tag here would silently change which engine every future session
   runs"*.

Use a **pinned** tag on **Fly's own registry**:
`registry.fly.io/deepscrape-browser-session:<git-sha>`.

**Why NOT Artifact Registry — corrected 2026-10-04.** An earlier version of this section recommended
`us-central1-docker.pkg.dev/...` "matching how you push the BFF". That is wrong for this value: Cloud Run and
Hosting pull a private AR repo because they sit in the same GCP project, while a Fly machine is a different
cloud and needs registry credentials configured on the Fly app to pull a private repo. Fly's registry is
org-scoped, so `FLY_APP` pulls `registry.fly.io/...` with no extra machinery — and it is what this repo
already does (`src/app/core/functions/global.fun.ts:287` lists `registry.fly.io/crawlagent:...`;
`docs/ENV_CONFIG_MATRIX.md:334` calls it "the `registry.fly.io/crawlagent` lineage"). The whole sequence —
engine build/push, adapter build/push, secret update, local dev — is now in
**`deploy/browser-session/README.md`**, which that directory did not have before.

**`BROWSER_MACHINE_IMAGE` is set ONCE per environment, not per deploy.** It is a secret version
(`functions/.deploy-secrets.json` -> `firebase functions:secrets:set FUNCTIONS_ENV_JSON`) read at runtime, so
rotating the image is: push a new tag, edit one line, re-run `secrets:set`, restart the BFF. No rebuild.

**For local builds the tag is local and the variable stays EMPTY:** Fly pulls from a registry, so a local
`browser-session:local` is unreachable from a machine. Local development points `WEBRAIN_MCP_URL` at a
locally running container and takes the `use-single` path; an empty `BROWSER_MACHINE_IMAGE` correctly makes
§1.4 refuse a dedicated session rather than pretending one exists.

## FUTURE (recorded 2026-10-03) — a standalone pooling service, and what it changes

Requested by the owner as a direction to keep in mind, **not** work to start. The intent: a separate
browser-pooling service that scales on its own, and that mints **browser session profiles for every
engine** — Lightpanda, Obscura and Playwright — instead of one container per tenant.

None of it is built, and two things in this file have to be reconciled before it is.

**1. It moves routing out of arachnefly.** The `DECISION 2026-10-02` table above is explicit that routing
(`uid → unit`) lives in arachnefly *and* that there is deliberately **no pooling API in webrain**, because
that would couple the engine to the platform. A standalone pooling service is a third answer to the same
question. That is a legitimate evolution — arachnefly currently owns machines, the ownership middleware,
the reaper and cron, and pooling is a different workload with a different scaling curve — but it should be
taken as a decision, not drifted into, because two components owning `uid → worker` is worse than either
one owning it.

**2. A *profile* is a cookie jar, so profiles are tenant data.** This file's own correction stands: tabs
inside one browser share a cookie jar, because cookies and localStorage are profile-scoped and not
tab-scoped. A pooling service that creates and reuses session profiles is therefore pooling **logged-in
identities**, which is a strictly sharper hazard than pooling browsers. Two rules follow, and they are not
negotiable:

- a profile belongs to one tenant and is never handed to another, unless it is deliberately destroyed and
  re-created first — and "deliberately destroyed" means proven, not assumed;
- a profile-carrying session is never recycled on a timer, because recycling it silently logs the next
  tenant in as the previous one.

**What does not change.** I2 still holds: the pool scales on **workers per container, never tenants per
worker** — exclusivity is the safety boundary, not the number of browsers. Order still matters, and
profiles add a step rather than replacing one: per-tenant session id → fail-closed per-worker lease →
queue → **profile ownership and destruction** → more than one worker per container.

**On Playwright specifically.** It is the only engine here that serves frames *and* SPAs — see the engine
split above, where Chrome is already "the only engine for SPAs and challenges" and Lightpanda can never
serve a frame. So Playwright is the natural way to make the pool frame-capable, and it needs a per-engine
browser bundle and a Node runtime in the image. The Obscura render build stays the volume fallback rather
than a replacement for it.

**Four things the wiring had to get right, recorded because each is a trap:**

1. **`webrainHealth` must NOT acquire.** There are two `baseUrl()` call sites in that file and the second is
   the liveness probe. Leasing there would burn a worker on a `/health` request that cannot use one, and a
   monitor polling it would exhaust the pool *while reporting everything healthy*. It keeps `baseUrl()`, with
   a comment saying why, so a later "consistency" fix does not wire it.
2. **`transportFailure` no longer derives its message from `baseUrl()`.** It used to override with
   "WEBRAIN_MCP_URL is not configured" whenever that variable was empty — correct while it was the only
   worker source, and wrong the moment a pool can be configured with it deliberately empty.
3. **The release sits in a `finally` around the request only**, not around parsing: a worker is free the
   moment its body has been read, and the `finally` also covers the `return` in `catch` — the path that
   would otherwise strand a worker for the full TTL.
4. **The lease covers browserless tools too, and that is I2's reading rather than an oversight.** The
   isolated unit is the **worker process**, and `/extract` and `/pdf` read that process's *current page*;
   letting two tenants share a worker for "safe" browserless calls would share the very process state that
   makes the browser calls unsafe. The cost is real and worth stating plainly — with a pool configured,
   throughput per worker is one call at a time — which is why the pool stays opt-in.

**NOT VERIFIED: none of this has run against a live engine with a pool.** The claim path needs Redis, and
an unconfigured Redis refuses by design, so a local run exercises the refusal branch and the `use-single`
branch but *not* the claim. Confirming the claim needs one real worker plus a configured Upstash instance.
