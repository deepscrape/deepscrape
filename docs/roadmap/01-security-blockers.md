# Phase 0 — security blockers

**Nothing else ships before this.** Every item here is a security fix, not a feature, and each is
independent of the platform roadmap. Phase 1 makes all of them worse if you skip them.

---

## 0.1 arachnefly: bind machine id to owner uid

### Why this is first

`arachnefly` has **no ownership check on any route that names a machine.** The per-user Firestore scoping
is real (`users/{userID}/machines/{machineID}`) but it does not gate the Fly call, and because
`UpdateDocument` is a Firestore `Update` that fails on a missing document, a cross-tenant call performs
the Fly operation and *then* answers `500` — a false failure that masks the side effect.

Anyone authenticated, holding a machine id, can read it, start it, suspend it, stop it, delete it, run a
crawl task on it, and HTTP-proxy into its container.

### The evidence, per route

| Route | Handler | reads uid | compares owner | note |
|---|---|---|---|---|
| `POST /deploy` | `DeployMachine` | yes | n/a | `clone&master_id` copies **any** machine's image + env |
| `POST /execute-task/:machine_id` | `ExecuteTask` | **no** | **no** | never reads a uid at all |
| `DELETE /machine/:id` | `DestroyMachine` | yes | **no** | Fly `DELETE` runs **before** the per-uid write |
| `PUT /machine/:id/start` | `StartMachine` | yes | **no** | Fly call first, `UpdateMachine` after |
| `PUT /machine/:id/suspend` | `SuspendMachine` | yes | **no** | Fly call first |
| `PUT /machine/:id/stop` | `StopMachine` | yes | **no** | Fly call first |
| `GET /machine/:id` | `GetMachine` | **no** | **no** | returns the machine and its resolved IP |
| `GET /machine/proxy/:id` | `HandleContainerProxyFiber` | **no** | **no** | sets `X-Authenticated-User-Id: "userID"` (a literal) |
| `GET /machine/waitforstate/:machineId` | `waitForState` | **verify** | **verify** | id-named, treat as in scope |

The uid is available on every request: `FireAuthMiddleware` sets `c.Locals("userID", decodedToken.UID)`.
The only registered validator is `hexadecimalan` (`^[0-9a-fA-F]+$`), which covers the id **format** —
there is no ownership validator and adding one is the wrong tool, because a validator cannot read
Firestore.

### Steps

1. **Add one helper** beside the existing routines, e.g.
   `assertMachineOwner(ctx, machineID, userID) error` that loads the machine and returns a typed
   `403` when `metadata.user_id != userID`, and a `404` when the machine does not exist. **404 for
   not-found, 403 for not-yours**, so the response cannot be used to discover that a machine exists.
2. **Call it as the first statement** in `GetMachine`, `StartMachine`, `SuspendMachine`, `StopMachine`,
   `DestroyMachine`, `ExecuteTask`, `HandleContainerProxyFiber`, `waitForState`.
3. **Reorder `DestroyMachine`** so the check precedes the Fly `DELETE`. This is the one place where a
   wrong order is a data-destroying bug, not a cosmetic one.
4. **Make `ExecuteTask` read the uid** — it currently reads none, so there is nothing to compare.
5. **Fix `HandleContainerProxyFiber`**: set the real uid, not the string `"userID"`. Anything downstream
   currently trusts that header is trusting a constant.
6. **Decide `clone&master_id`.** It copies another machine's image and env, so it is a config-disclosure
   path even after ownership lands. Either require that the master machine is also owned by the caller,
   or drop `clone` from the hosted API.
7. **Do not log every started machine** in `ExecuteTask`.

### Acceptance criteria

For each machine-naming route, with a **stub Fly client** (not a live one):

- a request whose uid does not own the machine returns **403**, and
- **the Fly API stub was never called** — assert the call count is zero, not just the status code, and
- the owner's own request still succeeds, and
- a machine id that does not exist returns **404**.

The stub is the part that matters: asserting only the status leaves the "Fly call happened first" bug
in place and green.

---

## 0.2 The worker token must be set, and shared workers must be stateless

### Why

`webrain-mcp.ts` builds auth headers as `token ? {...} : {}` — an empty token sends **no `Authorization`
header at all** — and webrain treats unset/empty/whitespace `WEBRAIN_HTTP_TOKEN` as *"no auth"*. Meanwhile
`docker/docker-compose.yml` sets **only** `WEBRAIN_HTTP_ADDR`, and its own comment concedes the point:

> *"the unauthenticated MCP endpoint must never reach the LAN"*

The production app is publicly routed — `ExecuteTask` targets `https://{flyApp}.fly.dev/crawl` with
`fly-replay` — so a tokenless worker behind a public service is an open MCP endpoint with the vault and
the whole session family reachable.

### Steps

1. Set `WEBRAIN_HTTP_TOKEN` on **every** deployed machine (a real secret, rotated on a schedule).
2. Set `WEBRAIN_NO_STATE=1` on **any shared** worker. (Verified fixed in webrain: `STATEFUL_TOOLS` now
   contains the umbrella `webrain_session`, and the outer HTTP layer has its own guarded arm above the
   unguarded twins.)
3. Set `WEBRAIN_MCP_TOKEN` on the BFF — via the `WEBRAIN_CONFIG` Secret Manager entry or env.
4. **Add both vars to `docker/docker-compose.yml`** so the documented path cannot ship tokenless.
5. ~~**Document `WEBRAIN_MCP_URL`, `WEBRAIN_MCP_TOKEN` in the env templates.**~~ — **done.** Both are in the
   root and `functions/` templates, inside a `── Browser sessions ──` block, alongside
   `SCRAPE_PROVIDER` and `BROWSER_MACHINE_IMAGE`. *(`env.ts` confirms `WEBRAIN_MCP_URL` defaults to `""`
   and `WEBRAIN_MCP_TOKEN` has no default.)*
   **CORRECTED 2026-10-03 — the note that used to sit here was wrong.** It claimed
   `WEBRAIN_PROXY_POOL` "is **not** an env var in this repo". It is: `webrain-config.store.ts:178` reads
   `process.env["WEBRAIN_PROXY_POOL"]` as the **fallback** for the proxy pool, with the `WEBRAIN_CONFIG`
   secret taking precedence whenever it resolves. Both it and `WEBRAIN_WORKER_POOL` (`:188`, the
   browser-worker pool from roadmap `06`) are now documented in both templates. The caution underneath the
   old claim still holds for genuinely unread variables — which is why `UPSTASH_REDIS_TCP_ENABLED` (zero
   readers since the ioredis client was deleted) was removed from the templates in the same pass.

### Acceptance criteria

- `webrain/scripts/probe_http_transport.ps1` passes with the token set and **401s with it absent or wrong**.
- A shared worker refuses every session op: run the probe with `WEBRAIN_NO_STATE=1` and confirm
  `session(op=list)` is refused (this is the exact leak that was live).
- With `WEBRAIN_NO_STATE` **unset**, `op=list` works again — prove the guard is a guard, not a removal.

---

## 0.3 Fly service config: drop 6379, keep 11235 private

The machine template exposes **80, 11235, 443 and 6379 (Redis)**. Redis has no business on a public
service, and `GET /machine/proxy/:id` proves 11235 is meant to be reached over
`http://{machine_id}.vm.{flyApp}.internal:11235` — i.e. private.

**Steps:** remove 6379 from the Fly services list; confirm 11235 is not publicly routed.

**Acceptance:** `fly services list` shows no public 6379; a public request to the app host on 11235 fails;
`GET /machine/proxy/:id` still works for the owner.

---

## 0.4 `cdp_url` is an SSRF primitive

`CdpBackend::connect_with_url` accepts `ws://`/`wss://` or issues a blind `GET {url}/json/version`, with
**no allowlist**. Callers inject it three ways: `session(op=open, cdp_url=…)`, `batch.cdp_urls[]`, and the
`CDP_URL` env. Launched browsers bind loopback only; the *attach* side is unconstrained.

From a machine that can reach `.vm.{app}.internal` and 6379, an arbitrary CDP URL is a network primitive —
and CDP itself is full control of whatever browser answers, including `Network.getCookies`.

**Steps:** on the hosted path, either
- **allowlist** `cdp_url` to an approved set of hosts (the BYO-CDP providers you choose in Phase 3), or
- **refuse** `cdp_url` for shared workers entirely, and permit it only on a caller's own dedicated machine.

**Acceptance:** a `cdp_url` naming `169.254.169.254`, `127.0.0.1`, or `*.internal` is refused with a named
error and never dialled — assert with a request-spy, not by reading the status code alone.

### Status — audited 2026-10-16: closed for every REACHABLE vector

The `CDP_URL` env is the operator's own (`flyctl secrets`), not a caller input, so only the
caller-facing vectors need a guard. All three have one today.

| Vector | Guard |
|---|---|
| `session(op=cookies\|setcookies, cdp_url=…)` | `cdpEndpointFrom` (`url-guard.domain.ts:171`) via `vaultArguments` (`handlers/webrain-tools.ts:862`) |
| a dedicated/BYO machine's endpoint | `decideCdpUrl` (`browser-session.domain.ts:183`), called from `browser-session.store.ts:225` |
| `batch.cdp_urls[]`, routed at `/api/batch` since 2026-10-16 | `cdpEndpointsFrom`, the list sibling — one bad entry refuses the whole call |
| `CDP_URL` env | operator only — not a caller input |

Both guards are built on `isBlockedHost`, and `BLOCKED_HOST` already carries `.*\.internal$`, `127\.`,
`169\.254\.` and the non-routable IPv6 families. The acceptance is asserted at both layers — the predicate
(`url-guard.domain.spec.ts`, "refuses a ws endpoint that private space could serve") and the route
(`webrain-vault.spec.ts`, "refuses an endpoint it cannot use instead of dropping it", which answers 400
rather than silently dropping the field).

**BYO CDP is intact, and deliberately so.** The same specs assert that `wss://chrome.browserless.io`,
`wss://connect.browserbase.com`, `ws://chrome.example.net:9222` and the `http(s)` spellings are forwarded
unchanged. The control is "not private space", not "not user-supplied" — which is why closing this blocker
removes no feature.

### Residuals — both outside the TypeScript layer

1. **The worker's filesystem.** `batch.dir`, `crawl.crawldir` and `download.args` are REFUSED at the
   gateway (asserted in `webrain-capacity.spec.ts`), so through this API the platform owns those locations.
   `args` is the sharpest of the three: it is forwarded to ytdlp, a tool that writes files and accepts
   `--exec`. This is a gateway decision and not a worker one — a direct caller of the worker still reaches
   all three, so closing it properly means the worker refusing a caller-chosen path.
2. **DNS rebinding.** `isBlockedHost` judges the **host**, not where it resolves, so `wss://evil.example.com`
   pointing at `169.254.169.254` passes. This is documented in `url-guard.domain.ts`'s header and cannot be
   fixed here: the check runs before the request and the dial happens inside the worker. Enforcement belongs
   in `CdpBackend::connect_with_url` (resolve, then refuse private results) — the webrain repo, the same
   place `docs/RESIDUAL-RISK-CRAWL-TRUST-BOUNDARY.md` §6 already names for crawl targets.

---

## 0.5 Optional, cheap, and worth it: pre-check on our side

`functions/src/handlers/machines.ts` already funnels all nine handlers through a single
`forwardToArachnefly`, and it relays the caller's token. Reading `users/{uid}/machines/{id}` there and
returning **404** before the upstream call costs one Firestore read and blocks every cross-tenant request
before it leaves our network.

This is **defence in depth, not the fix** — the authoritative check is 0.1, because arachnefly is the only
component that covers every caller including future ones. But it is our own service, our own test, and it
fails closed even if arachnefly regresses.

---

## Phase 0 exit criteria

- [ ] Every machine-naming route returns 403 cross-tenant **with zero Fly calls**, and 404 for unknown ids
- [ ] `destroyMachine` checks before it deletes
- [ ] `X-Authenticated-User-Id` carries a real uid or the header is gone
- [ ] Worker token set everywhere; `WEBRAIN_NO_STATE=1` on shared workers; compose file no longer tokenless
- [ ] 6379 not publicly exposed; 11235 reachable only over the private network
- [x] `cdp_url` refused for private space on every reachable vector, `batch.cdp_urls[]` included (0.4 Status)
- [x] The four capacity tools the worker advertises are routed: `/api/batch`, `/api/spider`, `/api/download`,
      `/api/watch` (`webrain_eval` is deliberately still unrouted — arbitrary JS needs its own container)
- [ ] Gates green: `go test ./...` (arachnefly), webrain `fmt`/`clippy`/`test`, functions `tsc`/`lint`/`test`, bff `tsc`/`test`, app `tsc` + `build` + `ng test --watch=false`
