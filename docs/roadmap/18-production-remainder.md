# 18 — Production remainder

**Created 2026-10-16.** This is the plan for what actually blocks launch across all
services. It is not a feature wishlist; every line is either a shipped falsehood, a
published-claim gap, or a thing the product cannot do at all.

## How this was measured, and what was not

Measured: the code graph (architecture counts, hotspots, cycles, clusters), a real
`production` build log, `check_index_coverage` over the roadmap and skill, and targeted
greps.

**Not measured:** no live probes, no Stripe calls, no deploy, no emulator run. Nothing
below claims a runtime behaviour that was not read in source or printed by a build.

Two corrections made while measuring, recorded so they are not re-derived:

- The hotspot aspect's top entry (`AiKeysService.describe`, fan-in 234) is a **name
  collision** with the test-framework global, not a real hotspot. See
  `references/performance-and-efficiency.md` §5.
- `query_graph` (Cypher) is **disabled** in this session, so the 96 `SIMILAR_TO` edges
  were not enumerated. Duplication findings below come from grep, not from that edge
  type. Anything the edge type would have found is still unexamined.

## P0 — the one thing that is untrue today

**A shipped panel states a fact the backend does not honour.**

`settings/general` now renders a Compute box whose active state reads *"Your own Fly
organization runs this account's machines."* That sentence is false. The chain is:

```
caller saves app + deploy token → stored, validated, reflected as active
                                → machines still created in OUR org, on OUR token
```

Because `FlyRequest` in arachnefly still authenticates with the **boot-time**
`FLY_API_TOKEN` from `routers/global.go`. The routes are on branch `next` and
**undeployed**, so nothing is broken for a customer right now — this is a gap that
closes cheaply, not an incident.

**Closed by gating the WRITE. What shipped, and how to reverse it:**

`PUT /api/compute` answers `501 compute_byo_unavailable` for `mode: "byo"` and never reaches
`writeComputeSettings`, so no credential is stored for a config nothing consumes. The box
stays, but states the truth and cannot be submitted: the three inputs are disabled at
construction, Save is disabled, and `SETTINGS_COMPUTE.UNAVAILABLE` says why. Pinned by
`functions/src/handlers/compute.spec.ts`.

**Why not "hide the box" (option 2 as first written):** the false claim was the defect, not
the panel. With the write refused, `computeMode` can only come from a write that succeeded,
so `ACTIVE_BYO` and the `CLEAR` button are unreachable and that sentence cannot render —
while the domain, store, handler and screen all stay in place, one backend change away from
correct. Hiding would have deleted a surface rather than correcting it. Hiding remains
available and is one commit if this reading is wrong.

**Reversal is three places, and each names the others in a comment:** the handler's refusal,
the three disabled `FormControl`s, and B1 in arachnefly.

The two options as first written, for the record:

1. **Wire it** (preferred, and it is the feature people paid for): see B1.
2. **Gate it**: hide the box until B1 lands. Cheaper, but ships a dead setting.

Do not ship with the box asserting a fact and B1 unbuilt. A panel asserting a cost and
privacy fact the platform does not deliver is worse than no panel.

## Backend

### B1 — arachnefly: consume the tenant (P0, closes the lie)

The decision layer exists (`domain/fly_tenant.go`, `DecideFlyTenant`, commit `fc5dc9a`)
and the config source exists (`readFlyTenantConfig` / `resolveCompute` in
`functions/src/infrastructure/compute-settings.store.ts`). What is missing is the join.

Precise seam, established by reading the code rather than guessing: the token is used in
**exactly one place** — the `Authorization` header inside `FlyRequest`
(`infrastructure/routines/global.go`). App and URL are **already** per-call parameters on
`IGlobal` (`ListFlyMachines(appName, flyApiUrl, …)`, `GetMachineDetails(machineId,
flyApiUrl, flyApp)`), so this is not the four-struct rewrite the plan originally implied.

Work:
1. Read the tenant config for the caller's uid and run `DecideFlyTenant`. The uid is
   already resolved by `FireAuthMiddleware` (`decodedToken.UID`), so no new auth work.
2. On `Refuse` → fail the request. **Never** fall back to the platform identity.
3. Thread the resolved token into `FlyRequest`.

**The decision layer is the reason this is safe to do at all**: `DecideFlyTenant` already
separates "nothing configured → platform" from "configured but unusable → refuse", and a
refusal carries no tenant, so a caller cannot read the zero value by accident.

Must land in the **same commit** as B2, per the skill's pricing rule: a BYO organization
pays Fly directly, and charging them platform compute on top double-bills them.

Gates: `gofmt -l .` (empty), `go build ./...`, `go vet ./...`, `go test ./...` — print
`EXIT=$LASTEXITCODE` immediately after each, never after a pipe.

### B2 — billing: `computeSource` in the meter

`computeSourceOf` exists and returns `null` for an unusable config, which is what makes
"refuse before you bill" enforceable by the type. It is not yet **read** by the meter.

Note a live divergence to reconcile rather than ignore: the skill records that the meter
**derives BYO from `machineId` absence**, i.e. "no `computeSource` field is needed". That
was true when a BYO session was one with no platform machine. It stops being true once
B1 lets a caller's work run on *their* machine — which B1 measures as `machineId`
present. So the derivation must move to the resolved source, or the two will disagree
while each looks correct alone. This is the specific drift the "same commit" rule exists
to prevent.

### B3 — `GET /api/pricing/estimate` still does not exist

Roadmap `07` Part F. `GET /api/pricing/rates` exists and the rates page is built from it.
The estimate route has never been written. Low risk, but it is cited in the plan as if it
existed, which is how a gap survives.

### B4 — profiles are not durable (feature gap, not a false claim anymore)

The published copy was corrected (`cc2fcbe`) and no longer promises persistence, so this
is honestly a missing feature rather than a lie. The shape to build is the one BYO storage
already uses: blob encrypted under a per-tenant key in the tenant's bucket via
`resolveBlobStore`, with the **key** in Secret Manager and never the blob. Secret Manager
is the wrong home for thousands of per-tenant cookie jars.

**Do not build a profiles UI before the vault can outlive a machine.** It would only make
the loss more visible.

### B5 — unproven, not broken (do not report these as bugs)

- The `state` collection-group index is declared and **deployed** (corrected 2026-10-16),
  but the emulator does not enforce indexes, so production could still answer
  `FAILED_PRECONDITION` on the first live sweep. The first real sweep is the test.
- The sweep's **cadence** and the **close-route charge** have no harness.
- The reaper is deployed; what is unproven is that it **reaps** (needs a session with an
  expired `idleDeadline`, and none exists).
- The worker pool has never been run against a live engine (needs Redis + a worker).
- `BROWSER_MACHINE_IMAGE` must be repinned to the rebuilt adapter
  (`registry.fly.io/deepscrape-browser-session:browser-session-2026-10-15`). **This is a
  secret write and cannot be done by the agent** — the security constraint forbids reading
  or writing those values.

## Frontend

### F1 — `machines.component.ts` emits untranslated English (P1, no sign-off needed)

13 snackbars build sentences in template literals: `` `Machine ${machine.id} starting` ``,
`suspended`, `stopping failed`, and so on. The product ships five locales and every
neighbouring surface uses `translate.instant`. Highest value-per-line frontend fix on this
list: small, verifiable, and user-visible in four of five markets. New keys go in all five
locale files — **no gate validates i18n JSON**, so parse each one explicitly.

### F2 — the compute box is truthful NOW, without B1

Done by refusing the write (see P0), not by waiting for B1. `ACTIVE_BYO` is unreachable
because `computeMode` is only ever set from a write that succeeded, and that write answers
501. When B1 lands: remove the handler's refusal, re-enable the three `FormControl`s, enable
Save, and drop the `UNAVAILABLE` line. The copy was always correct; the backend was not.

### F3 / F4 — admin actions need sign-off, and are correctly absent

`GET /api/admin/machines` (fleet) and `GET /api/admin/sessions` are read-only **by
design**: arachnefly's `MachineOwnershipMiddleware` has no admin bypass, so an admin can
see another tenant's machine and cannot act on it. Reclaim moves a customer's idle
deadline, which suspends a live, still-billing machine — a destructive act on another
tenant's money.

Both the fleet's lifecycle actions and the sessions' reclaim therefore sit behind the
skill's "stop and ask" list. They stay unbuilt until someone with the authority says yes,
and the two routes to build them are (a) an admin route forwarding the **owner's** uid, or
(b) a bypass in the middleware — (a) is the smaller authorization change.

## Cross-cutting efficiency

See `references/performance-and-efficiency.md` in this skill. Summary of what is real:
`showSnackbar` is re-implemented as a private wrapper in ~16 components; the Tailwind
config's root-level `extract` is dead config carrying a loaded gun; and one commented-out
`getErrorMessage` should be deleted. The 447 kB stylesheet **transfers at 40 kB** and is
not a problem — do not open a task from raw size.

## Needs a human, not an engineer

| Decision | Why it is not engineering |
|---|---|
| §1.6 pricing amounts | A price is a business decision |
| B4 profiles storage shape | Commits to a per-tenant cost |
| F3/F4 admin actions | Destructive on another tenant's money; authorization change |
| Repin `BROWSER_MACHINE_IMAGE` | A secret write; the agent is forbidden from touching it |
| Any deploy | Out of scope by the skill's own rules |

## Order

1. **B1 + B2 together** — one commit, one gate run. This is the only P0.
2. **F1** — independent, safe, four markets improved.
3. **Efficiency items 1–4** from the performance reference — no sign-off needed.
4. **B3** — small, closes a documented-but-absent route.
5. **B4** — the largest remaining feature; needs the storage decision first.

Nothing above requires deployment, a pricing-shape change, or an engine fork.
