# 15 — Chat write tools, and the approval seam that has to exist first

Status: **plan, 2026-10-15. None of this is built.** Measured against the index at
2026-10-12T21:30:46Z (22,369 nodes / 42,206 edges), `check_index_coverage` clean on all eight
files this touches.

## Why this exists

The chat can read and cannot act. That is not an oversight: `chatai.component.ts` runs a
model's tool call the instant it parses it, and there is no confirmation step anywhere in the
loop — a grep for `confirm|approve|approval|pending` across the tool layer returns **nothing**.

A read tool is safe under that. A write tool is not, for two reasons that compound:

- every write here is either money (`machines.deploy` = 5 credits, a session meters per
  5-minute block) or destruction (destroy machine, close session); and
- the **same context** carries `scrape` / `navigate` / `observe` output — text a third party
  wrote.

Exposing `destroy_machine` beside `scrape` makes prompt injection a billing primitive. So the
enabling change is not a tool. It is the seam.

## 1. The approval seam — one boolean, one branch

| File | Change |
|---|---|
| `core/functions/ai-tools.fun.ts` | `AiToolSpec` gains `requiresConfirm?: boolean` |
| `core/functions/ai-tools.fun.ts` | `resolveToolCall()` returns it — already the one place a model's call meets a tool spec |
| `pages/user/chatai/chatai.component.ts` | `dispatch()` gains ONE branch: a tool needing confirmation does not fire, it is pushed to a `pending` signal and the loop stops |
| `pages/user/chatai/chatai.component.html` | render the pending call — name plus **verbatim arguments** — with Confirm / Cancel |
| `pages/user/chatai/chatai.component.ts` | Confirm runs the FROZEN call; Cancel feeds a synthetic tool result (`"the user declined"`) so the model can answer |

No server change. No new route. No approval token.

### Why there is no server-side approval token

The client already holds the user's ID token and can call the route directly, so a token minted
on approval proves nothing a principal who can drive the client could not forge. Authorization
is the route's `guard([...])`, which already exists and does not move. **Approval carries
intent, and intent belongs to the principal, not to the server.** A token here is security
theatre that adds a subsystem and changes no attacker's options.

What IS worth adding server-side is one **audit field**: after the fact, "was this destructive
call human-confirmed or model-initiated" is worth being able to answer. That is a log line,
not a control.

### The two properties that are the actual control

1. **The arguments, verbatim and untruncated.** The click is worthless if the human cannot see
   `{machineId: "bs-abc123"}` in full. The display is the control; the button only records the
   decision. A truncated argument list converts a consent screen into a rubber stamp.
2. **Execute the FROZEN call.** Between display and confirm there is a window. If the loop
   re-derives the call from the model on resume, a page fetched in between can change the
   arguments *under a consent the human already gave*. Store the call, run the stored call.
   This is the one TOCTOU window in the design and it fails silently.

## 2. The tools, by blast radius

### Group A — session and machine lifecycle (your explicit ask)

Stop is the **safe** direction: it reduces spend. `close` stops the meter, `suspend` and `stop`
release compute.

| Tool | Route | Confirm | Note |
|---|---|---|---|
| `stop_session` | `POST /api/browser/session/:id/close` | yes | stops the meter — the money-safe action |
| `stop_machine` | `PUT /api/machines/machine/:machineId/stop` | yes | |
| `suspend_machine` | `PUT /api/machines/machine/:machineId/suspend` | yes | |

**Expose those three. Do NOT expose `destroy`** (`DELETE /api/machines/machine/:machineId`) —
and this is a real line, not caution. Session machines appear in the same list, and destroying
one does not end the session: the record survives and `chargeSessionMeter` bills **from the
record**, so the customer keeps paying to the ceiling with nothing left to connect to. That is
why `refuseSessionOwnedAction()` exists. If a chat tool is added it must route through the same
guard, never around it.

**VERIFIED 2026-10-15 — and it reorders this group, because the blocker is a prerequisite rather
than plumbing.** The guard is a `protected` method on `MachinesComponent`
(`machines.component.ts:298`) and its wrapper raises a snackbar, which is UI. The reusable part
is the predicate it calls: `this.isSessionMachine(machineId)`. The client methods a tool would
call live one layer DOWN, on `DeploymentService` (`suspendMachine:174`, `stopMachine:193`),
which knows nothing about sessions or about which machines a session owns.

So a chat tool calling `deployment.stopMachine(id)` reaches the machine with the guard **not in
the path** — and that is exactly the hazard this section forbids: a session's `bs-<id>` machine
stopped while its record survives and `chargeSessionMeter` keeps billing it. Copying the check
into the chat would be a second definition of the rule, which is how two definitions drift.

**Prerequisite DONE, and both tools are BUILT (2026-10-15).** The rule now lives in
`core/functions/machines.fun.ts` as `hasSessionBacking()` — a TYPE PREDICATE, so a caller reading
`sessionId` afterwards gets it narrowed to a string instead of casting — plus `sessionOwning()`,
which returns the owning session id so a refusal can route the caller somewhere rather than
dead-ending. Both callers use it: `MachinesComponent.loadMachineKinds` builds its map with it, and
the chat's `machineAction()` consults it before `deployment.stopMachine`/`suspendMachine`.

The rule keeps BOTH conditions — kind `browser-session` AND a `sessionId` — because a session row
carrying no session id has no panel entry to hand the user, so refusing an action on it would
refuse and offer nothing back. It is deliberately NOT the `bs-` name prefix, which nothing
enforces and which this data uses to decide whether a destructive action is offered. Five specs in
`machines.fun.spec.ts` pin that, including the name case and a stray `sessionId` on a container row.

The table above is therefore true rather than aspirational: both are one catalogue entry plus one
dispatch case, both `requiresConfirm`, and a session-owned id comes back as prose naming the
session to end instead.

### Group B — storage

| Tool | Route | Status |
|---|---|---|
| `save_file` | `POST /api/storage/save` | route exists |
| `delete_file` | — | **no `/api/storage/delete` route.** Measured: the 50-route write inventory holds `storage/save`, `storage/presign`, `storage/settings` and no delete |

So `delete_file` needs one new route — and that is the whole gap, because **the capability
already exists below it.** `s3-blob-store.ts:579` sends `DeleteObjectCommand`, and its own
comment records exactly the property a delete tool needs: *"`DeleteObject` is idempotent by
specification"*, with a spec asserting it. A model calling delete twice is therefore a no-op
rather than a bug. The work is the route and its spec, not the storage layer.

**Never expose `presign`.** It mints a 5-minute credential, and a credential in a tool result
is a credential in the transcript *and* in the model vendor's logs. Same rule as AI keys, below.

### Group C — settings

| Setting | Expose? | Why |
|---|---|---|
| Model selection | ✅ yes | reversible, high value, and `setAIModel` already exists — it is the picker's own writer |
| Spend cap | ✅ with confirm | it is money, and the *increase* direction deserves the same click as a spend |
| **AI key** | ❌ **NEVER** | see below |
| Proxy | ❌ not yet | see below |

**`set_ai_key` must never be a tool.** A key passed as an argument is a key in the transcript,
in the model vendor's logs, and in the provider's request logs. The settings UI is the only
place a key may be entered, and that is a correctness rule rather than a preference.

**A per-user proxy is a trust-boundary decision, not a convenience.** `/api/webrain/config/proxies`
is `perm('platform','write')` because the proxy chooses the **worker's egress** — the domain
layer calls it "the one thing the platform reserves for itself". A user-level proxy decides
which IP your crawls appear from and who can correlate them. That needs its own decision before
it needs a tool.

## 3. Never a tool, at any confirmation level

- `webrain_eval`, `webrain_eval_in_frame` — arbitrary JavaScript on a platform worker.
- `DELETE /api/machines/machine/:machineId` — strands a billing record (Group A).
- `/api/storage/presign` — mints a credential.
- `setMyAiKey` — secret into model context and third-party logs.
- `DELETE /api/orgs/:orgId/members/:userId` — destructive across principals, not just the caller.
- `POST /api/webrain/config/token` — a platform-wide engine secret.

## 4. What breaks at a thousand users

Not a wish list — each is already recorded in this repo, and each is a ceiling.

1. **No queue.** Fly's Create Machine is ~1 request/second scoped by **APP**, which every tenant
   shares, so the platform can create ~1 machine/second and a sustained backlog answers
   `capacity_unavailable`. This is the first hard wall: a marketing spike 429s paying
   customers. The fix is the queue in `06`'s "future direction" step 3, and it is the only item
   here that needs a new service.
2. **The reaper is one Go process on `@every 1m`,** iterating machines to find idle ones. One
   process, thousands of machines, once a minute. It is also the only thing standing between an
   idle machine and an unbounded invoice.
3. **The fps cap is per-INSTANCE.** It is a module-level `Map`, so N warm Cloud Run instances
   permit N times the tier's fps. At scale that is an N-times billing gap on the frame route.
4. **The meter sweep reads per caller** (2 reads per caller per run, every 5 minutes) with no
   pagination. Bounded by who holds a live session, so smaller than it sounds, but unbounded.
5. **`ADMIN_SESSION_LIMIT` is 500** with truncation and no paging — an operator past 500
   sessions sees "500, truncated".
6. **The chat is stateless** (no server-side transcript). A feature, not a bug: no per-user
   state to scale. But it means no cross-device history and no server-side record of what the
   model was told — which matters the moment a write tool exists and you want to review a
   decision.

## 5. Order

Each step is inert without the one before it.

1. **The seam** (§1) — 4 files, no server change, and it is what makes everything below safe.
2. **Group A** — the three stop/suspend tools; highest value, lowest blast radius, and they
   reduce spend rather than raising it.
3. **`available: boolean` → a reason union** so the chat can say *upgrade* versus *not built*.
   Today `vision` is off for a paid caller who would succeed at it, and the UI cannot say so.
4. **Group B**, starting with the missing delete route.
5. **Group C** — model selection first; keys never.
6. **The queue** (§4.1) — the only step that is architecture rather than surface. Start it when
   deploy 429s become a real support ticket, not before.

## 6. What this plan does NOT claim

- The chat cannot act until §1 ships. Today every one of its enabled tools is a read, and that
  is measured, not assumed.
- Nothing here has been run against a live engine. `navigate` and `observe` in particular ship
  as `EXCLUSIVE_PAID_TOOLS`, so they refuse on a single unleased worker and are useful only
  from a pooled lease — unproven end to end.
- `check_index_coverage` came back clean on all eight files, so the index is **not** the
  constraint. What is missing is unbuilt surface, and "no recorded issue" is not proof of
  completeness.

## 7. Status — what shipped (2026-10-15)

The tables above are left as measured; this is what landed, so the two can be compared.

| Step | State |
|---|---|
| §1 the seam | shipped — `requiresConfirm` on the write family; `runTools` parks the batch |
| §2 Group A | shipped — `stop_session`, `stop_machine`, `suspend_machine` |
| §2 Group B | shipped — `delete_file` (its route added) and `save_file` |
| §2 Group C | shipped — `set_spend_cap`, then `set_model` when the user asked for it |
| §5 step 3 (reason union) | shipped 2026-10-15 — `ToolBlock`, and `vision` now reaches a paid caller |
| §3 never-list | unchanged |

**The reason union shipped (2026-10-15), and it turned out not to be only a label change.**
`available: boolean` had no way to express "a paying caller may, a free one may not", so `vision` —
a paid route that works for a paid caller — was switched off for EVERYONE, with nothing on screen
to say why. It is now `available: true, paidOnly: true` and resolved against the caller's access
mode through `isPaidPlan`, the predicate the AI key panel already gates on, so a tier the key
panel calls paid cannot be a tier the tool list calls free. The three tools that stay off name a
`blocked` reason instead (`session` / `unbuilt` / `spend`), and the refusal handed to the model
names the REMEDY: "not available here" was true in all four cases and useful in none, since it
either talks the user out of a capability they could have had or promises an upgrade that would
not have helped. **The offer gate is not the boundary** — the route still enforces the plan, so the
worst a bug here can do is withhold a capability. `refusalText` keeps its name and its three
reasons; `notOfferedText` is the new pure function the spec pins per `ToolBlock`, and the
"every unavailable tool names a reason" invariant is pinned by a spec because the type cannot
express the pair. Gates: app TSC 0 (app + spec), `bun run build` 0, suite **859 SUCCESS** (was
854).

`save_file` and `set_spend_cap` were added after the tables were written and took the same shape
as `delete_file`: a catalogue entry, `requiresConfirm: true`, and a dispatch case pointing at an
existing service method. **Neither needed a new backend** — the backend behind them is
`POST /api/storage/save` and `PUT /api/billing/policy`, both already served by `bff/api.ts`.
The offered surface is now 15 tools, 6 of them writes.

Two decisions worth not re-litigating:

- **`set_model` was built on request, and its one unusual property is the point.** It is the only
  tool with no route: it sets the same FORM CONTROL the user's own picker sets, so the change is
  visible in the dropdown as it happens, behind `requiresConfirm` like every other write. Two
  details are not obvious. It matches on `AIModel.name` (the id sent to the vendor) and NOT
  `.code`, which is the VENDOR and is shared by every model from it — matching on `code` would
  silently select whichever model happened to be first. And a value that matches nothing is refused
  WITH the list, because the list is dynamic (two passes, per-vendor) and no static description can
  enumerate it. `AiToolSpec.path` gained a named sentinel, `CLIENT_SIDE_PATH`, because the suite
  asserts every other path starts with `/api/` — the exception is stated and pinned to exactly one
  tool rather than spelled as a magic string.
- **`set_spend_cap` is the caller's own policy, never an org's,** and `spendCapCredits` is
  **credits rather than money** — which is why the parameter is named for the unit and the client
  refuses a float instead of rounding to a cap the user never approved.
