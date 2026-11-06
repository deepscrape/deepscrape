# 27 — Files and vendor-native tools: what we can exploit, and what we must refuse

Status: **plan; P1, P2, P3, P3b (replay), P4 (documents) and P5 (cache) applied.**
Written 2026-10-30. Branch `next`.

**P4 shipped (2026-10-31).** A PDF is the first attachment that is not an image with a different
name on the wire: Claude takes it as a `document` block, `media_type: application/pdf` is required
beside the bytes, and no other vendor we address has a part that means it. So the rule is the one
§3 already sets for every other vendor capability — it exists where the boundary holds and is
refused everywhere else, in the open rather than by half working.

Refused at the PICKER, not at the request. A PDF picked while a non-Claude model is selected
attaches nothing and says why; and if the model is switched afterwards, `filesInContent` drops it
for that provider instead of sending it as an `image_url`. A chip that vanishes from the user's own
turn is the silent failure this page has already been fixed for twice.

One cap for images and documents, still 1 MiB and still four files: the binding constraint is the
BFF's 8 MiB body (§1), which was sized for `4 x 1 MiB` of base64 — a second, larger cap for PDFs
would break that budget from the inside rather than from any vendor's ceiling.

What P4 does not do: **it does not count pages.** A 1 MiB PDF can be long, and Anthropic rejects
a request past 600 pages (100 under a 1M context) with a 400 the picker cannot predict. Counting
pages means parsing a PDF in the browser, which is a new dependency for a limit the vendor already
enforces with a clear error — so it is named here instead of guessed at in code.

**P5 shipped (2026-10-31).** The one lever §2 is quiet about, because it is not a file and not a
tool: every conversation is re-sent IN FULL on each tool round, and until now every one of those
rounds billed the whole prefix at full price. `withCacheBreakpoint` puts a single Anthropic
`cache_control` marker on the last content block of the turn, which caches the tool catalogue, the
system prompt and every earlier turn in one write; a cache read is billed at 0.1x. One marker, not
four, because a marker caches everything before it — and placed in `sendToClaudeAI` rather than in
`buildHistory`, because it is a property of the REQUEST, not of the transcript the user owns.

The same run fixed the number that would have made the saving invisible. `tokenUsage` promises
"what the vendor actually reports", but on the Claude path `prompt_tokens` was never assigned: the
reducer read the input side off its own accumulator, and `message_start` — the only event carrying
it — is emitted raw before the accumulator exists, after which every branch replaces it. So every
Claude turn showed `0 in`. The input side is now captured on `message_start` and folded in on
`message_delta`, which is the event that ENDS the round — deliberately, because the caller SUMS
each emission and a prompt reported on every `content_block_*` would be counted four or five times.
`cache_read_input_tokens` is carried under its own name; a cache WRITE is not counted as a saving,
because it is billed at 1.25x.

**P3 shipped as tokens, not money.** Each answer carries `in · out · cached` from the vendor's own
`usage`, accumulated across tool rounds and persisted with the transcript. No price: a rate needs a
per-model table this client does not own, and a wrong number is worse than none. Cache counts are
read from both spellings vendors use (`prompt_tokens_details.cached_tokens`, and DeepSeek's flat
`prompt_cache_hit_tokens`).

**P3b shipped as replay (2026-10-31).** The shortcut P2 left is closed. A turn's image is filed
ON the turn as `media: [{ key, mime, name }]` — a key and never a URL, for the reason §5 gives —
and `replayImages` mints one `presign` per stored object **per request**, before the conversation is
built. A turn sent in the current page still replays from the bytes already in memory, so the
ordinary follow-up costs no round trip; only a turn restored from `localStorage` needs the links.
`filesInContent` takes either carrier and emits `source: { type: 'url' }` for Claude and
`image_url` for the OpenAI family.

Bounded twice, deliberately. Only the newest four media entries are minted, and `IMAGE_MAX_BYTES`
is what each of them was already limited to at attach time, so a replayed set stays under 4 MiB.
The reason it needs a bound at all: every tool ROUND re-sends the conversation, so replaying a whole
gallery would multiply the vendor's fetch cost by the twelve-round budget.

A key that no longer resolves is **not** an error. The turn keeps its answer, its chip turns amber
and says `CHAT.ATTACH_EXPIRED`, and the request goes without that picture — which is the retention
window made visible instead of a request that fails or an image block with no source.

One edge P3b does not solve: **`retry()` still resends text only.** It drops the last user turn and
re-submits its text, so a regenerated image turn loses its picture. The fix is to keep the turn and
drop only the answer after it, which changes what `submit` means — a separate decision, not a
one-liner, and named here so it is not discovered as a bug.

**What P2 actually shipped (2026-10-30):** the composer uploads a picked image through
`saveBytes`, keeps its `data:` URL in memory, and sends it as message CONTENT — `image` block for
Claude, `image_url` for the OpenAI family, images before text. Capped at 1 MiB and four types. An
image on an EARLIER turn was not re-sent by P2; **P3b below closes that**, and every accepted
attachment keeps its storage key, which is what makes the 30-day window below meaningful.

Companion records: `26-chat-frontend-upgrade.md` (the composer this extends),
`17-mcp-capability-surface.md` (the tool boundary every vendor tool is measured against),
`ADR-2026-10-COPILOTKIT-CHAT.md` is deleted — do not cite it.

Answers two questions at once: *"send uploaded files to all vendors with the right limits"* and
*"use all tools of each vendor"*. The answer to the second is mostly no, and §3 says why in the same
terms the platform already uses for its own routes.

## 1. The binding limit is ours, not any vendor's

Every vendor we speak to accepts far more than we can send. The constraint is the BFF:

| Cap | Value | Where |
|---|---|---|
| request body | 8 MiB | `bff/server.ts` `maxRequestBodySize` |
| one stored artifact | 25 MiB | `functions/src/handlers/storage.ts` `MAX_ARTIFACT_BYTES` |
| instance memory | 512 Mi | Cloud Run service config |

Base64 inflates by 4/3, so an 8 MiB body carries at most ~6 MiB of file. `bff/server.ts` says so in
a comment: *"ponytail: raise it if a client ever posts base64 media through /api"*. That cap exists
because one unauthenticated POST to a public route is an OOM lever on a 512 Mi instance — so raising
it is a memory decision, not a line.

**Therefore: 4 MiB of decoded attachment bytes per request** (~5.4 MiB encoded, leaving ~2.6 MiB
for the prompt and history). That budget is the number every phase below is built on, and it is
under every vendor's own ceiling in §2.

## 2. Per-vendor file reality, sourced

| Vendor | Images | Formats | Where the numbers come from |
|---|---|---|---|
| Anthropic | 10 MB **base64** per image on the Claude API (5 MB on Bedrock/Vertex); 100 images/request at 200k context, 600 otherwise; >20 images drops the per-image dimension limit, so 3000 px or fewer keeps you safe | JPEG, PNG, GIF (first frame only), WebP | `platform.claude.com` Vision. Block: `{type:"image", source:{type:"base64"\|"url"\|"file"}}` |
| OpenAI-compatible | request up to 512 MB, 1500 images | PNG, JPEG, WebP, non-animated GIF | `developers.openai.com` Images and vision. Part: `{type:"image_url", image_url:{url}}` where url is a real URL **or** a `data:` URL |
| Gemini (compat endpoint) | inherits the OpenAI shape | same | `ai.google.dev/gemini-api/docs/openai` shows `image_url` with a base64 data URL verbatim |
| Groq, DeepSeek, Fireworks, Qwen, Kimi, OpenRouter, custom | **not verified per model.** Several of their flagship chat models are text-only | — | not researched |

Two consequences worth keeping:

- **Anthropic wants images BEFORE text.** Their guideline: an image-then-text structure performs
  best. Our user turns are prompt-first today, so Phase 2 must emit `[image…, text]`, not
  `[text, {type:"file"}]`.
- **`detail` is an OpenAI-family cost lever** (`low` / `high` / `original` / `auto`). Not sent in
  Phase 2; it belongs with the cost display in Phase 3, not with correctness.

## 3. Vendor-native tools: the gap table, with verdicts

Every row below is a capability the vendor offers that we do not use. The reason to refuse is the
same one `17-mcp-capability-surface.md` sets: a capability may only be added where the tool boundary
still holds — `resolveToolCall`, then a metered route, behind the SSRF guard.

| Vendor | Native tool | What it would replace | Verdict |
|---|---|---|---|
| Anthropic | web search, web fetch | our `search`, `scrape` | **Refuse.** Unmetered, unbounded, invisible to us. |
| Anthropic | code execution, computer use, bash, text editor | webrain + arachnefly | **Refuse.** Duplicates the machine we sell, outside the ownership guard. |
| OpenAI | web search, file search, code interpreter, image generation, computer use | Responses API only | **Refuse.** Chat Completions does not carry them at all, and moving to Responses is a third protocol for one vendor. |
| Gemini | Google Search grounding, Maps grounding, `url_context`, code execution | `serp`, `scrape` | **Refuse.** Grounding is a second search provider we cannot bill; `url_context` fetches URLs outside our guard. |
| Qwen | `enable_search` | `search` | **Refuse.** Same reason, plus it changes answer provenance silently. |
| Kimi | built-in `$web_search` tool | `search` | **Refuse.** |
| OpenRouter | `:online` model suffix | `search` | **Refuse.** Sold per result and billed through the model line, which our meter does not read. |
| Groq | built-in browser / code execution on some models | `scrape`, `run_command` | **Refuse.** |

The one vendor capability worth adopting is **vision input as a file**, and it is not a "tool" — it
is message content, which is exactly what Phase 2 adds. That keeps it inside the boundary: the
model gets bytes the user chose, and every side effect still goes through our tools.

## 4. What the composer does today, and why it cannot carry a file

`chatai.component.ts` reads every picked file with `File.text()` and folds it into the user turn as
a `<file name="…">` block. For text that is honest. For anything else it is worse than refusing:

- a binary decodes to replacement characters, and until this run those were **silently skipped** —
  the user drops a PNG and nothing happens, with no chip and no message. That is now a visible
  refusal (`CHAT.ATTACH_TEXT_ONLY`), which is the honest version of the same behaviour;
- even if it worked, the transcript lives in `localStorage` under a ~5 MB budget, so one inlined
  image would evict the entire conversation history;
- and `storageSavePayload` did `Buffer.from(content, "utf8")`, so the storage route could not take
  bytes either. It now accepts `contentBase64` as well, decoded by `decodePayload` in
  `functions/src/domain/storage-payload.domain.ts`.

## 5. Phases

**P1 — storage takes bytes (mostly applied).** `POST /api/storage/payload` accepts
`contentBase64` alongside `content`; the same ceiling, the same key derivation, the same
content-type rules. Client: `BucketStorageService.saveBytes`. This is the dependency for everything
below, and it is where P1 stops: uploading without sending is plumbing, not a feature.

**P2 — the composer sends files.** An attachment becomes a *reference* — `{name, mime, bytes, key}` —
never the bytes. At send time `attachmentParts(vendor, refs)` builds the vendor's parts, and the
transcript stores the reference so a reload re-resolves it. Enforced before the request: ≤4 MiB
decoded total, ≤4 files, image types only (JPEG/PNG/WebP/GIF), everything else refused with a
readable reason. Images emitted before the text, per §2.

### Retention: 30 days for attachments, and the number belongs to the bucket

Decided 2026-10-30, from the product requirement: an attachment has to survive roughly three to
four weeks of conversation, and a customer on their own storage decides otherwise.

- **Platform storage: 30 days.** A chat attachment older than that is expected to be gone.
- **BYOB: the customer's bucket rule wins.** We do not own the bucket and cannot enforce a lifetime
  inside it, so the UI must NOT render "expires in 12 days" from our own constant when
  `/api/storage/settings` reports `byob`. Showing a deadline we cannot keep is the same class of
  error as showing a price we do not charge.
- **Expiry is a UI state, not an error.** The transcript stores a KEY, so a reference that no longer
  resolves must degrade to "attachment expired" with no re-send attempt — never a broken image and
  never a failed turn. `objectUrl` answers 404 for a gone key, which is the signal to use.

**The thing that makes this more than a constant: nothing deletes a user payload today.** The
`cacheSeconds` on `blob-store.port.ts` is an HTTP `Cache-Control` — it tells a browser how long to
reuse the bytes and frees nothing. No code path removes a payload object, so an attachment without a
bucket lifecycle rule is immortal, which is exactly the defect `20-must-fix.md` item 74 names for
the SHARED tier. That item asks 7 versus 30 days for the shared cache; this section answers the USER
tier and must not be read as answering that one.

Consequence for P2: shipping attachments before a lifecycle rule exists would create unbounded
growth in a bucket we pay for, so the rule lands with the phase, not after it. **30 days** matches
the product requirement and is the number to configure.

**Thirty days is also why P2 must send a URL, not bytes.** Every turn replays the conversation, so an
inlined 4 MiB image is 4 MiB of input on turn 2 and on every turn after it — Anthropic's own note on
their Files API says exactly this ("the full image bytes are included in the payload on every turn").
Both vendors we have verified accept a URL source (`source.type: "url"` for Claude, `image_url` for
the OpenAI family), so P2 mints a `presign` per request and sends that. The transcript therefore
stores the KEY and never the URL: a presigned URL is a bearer credential with a 300-second life, and
storing one in `localStorage` would hand it to anything that can read the page.

**P3 — cost and truth.** Surface per-turn usage, including image tokens, which are invisible today:
`usage.prompt_tokens_details.cached_tokens` (OpenAI, Kimi, OpenRouter), `cache_read_input_tokens`
(Anthropic). Without it a user cannot tell a 4 MiB screenshot from a paragraph.

**P4 — documents (applied 2026-10-31).** Anthropic `document` blocks, which is how a PDF travels:
base64 for the turn being sent now, `source:{type:'url'}` for a replayed one, PDF before text the
same way images are. Not folded into P2 because it is a different block shape on one vendor only,
and a PDF that half-works is worse than a clear refusal — which is what the picker gives every
other vendor.

**P5 — cache the prefix, and stop reporting a zero (applied).** Two changes, both on the Claude
path, both invisible without the other: the breakpoint makes a repeated prefix cheap, and the usage
fix makes the saving observable. It is deliberately Claude-only: OpenAI and DeepSeek discount a
repeated prefix automatically and take no marker, and Gemini's implicit caching is documented but
not verified from here, so it is left alone rather than guessed at. History is not marked
separately either — one marker already covers the whole prefix.

What P5 does NOT change is the money path. The client still shows tokens and no price, for the
reason this file opens with: a rate needs a per-model table this client does not own. Whether the
server-side meter learns that a cache read costs 0.1x is a separate decision, in a different
service, and is not made here.

**P6 — JSON output, where the vendor documents the field (applied 2026-10-31).** `response_format:
{type:'json_object'}` for **OpenAI and DeepSeek only**, and the switch is not drawn for any other
vendor. Two entries in `JSON_VENDORS`, one per vendor whose own guide says so; adding one more is one
line, after reading that vendor's documentation — the same standard §2 holds every other claim to.

Three details that make it more than a flag:

- **The word "json" has to be in the prompt**, or both vendors refuse the field. It is appended to
  the SYSTEM prompt rather than the user's question, so the transcript still shows what the user
  typed.
- **The guard is on the wire, not on the switch.** `formatParams` re-checks the vendor, so turning
  JSON on and then switching to Claude or Groq sends nothing rather than a field that vendor would
   refuse.
- **A JSON answer can arrive blank.** DeepSeek replaces non-JSON text with spaces and still reports
  `stop`, so the turn can be empty with no error. That is the existing "no answer" path, not a new
  one — named here so it is not read as a bug.

**Still unpaid from P2: nothing DELETES an attachment.** The 30-day window is stated in §5 and is
now visible in the UI when an object is gone, but no lifecycle rule and no sweep removes one. That
is an operator decision (a Tigris lifecycle rule on the `userObjectKeyPrefix`) rather than client
code, and it has to land before P2-shaped traffic accumulates — `20-must-fix.md` #74 holds the
separate question of whether BYOB gets the same 7-vs-30-day split.

## 6. Gates

```
functions:   bun run build | bun run lint | bun run test
app:         bunx tsc --noEmit -p tsconfig.app.json | bun run build | bunx ng test --watch=false
bff:         bunx tsc --noEmit | bun test
i18n:        bun scripts/i18n-keys.ts
```

`bun run build` remains the only gate that compiles a template. A budget violation prints `ERROR`
and still writes output, so the exit code is the only evidence.

## What this does NOT claim

- It does not claim the other seven vendors can read an image. §2 marks them unverified, and Phase 2
  refuses a file for a vendor it has no row for rather than sending it and hoping.
- It does not claim the 4 MiB budget is permanent. It is what fits under an 8 MiB body on a 512 Mi
  instance; both numbers move together or neither does.
- It does not claim any vendor-native tool was evaluated against a live key. Every verdict above is
  from documentation plus the existing tool boundary, which is the same standard `17` used.
