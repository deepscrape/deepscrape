# Performance & efficiency — measured findings and the compression work

This file exists so the numbers and the traps live in ONE place. It is deliberately
short on theory and long on measurements, because every claim here was either
observed in a build log or read in source, and the point of writing it down is to
stop the next pass re-deriving it.

## 0. The rule that orders everything else: raw size is not the metric

The production build reports two columns. Only the second one is a user cost.

| Asset | Raw | **Transfer** |
|---|---|---|
| `styles-*.css` | 447.57 kB | **40.38 kB** |
| `chunk-GTAREXNQ.js` | 814.62 kB | **163.10 kB** |
| `chunk-NLYNAS5W.js` | 285.73 kB | 58.09 kB |
| `chunk-D3QDXU57.js` | 215.36 kB | 63.55 kB |
| `chunk-B5CLEONN.js` | 160.88 kB | 41.98 kB |
| **Initial total** | **2.16 MB** | **433.16 kB** |

Measured on the `production` configuration, 2026-10-16. A 447 kB stylesheet that
compresses to 40 kB is **not** a bug, and "reduce the CSS to 200 kB raw" would buy
the customer nothing. Do not open a performance task from the raw column.

What WOULD matter, in order: the 433 kB initial transfer, the 163 kB chunk, and the
number of chunks (69 browser + 155 server lazy chunks) — that last one is a request
count and a cache-churn question, not a byte question.

## 1. `tailwind.config.js` — a dead `extract` and a build-time `console.log`

**Verified.** The config defines `extract` at the ROOT of the exported object:

```js
module.exports = withMT({
  enabled: true,
  content: ["./src/**/*.{html,ts}"],
  extract: { md: (content) => { /* ... */ } },
})
```

Two problems, and the second is the one worth acting on:

1. In Tailwind v3 `extract` is a member of the `content` configuration
   (`content: { files: [...], extract: {...} }`), not a sibling of it. As written it
   is **ignored** — dead config that reads as load-bearing.
2. The function's stated intent is *"Capture as liberally as possible"*, and it does:
   `content.match(/[^<>"'`\s]*[^<>"'`\s:]/g)` returns essentially every whitespace-
   delimited token in the file. If anyone ever "fixes" this by moving it under
   `content`, every word in every `.ts` and `.html` file becomes a Tailwind class
   candidate, purge stops working, and the stylesheet grows without bound. It is a
   loaded gun that currently points at nothing.

It also calls `console.log` on every build, which is noise in a CI log.

**Action:** delete the `extract` block. If dynamic class construction is ever genuinely
needed, express it as a narrow `safelist` with a comment naming the file that builds
the class — never as a broad extractor.

**Related, unverified:** `theme.colors` replaces the default palette with **11 full
Tailwind palettes** (`blue, green, pink, purple, orange, red, yellow, brown, cyan,
gray, dark`). That enlarges the *available* utility surface enormously, but Tailwind
only emits what it finds, so it is only a real cost if a safelist or a string-built
class name exists. Measure before changing it; the fix would be narrowing to the
shades actually used, which is a large diff for an unproven gain.

## 2. `showSnackbar` is re-implemented as a private wrapper in ~16 components

**Verified by grep.** A shared `core/services/snackbar.service.ts` already exists and
several callers use it correctly. But many components declare their OWN
`showSnackbar` that does nothing except forward to it with different defaults:

| File | Shape |
|---|---|
| `pages/service/login/login.component.ts:247` | `private showSnackbar(...)` → `this.snackbarService.showSnackbar(...)` |
| `pages/user/settings/security/security.component.ts` | own `showSnackbar` + own `getMfaErrorMessage` |
| `pages/user/crawl-pack/machines/machines.component.ts` | 13 call sites |
| `operations`, `settings/profile`, `workspace`, `verification`, `signup`, `crawlerpack`, `crawl-config`, `crawl-results`, `browser-config`, `domain-seeder`, `app-crawl`, `app-llm-scrape` | same pattern |

228 matches of `showSnackbar|getErrorMessage|getMfaErrorMessage` across 24 files.

**Why this is worth compressing, beyond line count:** each local wrapper is a separate
place where the default duration, the `SnackBarType`, and the empty `action` string are
decided. Today they disagree — `5000`, `4500`, `3000`, `2500`, `6000`, `7000` all appear
— so the same class of message behaves differently on two pages, and no single edit can
change that. That is a consistency defect wearing a duplication costume.

**Action, smallest correct diff:** add the defaulted overload to the shared service
(named parameters or a `notify`-style helper) and delete the local wrappers one file per
commit, so a reviewer can see each page's behaviour is unchanged. Do NOT do this as one
sweep: `security.component.ts` is 1400+ lines and mixing its snackbar refactor with its
MFA logic is how a regression hides.

**`getErrorMessage` is already shared** (`core/functions/firestore.fun.ts:8`) and is used
correctly across `action-handler`, `resetpassword`, `signup`, `verification`, `security`.
Leave it. `getMfaErrorMessage` is a genuine specialisation, not a duplicate.

**Dead code found alongside:** `pages/service/resetpassword/resetpassword.component.ts:87`
carries a commented-out `private getErrorMessage(error: any): string {`. Delete it.

## 3. `machines.component.ts` emits untranslated English — a correctness bug, not a style one

**Verified.** 13 snackbar calls build user-facing sentences in the template literal
itself:

```ts
this.showSnackbar(`Machine ${machine.id} starting`, SnackBarType.info)
this.showSnackbar(`Machine ${machine.id} suspended`, SnackBarType.success)
this.showSnackbar(`Machine ${machine.id} stopping failed`, SnackBarType.error)
```

The product ships in **five locales** (en, el, de, es, fr) and every neighbouring surface
uses `this.translate.instant('…')` — `security.component.ts` does it at all 40+ of its
call sites. So this is a leak in an otherwise complete i18n story, and it is the kind of
gap that is invisible in an English browser.

This is the highest-value **frontend** fix on this list because it is small, verifiable,
and user-visible in four of five markets.

## 4. Two circular `CALLS` dependencies

The graph reports exactly two cycles in 3,056 scanned call edges:

1. `BrowserComponent.safePlayVideo` ↔ `BrowserComponent.setupVideoHealthCheck`
2. `s3-blob-store.clientFor` ↔ `s3-blob-store.get`

Both are two-node and inside a single file, so neither is an architectural knot — they are
local recursion/helpers that happen to call each other. Low priority, but the fact that the
count is **2** rather than 20 is a good sign and worth keeping at 2.

## 5. A trap: the hotspot list is not trustworthy as written

The `hotspots` aspect reported `AiKeysService.describe` with **fan-in 234** — by far the
highest number in the graph. It is almost certainly an **artifact**: `describe` is the
test-framework global, and this repo has ~211 spec files, so the name collides. Likewise
`browser-sessions.internal` (fan-in 94) is a local helper whose name collides with nothing
in particular but which is scoped to one module.

**Do not open a task from a hotspot row without reading the source.** The genuinely
interesting entries in that list are the `FirestoreService.*` methods (fan-in 23–34),
which are a real shared surface, and `bff/bridge.finalize` (17), which is the BFF's
response path.

## 6. Compression work list, ordered

| # | Work | Kind | Risk | Sign-off |
|---|---|---|---|---|
| 1 | Untranslate → translate `machines.component.ts` snackbars | correctness | low | none |
| 2 | ~~Delete the dead root `extract` + its `console.log`~~ **DONE** | cleanup | low | none |
| 3 | ~~Delete the commented-out `getErrorMessage` in `resetpassword`~~ **DONE** | cleanup | low | none |
| 4 | Move `showSnackbar` defaults into the shared service, then delete wrappers one file per commit | dedup | medium | none |
| 5 | Narrow `theme.colors` palettes to shades in use | size | medium | **measure first** |
| 6 | Investigate the 224 lazy chunks (request count, not bytes) | perf | low | none |
| 7 | ~~Extract `uidOf` + `errorLabel` to `handlers/request-helpers.ts`~~ **DONE** (12 copies → 1 each) | dedup + security | low | none |
| 8 | Decide the `bodyOf` / `fail` contract, then unify — **behaviour change** | correctness | medium | **decide first** |

Item 5 must not start without a measurement showing a transfer-size or build-time win,
because the diff is large and the current stylesheet transfers at 40 kB. Item 8 is last on
purpose: `bodyOf` returns raw `unknown` in one file and a normalised `{}` in two others, so
picking a winner is a decision, not a refactor. See §7 for the full inventory.

### Item 2, and the measurement that closed it

The claim was that the root-level `extract` was dead config. It is now **measured**: with the
block removed the build produces `styles-XEU4W6QR.css` at the *same hash* and the same
**447.57 kB / 40.38 kB**, with an unchanged 2.16 MB / 433.16 kB initial total. Byte-identical
output from a config edit is proof the block was never read.

**The first attempt at that "proof" was worthless, and how it failed is the more useful
lesson.** The edit tool reported success while the file on disk was unchanged — `extract: {`
was still at line 15 and `git diff` showed no changes at all. The build then produced the same
hash, and that looked like confirmation. It was nothing of the sort: nothing had changed, so
nothing could change.

Two things caught it, and neither was the edit tool:

- `git diff --stat` showed zero changes, so the removal had never landed;
- the `git add` + `git commit` for that file refused with **exit 1** — "nothing to commit".

So: **a tool's success message is not evidence that bytes changed.** For any claim of the form
"removing X changed nothing", prove the removal landed with `git diff` *first*, then compare
the artefact. An unchanged output means something only when the input has provably changed.
This is the same class as the trap in §8 about a green exit code proving nothing when the
thing you asked it to measure was never actually run.

### Item 7, and how it was landed safely

Twelve definitions collapsed to one in `functions/src/handlers/request-helpers.ts`: `uidOf`
from eight files, `errorLabel` from four. Gates: functions `tsc` 0, eslint 0 across all ten
touched files, functions suite 0 failures, BFF `tsc` 0, BFF 74/74.

Two details that made it safe rather than lucky:

- The imports were added to all nine files in **one block** and the local definitions
  deleted in a **second** block. Between the two the code does not compile (duplicate
  identifier), which is fine — the point is that no block ever contains two edits to the
  same file.
- `storage.ts` imports express as `{Request, Response}` with **no spaces**, unlike the other
  eight. A guessed anchor would have failed there. One grep for the exact import line was
  cheaper than nine file reads and removed the guesswork.

## 7. The duplicated handler-helper family — `uidOf` is the smallest example

**Verified by grep over `functions/src/**`.** This is the largest measurable duplication in
the backend, and three of the copies have already **diverged**, which is why it is a
correctness item rather than a tidy-up.

| Helper | Copies | Locations |
|---|---|---|
| `uidOf(req)` | **8** | `billing-policy:54`, `browser-sessions:110`, `compute:45`, `egress:41`, `machine-fleet:86`, `monitors:64`, `storage:82`, `vault:169` |
| `errorLabel(error)` | **4** | `compute:55`, `egress:51`, `storage:114`, `webrain-config:48` |
| `internal(res, what, error)` | **4** | `browser-sessions:132`, `machine-fleet:48`, `monitors:74`, `session-fleet:53` |
| `bodyOf(req)` | **3** | `browser-sessions:103`, `monitors:53`, `storage:91` |
| `fail(res, status, …)` | **2** | `storage:104`, `vault:180` |

The 401 body — `{error: "unauthorized", code: "unauthorized"}` — is written out **20 times
across 7 files** (plus 8 more in `syncaiapi.ts`, the library whose route table is never
mounted, so those are inert).

### Three are already divergent, not merely duplicated

1. **`bodyOf` has two different contracts under one name.**
   - `browser-sessions.ts:103` — `(req: Request): unknown => req.body` — raw, **no normalisation**
   - `monitors.ts:53` and `storage.ts:91` — `(req): Record<string, unknown>` — normalise absent/null to `{}`

   So `bodyOf(req).someField` compiles and runs in two files and throws in the third. The
   name promises the same guarantee in all three.

2. **`fail` takes two different parameter names and shapes** — `storage.ts:104` takes
   `code: string` and writes `{error: code, code}`; `vault.ts:180` takes `error: string`.

3. **`uidOf` has two spellings of one rule** — `uid.length` (`monitors`, `browser-sessions`)
   versus `uid.length > 0` (`storage`, `egress`, `compute`). Identical semantics today; the
   point is that nothing keeps them identical tomorrow.

### Why this is a security item

`errorLabel`'s docblock states the invariant: *"never its message: a message can quote a
resource path, and the path of a Secret Manager secret is the one field a credential could
ride in."* That rule is written out in **four** files. The day someone adds `error.message`
to one copy while debugging, the other three keep the safe behaviour and **no gate catches
it** — `tsc` cannot see it, lint has no rule for it, and the test suite does not assert log
content.

`uidOf` has the same shape as a security surface: eight independent definitions of "what
does authenticated mean". If one drops the `typeof` check, that handler's auth semantics
diverge from the other seven and every gate stays green.

### Work list

1. Add `functions/src/handlers/request-helpers.ts` exporting `uidOf` and `errorLabel`.
   Both are provably identical in behaviour today, so this part is mechanical.
2. Convert the 8 + 4 call sites, **one file per commit**. Each file needs two edits (the
   import block and the local definition) and several run past 900 lines; a single sweep is
   how a regression hides. `security.component.ts` in the frontend is the same lesson.
3. **Do NOT fold `bodyOf`, `fail` or `internal` into the same pass.** `bodyOf` and `fail`
   are divergent, so unifying them **changes behaviour** and needs a decision on which
   contract wins. Start with `bodyOf`, because normalising to `{}` is the safer of the two,
   then make `browser-sessions` match — after reading its callers.

**Not implemented, and the reason:** nine files × two edits is eighteen edits, and the
divergent pair needs a decision before the mechanical work is even safe to finish. Recorded
here so the next pass starts from this inventory instead of re-grepping.

**One near-miss to avoid:** `gfunctions/user-settings.ts:70` defines `requireUid` for the
CALLABLE request shape (`{auth?: {uid?: string}}`), which is a genuinely different type from
an Express `Request`. Leave it separate — merging two request shapes would be a false
economy that trades a real type distinction for a shorter file.

## 8. Rules to keep

- Quote **transfer** size when reporting performance. Raw size misled this file's first
  draft into calling a 447 kB stylesheet a problem; it is not.
- `bun run build` is the only gate that measures any of this. `tsc` and Karma cannot.
- A gate that reports success while the artefact is oversized is not measuring; Angular
  budget violations print `✘ [ERROR]` and **still write the artefact**, so the presence of
  `Output location:` is not evidence of success — only the exit code is.
- Deduplication and performance are different tasks. Removing 16 copies of a wrapper makes
  the codebase smaller and the bundle *marginally* smaller; do not claim a perf win for it.
