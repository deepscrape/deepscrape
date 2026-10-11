# Refactor priorities — ranked frontend → backend

Ranking principle: **harm removed per unit of effort**, with a bias to *deleting* code and to
making a failure impossible rather than handling it. Anything not verified in source is marked
**MEASURE** rather than asserted.

## Tier 0 — one-line fixes, already verified (minutes, near-zero risk)

| # | Area | Change | Evidence |
|---|---|---|---|
| 0.1 | `functions/src/config/env.ts` | `SCRAPE_PROVIDER` defaults to **`webrain`**, and the comment directly above says *"`'crawl4ai'` (the default)"* and promises an unconfigured deployment behaves "byte-for-byte as it was". Fix the comment **or** the default — currently the code and its own justification disagree. | read 2026-10-10 |
| 0.2 | `src/app/core/variables/deployment.var.ts` | Delete `API_ARACHNEFLY_UPLOAD_URL` (+ its import in `deployment.service.ts`). Dead three ways: both ternary branches are the identical string, it appears once as an unused import, and no BFF route or Hosting rewrite serves `/upload/machines`. | read 2026-10-10 |
| 0.3 | `src/app/core/types/crawl.interface.ts` | Delete `CRAWL_PROVIDERS` — exported, never consumed. | grep, whole tree |
| 0.4 | `functions/src/handlers/machines.ts` | Rename/move. It is **not a handler table**, it is the arachnefly client; the name has already misled this repo's own skill twice into looking in the wrong file. Zero behaviour change, real future-error reduction. | skill corrections ×2 |

## Tier 1 — robustness, contained

| # | Area | Why it matters | Cost |
|---|---|---|---|
| 1.1 | Firestore indexes | Two collection-group indexes (`state`, `idleDeadline`) are **declared but undeployed**. The emulator does not enforce indexes, so the runtime verification proves query semantics only; production can answer `FAILED_PRECONDITION` on the first live sweep — which the admin page would render as **"no sessions"** while customers are billed. Deploy, or delete the declarations. | low |
| 1.2 | Frontend ↔ websocket | The task-status channel goes to `wss://agent.deepscrape.dev/api/v1/ws/events` — **outside the BFF**, so no guard, no entitlement and no metering sits in front of it. The BFF serves **no `/ws` at all**, so this is a build, not a redirect. Biggest robustness gap on the frontend. | high |
| 1.3 | New MCP route | `POST /machine/mcp/:id` is built, and it lets the BFF drive arbitrary MCP on a tenant machine — bypassing `decideWebrainTool`'s tier allowlist. Defensible only because the machine is leased to one tenant. Add the **fps constant** (paid 2 / admin 4 / free none) and decide whether the tool allowlist should be re-asserted at this layer. | low–medium |
| 1.4 | webrain | Load-bearing work is **uncommitted** (`docker/Dockerfile` fixes, `install.rs` timeout, `main.rs` `floor_char_boundary`), so **no tagged release contains the auth gate**. Commit. | low |

## Tier 2 — real compression (delete code, lose nothing)

| # | Area | What to cut | Note |
|---|---|---|---|
| 2.1 | `functions/src/infrastructure/syncaiapi.ts` | Its `this.router.*` registrations are **never mounted** — `index.ts` imports no Express app and every Hosting rewrite goes to Cloud Run `deepscrape-bff`. Keep only the middleware the BFF binds; delete the route registrations. **Potentially the largest single deletion in the repo.** | **MEASURE** the count first |
| 2.2 | neko / WebRTC stack | **Superseded 2026-10-10.** `nekoUrl` is deleted from all four environment files and `app-browser` is unmounted from the dashboard; `browser.component.ts` now takes `@Input() endpoint` from the caller and **throws** when none is supplied, so a fixed host cannot return silently. The component, `WebRtcService`, the clipboard/control/resolution children and the protocol types are **kept as a reference implementation** (owner: "keep it as information github repo") — upstreams in `09`. What remains is optional consolidation, not a wiring task. | **DONE (wiring)** |
| 2.3 | crawlagent pool surface | `/contexts/*`, `/janitor/*`, `/displays`, `/display_metrics`, `/memory_stats` are a draft, and their **context** model shares one browser process — I2 forbids promoting it as-is. Trim to what a worker-per-lease model actually needs. | draft, owner said leave |

## Tier 3 — structure (measure, then change)

| # | Area | Signal |
|---|---|---|
| 3.1 | `core` ← `app` dependency | The graph shows `app → src` 75 calls and **`src → app` 13** — a reverse dependency from core into the app layer, i.e. a cycle. **MEASURE** to confirm which symbols cross. |
| 3.2 | RxJS import style | The repo declares deep imports (`rxjs/internal/operators/map`) as the convention and applies it inconsistently — `operations.component.ts` and others import from `rxjs` directly. Consistency, and deep imports help tree-shaking. |
| 3.3 | `AiKeysService.describe` | Fan-in **213** — the single hottest symbol in the codebase. Either a genuine hub worth splitting or a graph artefact. **MEASURE.** |
| 3.4 | Tooling | The code graph is blind to templates: **85 unusable ranges, all `.html`/`.scss`** (75 `parse_partial` + 10 `parse_unusable`). Not a code defect, but it is why template claims always need grep + `bun run build`. |

## Tier 4 — feature gaps (not compression; listed so they are not mistaken for waste)

- ~~`GET /api/pricing/estimate` (roadmap `07` Part F)~~ **built 2026-10-11** — it was the route that was missing, not the code. See `08-production-readiness.md` §3.2.
- Vault durability → routes → UI (Phase 4 §4.1), in that order. Blocked on a **volume**, not on will.
- Frames: the transport is now built; what is left is the BFF route and the fps number.

## Do NOT do (recording so it is not re-proposed)

- **Do not add a per-pack provider chooser.** `SCRAPE_PROVIDER` selects the engine server-side and roadmap `03` §B.9 establishes the axes are deliberately separate.
- **Do not build the profiles UI before the vault can outlive a machine.** A profile that vanishes on suspend is worse than no profile: the customer only discovers it after trusting it.
- **Do not promote crawlagent's pool.** Its context model shares one browser process; I2 forbids it whatever it is named.
- **Do not "fix" the proxy into an MCP path.** `proxy.Do` rebuilds the URI from its address, so the path can never survive — which is why `POST /machine/mcp/:id` exists as its own route.
