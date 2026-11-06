# 26 — Chat frontend: build our own, in place

Status: **plan; P0, P1, P2, P3 (text) and P4 applied.** P2 payload is open.
Written 2026-10-30. Branch `next`.
Answers: *"is it better to build our own chat frontend, in a new Angular library?"*

Companion records: `docs/roadmap/15-chat-write-tools.md` (the write-tool approval seam),
`docs/roadmap/17-mcp-capability-surface.md` (the same `AI_TOOLS` array, second transport).

**Why no chat kit, in one paragraph:** `@copilotkit/angular@0.6.0` peers `@angular/core ^22.0.0`
(`@angular/cdk` too), and this repo is on 20. That, plus the fact that any kit would want to own the
tool loop — which here is `resolveToolCall(call, paid)` and the billing path — is why §1 concludes
"build our own, in place". The peer range is the only fact that would change that answer, so re-check
it before reconsidering a kit.

## 1. Recommendation: no library. Build our own, here.

**A new Angular library is not justified, and it is the wrong shape for the problem.**

| Claim | Evidence |
|---|---|
| There is one consumer. | `angular.json` declares exactly one project: `deepscrape`, `projectType: application`. A library with one consumer is a second build target, a second Karma target, a path mapping and a publish step, buying zero reuse. |
| The code is already split. | `/chatai` is a `loadComponent` lazy route in `src/app/routes/user/main.route.ts`, so the component is already in its own chunk. Getting it out of the initial bundle — the usual reason to reach for a library — is already done. |
| The three "sites" are one app. | Hosting serves three domains from one build (`.github/copilot-instructions.md`), not three apps. There is no second compilation to share with. |
| A library cannot own the hard part. | The valuable code is not view code: `resolveToolCall(call, paid)`, `requiresConfirm`, the tool loop, and the vendor/key resolution are app services with app DI. Extracting them means extracting the money path. |

Build our own **frontend**: yes — because a kit is blocked (Angular 22 peer) *and* because any kit
would want to own the tool loop, which here is the trust boundary and the billing path.

Build our own **backend**: **no change.** Ten vendor routes and one catalogue route already exist:

```
/api/anthropic  /api/openai  /api/groq  /api/deepseek  /api/fireworks
/api/qwen  /api/kimi  /api/openrouter  /api/gemini  /api/custom      → chatCompletionsCore / anthropicAICore
/api/models/:vendor                                                  → modelsCore
```

each behind `guard([paidOrByok(vendor), perm('ai','execute'), …])` plus `limitAfterAuth`. That *is*
the backend for a chat product. Nothing is missing from it that a UI phase needs.

## 2. What exists, so the plan is about gaps and not imagination

Verified in `chatai.component.{ts,html}` on 2026-10-30:

- per-token SSE streaming against `AiAPIService`; **Stop replaces Send** while in flight
- markdown rendering with a clipboard button and emoji, `ngx-markdown`
- model picker with a per-vendor live catalogue and an explicit warning for vendors whose catalogue
  came back empty
- tool chips showing the raw tool name and a measured size, never a paraphrase
- an approval panel that renders the **full arguments** of a parked write batch
- four failure kinds mapped to four different next actions, plus retry
- transcript persistence in `localStorage` (`TRANSCRIPT_KEY`, 40 turns), re-validated on restore
- `role="log"`, `aria-live="polite"`, `aria-relevant`, `aria-busy` — replies announce while streaming
- paid/free tool gating that states *why* a tool is withheld

That is more than most "advanced chat" demos ship. The gaps are narrower than they look.

## 3. Gap table versus an advanced chat, with a verdict each

| # | Gap | Verdict |
|---|---|---|
| 1 | **Scrolling lies.** The follow effect (`chatai.component.ts`, the `effect` that reads `messages()`) sets `scrollTop = scrollHeight` on every delta, unconditionally. Scrolling up to read an earlier answer gets yanked back on the next token. | **P0 — fixed today** |
| 2 | **No way back to the newest message** once you are scrolled up. | **P0 — fixed today** |
| 3 | **No conversations.** One transcript, 40 turns, one device. No list, titles, rename or delete. | **Shipped 2026-10-30** |
| 4 | **No message actions.** No regenerate, no edit-and-resend, no branch from an earlier turn. | **Copy + regenerate shipped 2026-10-30**; edit-and-resend and branch open |
| 5 | **A tool run was a measurement only.** `ToolRun{ name, summary }` kept no record of *which* call failed: a refusal and a route failure both rendered as the same cyan pill, so the amber `toolFailed` line named no call. **Status shipped 2026-10-30.** The payload is still not kept, by decision — see §3b. | **Status: shipped.** Payload: refused |
| 6 | **No sources.** `serp`/`search` return URLs that are flattened into `toolResultText` and lost as structure. | P2 — same storage question as #5 |
| 7 | **No attachments.** `POST /api/storage/payload` exists; the composer has no upload. | P3 |
| 8 | Composer is a fixed 2-row textarea; no auto-grow. | **Skipped.** It scrolls internally and works. `field-sizing: content` is not yet cross-browser. |
| 9 | No list virtualization. | **Deferred, deliberately.** The 40-turn cap hides it. Virtualizing before a thread can exceed the cap is optimisation for a state that cannot be reached. |
| 10 | No keyboard shortcuts beyond Enter / Shift+Enter. | **Deferred** until threads (P1) give a shortcut something to do. |

## 3b. What `browser-use/web-ui` contributes, measured 2026-10-30

Inspected: `src/webui/interface.py` (the tab layout), `browser_use_agent_tab.py` (the step
callbacks), `agent_settings_tab.py`, `browser_settings_tab.py`, `deep_research_agent_tab.py`.

Its tab set is: **Agent Settings**, **Browser Settings**, **Run Agent**, **Agent Marketplace →
Deep Research**, **Load & Save Config**. The Run Agent tab is a `gr.Chatbot` plus a live browser
`<img>`, a Stop/Pause/Clear row, and two run artefacts (an agent-history JSON and a recording GIF).

| Its idea | Where we stand | Verdict |
|---|---|---|
| **A transcript message per agent step**, carrying the step's screenshot and the model output JSON (`_handle_new_step`) | We show one chip per call: the tool name and its size. No payload. | **Refused, deliberately — see below.** We take the *status*, not the payload. |
| **A completion summary** — duration, total input tokens, final result, errors (`_handle_done`) | Partial: `toolFailed` and `stoppedAtLimit` surface, but not per call and not with timing | **P2** — see §3c |
| Live browser view inside the run | **Already have it.** `/api/browser/session/:id/frame`, `browser-frame.component.ts`, and the `/browser` lease list | Already shipped — do not rebuild |
| **Pause / Resume** mid-run | Not possible mid-round: a round is one `forkJoin` of route calls. Between rounds we already park writes behind an approval button | Refused. `requiresConfirm` is the seam a pause would have to invent |
| **`ask_for_assistant`** — the agent stops and asks the human | **Already have it**, and ours is stricter: the approval panel renders the full arguments before anything runs | Already shipped, and better |
| **Deep Research**: parallel agents, resume by task id, markdown report | We have a job system (`POST /api/job/tool`, QStash, the Operations page with run history) | Refused **inside the chat**. Two run surfaces that disagree about state is the drift `17` warns against |
| Agent-history JSON / recording GIF downloads | `POST /api/storage/payload` and the `write_file` tool already hand the user an artefact | Refused |
| Agent Settings tab (provider, model, max steps, tool-calling method) | Model picker exists; `MAX_TOOL_ROUNDS = 12` is a server-side constant by design | Refused — surfacing a spend knob in the chat is the `set_model` argument in `15` again |

**The headline feature is one we already refused, with a reason.** `summariseToolResult` in
`chatai.component.ts` returns a character count and says why:

> *"A preview of a scraped page is either useless or a leak into a transcript that gets persisted."*

That is correct and it stays. `browser-use/web-ui` puts the whole step payload into the chat
history because its history is a temporary file in `./tmp/agent_history`. Ours is `localStorage`
for 40 turns, and a scraped page can contain authenticated content or PII. Importing that feature
as-is would be a data-exposure change disguised as a UI improvement.

What is genuinely missing is smaller and leak-free: **the transcript cannot say which call failed.**
`execute()` folds a refusal and a route failure into ordinary result text
(`The tool "x" failed: …`), and `recordTools` then renders every call as the same cyan pill with a
character count. So a run where two of four tools were refused looks exactly like a run where all
four worked, and the single amber `toolFailed` line cannot say which one to act on.

## 3c. P2, restated from the research

Per-call status (`ok` / `refused` / `failed`) on the existing chip. No payload, no new route, no
retention decision. It is the part of browser-use's step log that we can take without taking the
leak, and it makes the amber `toolFailed` line answerable.

Still refused at P2: the payload itself. If a user needs to see what a route returned, the answer
is the run record or the stored artefact — the two places that already exist and already have a
deletion story — not a second copy in `localStorage`.

## 4. Backend decision: threads stay local until someone asks

Conversation history is the one gap that looks like it needs backend work, and it does not yet.

- **Now: `localStorage`, per browser.** Already built and validated on restore. Zero new routes, zero
  new Firestore collections, zero new deletion obligation.
- **Not now: server-side threads.** A second copy of the transcript in Firestore is a new obligation
  under `docs/roadmap/25-billing-subject-and-lifecycle.md`: it must be deleted with the account, it
  must survive an org-context switch, and it must not become a free unbounded store. None of that is
  decided, and building the routes before the decision creates the debt first.
- **If it happens, the shape is already established:** `GET`/`PUT /api/chat/threads` behind
  `jwt` + `perm('ai','execute')`, documents under `users/{uid}/chats/{id}` so the handler's own path
  is the tenant boundary — the pattern `GET /api/job/:taskId/result` already uses. No new guard
  primitive, no new permission.

## 5. The one real open question: what the chat is allowed to keep

Gaps #5 and #6 both need the same decision, so take it once: **how much of a tool's payload is
retained, and for how long?** `toolResultText` truncates at `TOOL_RESULT_LIMIT` and says
`… [truncated]`, which is honest to the model but leaves nothing to show the user.

Options, and the recommendation:

| Option | Cost | Verdict |
|---|---|---|
| ~~Keep the truncated text in the `ChatMessage`~~ | grew `localStorage`; the 40-turn cap bounded it | **Superseded by §3b, and refused.** "Bounded" was never the objection — the text can carry authenticated content or PII into persisted storage, which is the leak `summariseToolResult` already refuses |
| Persist full payloads to storage | new bucket objects per tool call; deletion semantics | Only when a user asks for it |
| Re-run the tool on demand | bills the user twice for one answer | **Refused** |

## 6. Theme mapping — light and dark, using tokens that already exist

Everything below is already in the template, so P0 adds no colour. The jump pill reuses the accent
chip recipe rather than introducing one.

| Role | Light | Dark | Note |
|---|---|---|---|
| Transcript surface | `bg-slate-50/30` | `bg-gray7/80` | |
| Transcript border | `border-gray2` | `border-gray5` | |
| Assistant bubble | `bg-white` | `bg-gray6` | `text-gray6` / `dark:text-gray2` |
| User bubble | `bg-cyan-700` | same | white on `cyan-700` is **5.56:1**; `cyan-600` is 3.77:1 and fails AA. Do not "brighten" it. |
| Accent chip | `bg-cyan-700/10 text-cyan-800` | `bg-cyan-400/10 text-cyan-300` | tool chips, running chip, jump pill |
| Danger | `border-rose-500/40 text-rose-700` | `dark:text-rose-300` | failure panel |
| Warning line | `text-amber-700` | `dark:text-amber-300` | budget and vendor notices |

Rules from `.github/skills/deepscrape-theme-template-skill/SKILL.md` that apply: Tailwind first for
spacing and layout, no new UI framework, no hard-coded palette, `darkMode: 'class'` (so `dark:`
variants are the whole mechanism — never a JS colour read).

## 7. Phases

**P0 — scroll truth (applied 2026-10-30).** A pure `isAtBottom` helper, an `atBottom` signal driven
by the real scroll event, the follow effect gated on it, and a jump-to-latest pill. One new i18n key
(`CHAT.JUMP_LATEST`) in five locales. No backend, no new dependency, no money path.

**P1 — conversations (shipped 2026-10-30).** A session menu in the top bar: newest first, title from
the first USER turn (collapsed to one line, capped at 60), open, delete, and the existing "New chat"
as the add button. `localStorage` only, 20 conversations, 40 turns each, under a new
`deepscrape.chat.sessions.v1` key; the old single-transcript key is adopted once on first load and
never written again. "New chat" now PERSISTS before clearing, so starting a conversation no longer
destroys the previous one — that is the whole difference from the single transcript it replaced.
Still open: rename, and branch/edit-last-turn, which need the transcript addressable in ways the
list alone does not give.

A defect found while surfacing the round counter: the per-turn resets (`rounds`, `stoppedAtLimit`,
`toolFailed`) lived in `send()`, which `retry()` does not go through — so a retry after a turn that
spent all twelve rounds returned immediately, ceiling already tripped, with no answer at all, and the
two amber notices survived into the next turn. Moved to `submit()`, the one path both callers take.
`retry()` already IS the regenerate mechanism; it is only reachable from the failure panel today.

**P2 — per-call status (shipped 2026-10-30), then sources.** `ToolRun` gained
`ok | refused | failed`, so a refused call is muted, a dead route is rose, and the amber failure
line finally names something. Stored transcripts written before the field normalise to `ok` on
restore. Still open: `serp`/`search` URLs as links, and the payload itself, which §3b refuses.

**P3 — attachments (text, 2026-10-30).** The composer reads picked files with `File.text()` and
folds them into the user turn as `<file name="…">` blocks, capped at 12,000 characters and four
files. Tag-delimited rather than fenced: a file containing ``` would close a fence and turn the rest
of the prompt into prose. A binary file decodes to replacement characters and is skipped, not
clipped — twelve thousand of them is a prompt that costs money and says nothing.

This is deliberately NOT `POST /api/storage/payload`. That route stores an object and returns a key;
nothing in the chat can read a key back into a prompt, so using it here would have produced an
attachment that reached storage and never reached the model. It stays the upgrade path for the two
cases this cannot serve: files too large to inline, and a transcript that keeps attachments as
addressable objects instead of folding them into the message text.

**P4 — composer and rail (applied 2026-10-30).** The controls that decide a request moved out of the
top bar and beside Send, into one row inside the input: attach/plugins, mode, model, effort, tools,
send. Each is a 36px icon button with its value beside it from `sm` up, so the row reads as
`Agent · deepseek-chat · default · 14` on a desktop and as icons on a phone.

| Control | What it actually does |
|---|---|
| Mode (Ask / Plan / Agent) | `toolsForMode` narrows the offer list: Ask offers nothing, Plan drops everything with `requiresConfirm`, Agent is the old behaviour and the default. |
| Model | The same `models()`/`modelAI` the house `app-dropdown` bound, re-rendered as a menu because that picker paints a floating label above its trigger, onto the textarea. |
| Thinking effort | `reasoningParams(vendor, model, effort)` — DeepSeek `off` sends `thinking:{type:'disabled'}`; OpenAI o-series and gpt-5 take `reasoning_effort`; every other combination sends nothing. |
| Tools | Checkboxes over the tier's list. What the user unchecks is REFUSED, not merely hidden. |

Three rules this phase had to keep:

1. **A mode may only narrow.** `resolveToolCall` is still the trust boundary, but a model can name a
   tool it was never offered, so `execute()` gained a second check: a `requiresConfirm` tool in
   non-agent mode is refused as text the model can read. Offering less without refusing is theatre.
2. **Unchecked means refused.** `sessionTools` is the array `stream()` passes, so the offer list, the
   panel's count, and the request cannot disagree.
3. **The rail is page state.** It sits beside the app's own nav inside `/chatai`, inline at `lg` and
   an overlay below it (a rail that stays inline on a phone squeezes the conversation), 300ms
   width transition, the repo's `.scrollbar`, and it renders 12 conversations then grows on scroll.

Also removed: `DropdownComponent` and `FormControlPipe` are no longer imported by this component.

Two things this phase did NOT do, and why: **no per-tool schema validation** (that is vendor `strict`
mode, and our schemas do not yet set `additionalProperties: false` and mark every property required),
and **no reasoning display** — the effort switch exists partly because DeepSeek requires
`reasoning_content` to be replayed on every tool round while this client carries none, so turning it
OFF is the fix that costs nothing. Surfacing the reasoning to the user is a separate phase that has
to decide retention first (§5).

## 8. Gates for every phase

```
app:  bunx tsc --noEmit -p tsconfig.app.json   # 0
      bun run build                            # 0 — the ONLY template and SSR gate
      bunx ng test --watch=false --browsers=ChromeHeadless
i18n: every locale parses (ConvertFrom-Json) and the key exists in all five
```

`tsc` does not parse a template and Karma only compiles components a spec imports, so a template
error in P0 would pass both and surface only in `bun run build`. A budget violation prints `ERROR`
and still writes output — **only the exit code is evidence.**

## What this does NOT claim

- It does not claim the current chat is finished. §3 is a real list of ten gaps.
- It does not claim a library would never make sense — it claims one is wrong with **one** project and
  **one** build. A second Angular app would change the answer.
- It does not touch the write-tool seam, the approval panel, or any vendor route.
- It gives no date for P1–P3.
