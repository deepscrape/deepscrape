# Copilot Instructions — deepscrape

## Persona
When I present an idea or architecture proposal, act as a ruthless mentor — challenge it
aggressively. For implementation tasks (writing code, fixing bugs), adopt a precise,
professional engineering tone without editorial commentary.

## Security — absolute constraint (overrides everything below)
Never read, print, parse, log, or include in output: API keys, tokens, secrets, `.env`
files, or encrypted env artifacts. If a task needs a secret, refuse and say why.

---

## What this platform actually is

One product, **four services, one database**. Nothing else is deployed, whatever an older
doc in `docs/` may claim.

| Service | Stack | Process / entry | Deployed to | Owns |
|---|---|---|---|---|
| **app** | Angular 20, zoneless, standalone | `src/main.ts` | Firebase Hosting, 3 sites | UI, guards, i18n, billing views |
| **BFF** | Bun + Elysia | `bff/server.ts`, routes in `bff/api.ts` | Cloud Run `deepscrape-bff` | the CSR shell and **the only served HTTP table**: `/api`, `/event`, `/oauth` |
| **functions** | Node 22, TS, Functions v2 | `functions/src/index.ts` | Firebase Functions | callables, Stripe webhooks, scheduled sweeps, `handlers/*` called **in-process by the BFF** |
| **arachnefly** | Go / Fiber | `main.go` | Fly.io app | Fly Machines: create, proxy, MCP relay, ownership guard, **the reaper** |
| **webrain** | Rust (core, mcp, cli) | `webrain-cli/src/main.rs` | Fly.io engine + portable binary | the browser: CDP/Chrome, Obscura, Lightpanda, vault, tiles |
| **crawlagent** | Python / FastAPI | `pool_manager.py` | VM | legacy Crawl4AI pool: virtual displays, WebRTC, Celery |

Verified route surfaces: arachnefly **16** (`/deploy`, `POST /machine/mcp/:id`,
`/machine/proxy/:id`, start/suspend/stop/destroy, `/check-image`, `/user/:id`),
crawlagent **20** (pool claim/release, contexts, sessions, janitor, WebRTC), BFF ~56
(inventory in `bff/api.spec.ts`).

## The request path — learn this before touching anything

1. Browser asks Hosting. Prerendered routes are **static files**; the CSR shell for the
   `RenderMode.Server` prefixes comes from the BFF. A request that needs logic never
   reaches Angular first.
2. The app calls `/api/*` on the BFF. The BFF imports handlers from
   `functions/src/handlers/*` and runs them **in the same process** — it does not call the
   Functions host. A function that only exists as an Express route is not reachable.
3. Browser work goes BFF → arachnefly → Fly machine → **webrain MCP on :11235**.
4. Money lives in `functions/src/gfunctions/*` and Stripe webhooks; the metered sweep runs
   `*/5 * * * *`. Charging is `applyBillingCreditMutation` with an idempotency key.
5. Queues: QStash publishes crawl targets to the BFF's worker route. That route has no
   cookie jar, so it must stay in the CSRF ignore list — the QStash signature is the auth.
6. Shared state: Firestore (db **`easyscrape`**), Upstash Redis (limits, presence, cache),
   Secret Manager (per-machine and per-user credentials).

## Five cross-service contracts that fail silently

1. **One token, two names.** Engine calls it `WEBRAIN_HTTP_TOKEN`, functions call it
   `WEBRAIN_MCP_TOKEN`. A mismatch is a 401 on every call and presents as "search broken".
2. **`idleDeadline` is written by TypeScript and read by the Go reaper.** Nothing enforces
   agreement; the field is only indexed via a `COLLECTION_GROUP` override. Past it means
   **stopped**, and that is terminal for every extension path.
3. **A session's machine is named `bs-<sessionId>`.** Fly's unique-name rule is the
   idempotency key for provisioning — never invent a second name.
4. **`expiresAt` on `loginSessions` is the only session lifetime.** It is stamped at
   creation, returned by `createLoginSession` and `getMyLoginSessionStatus`, and the client
   counts down to it. Never derive a lifetime from page load.
5. **A scheduled job cannot act as the owner.** arachnefly accepts only a Firebase ID
   token, so the meter asks the reaper for a stop by moving `idleDeadline`, not by calling
   Fly.

## Where a change belongs

| Change | Goes in | Never |
|---|---|---|
| Customer-facing HTTP route | `bff/api.ts` | `functions/src/infrastructure/syncaiapi.ts` — its table is never mounted |
| Logic the BFF runs | `functions/src/handlers/*.ts` | assuming the Functions host reaches it |
| Browser tool exposure | `functions/src/domain/webrain-tools.domain.ts` | inline in a handler |
| Fly machine lifecycle | arachnefly `interfaces/handlers/` | the Angular app |
| Browser launch decision | server-side | the client |
| A secret | Fly secrets / Secret Manager | the repo, a log, a client |

## Angular — non-negotiable

Zoneless (`provideZonelessChangeDetection`): no `NgZone`, no `detectChanges`, no
`ApplicationRef.tick`. Standalone only, no NgModule. Every page component lazy via
`loadComponent`. `ChangeDetectionStrategy.OnPush`. `inject()` over constructor injection.
Guard browser APIs with `isPlatformBrowser(PLATFORM_ID)`. Signals for local state;
`BehaviorSubject` only for shared root-service state. Tailwind + Angular Material only —
no new UI framework, and read `.github/skills/` before writing UI.

## Gates — run every repo you touched

```
functions:   bun run build   |  bun run lint  |  bun run test    (tsx --test)
app:         bunx tsc --noEmit -p tsconfig.app.json  |  bun run build  |  bunx ng test --watch=false --browsers=ChromeHeadless
bff:         bunx tsc --noEmit  |  bun test
arachnefly:  gofmt -l .  |  go vet ./...  |  go test ./...
webrain:     cargo fmt --check  |  cargo test
```

Functions style is enforced and unusual: max line **80**, double quotes, **no
semicolons**, JSDoc with `@param`/`@return` on every function. Commit bodies are capped at
**100 characters per line** by commitlint.

`bun run build` is the **only** validator of Angular templates and of SSR prerendering.
`tsc --noEmit` never parses a template; Karma only compiles components a spec imports.

## Traps already paid for

- A component nothing references escapes `bun run build`, so its template may never have
  been compiled by any gate. Grep the selector before trusting it.
- `get_errors` has reported "No errors found" on files that could not compile. Trust the
  compiler for anything structural.
- Never batch two edits to the same file in one block — it has silently corrupted files
  twice here. Re-read after any structural edit.
- An Angular budget violation prints `ERROR` **and still writes output**. Only the exit
  code is evidence.
- A `proxy.conf.json` entry for a path shadows that Angular route in dev and presents as a
  broken page.
- Hosting's default `Cache-Control` blanked the app for an hour after deploy; HTML,
  `ngsw.json` and `ngsw-worker.js` must stay `no-cache`.
- Headless Chrome reports `document.hidden === true`, so any poll that bails on visibility
  does nothing in tests. Make visibility state, then assert it.
- Firestore CLI commands default to the `(default)` database while the data is in
  `easyscrape`; an empty index list means the wrong db, not a missing deploy.

## Commit and release

`git cz` (Commitizen); commitlint runs on `commit-msg`. Types that release: `feat` minor,
`fix`/`perf`/`refactor`/`revert` patch, `BREAKING CHANGE:` footer major. `ci`, `build`,
`docs`, `test`, `chore`, `style` do not release. One focused commit per concern. Never
edit `CHANGELOG.md` — semantic-release owns it.

## Code graph first

`codebase-memory-mcp` holds all four repos, indexed on their **current branch**: deepscrape
23,635 nodes / arachnefly 1,116 / webrain 2,558 / crawlagent 1,686. Cascade:
`search_graph` → `trace_path` → `get_code_snippet` → read a file only if all three fail.
The graph is a snapshot: a file written since the last index is invisible, so re-index
after adding specs. Two duplicate project entries were deleted; do not recreate them by
indexing the same path under a second name.

`rtk` prefixes shell commands to compress output (`rtk git status`, `rtk cargo test`).

## Further reading, in this order

`docs/roadmap/20-must-fix.md` (status ledger — do not work it in numeric order),
`docs/roadmap/README.md` (sequence), `docs/ADR-2026-09-PLATFORM-ARCHITECTURE.md`,
`docs/ADR-2026-10-BROWSER-SESSIONS.md`, `docs/BROWSER-SESSIONS-EXPLAINED.md`,
`docs/ENV_CONFIG_MATRIX.md`. For vector-memory or multi-agent work, read
`.github/skills/ruvector-ruflo-skill/SKILL.md` first; for graph exposure, the open
questions are in `docs/ADR-2026-09-MCP-SERVICE-EXPOSURE.md`.
